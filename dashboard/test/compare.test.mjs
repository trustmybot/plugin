// Insights Compare test (GH 2069): unit-test parseSlice's accepted and rejected
// periods against hand-computed bounds; then seed a temp trajectory DB from
// schema.sql with tasks 1–5, swe and code-reviewer runs on tasks 1–2 about 45
// days ago and on tasks 3–5 in the last two days, three bro sessions, review
// verdicts, verification runs and closed tasks. Check GET
// /api/insights/compare over HTTP (task slices, bro exclusion, shared buckets,
// the 400s, bound parameters) and compare() / insights() directly: per-task
// totals priced and unpriced, shared runs on overlapping periods, quality and
// throughput under task slices, and options.max_task_id.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const DASH = new URL('..', import.meta.url).pathname;
const SCHEMA = join(DASH, '../mcp/trajectory-server/src/schema.sql');
const SERVER = join(DASH, 'dist/server.mjs');
const NOW = new Date();
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const dayOf = (ms) => ago(ms).slice(0, 10);
const OPUS = { input: 15, output: 75, cache_read: 1.5, cache_creation: 18.75 };
const PRICES = JSON.stringify({ 'claude-opus': OPUS });

const RUNS = [
  { task: 1, agent: 'swe', in: 100, out: 1000, cr: 900, cc: 0, at: 45 * DAY },
  { task: 1, agent: 'swe', in: 100, out: 3000, cr: 900, cc: 0, at: 45 * DAY - HOUR },
  { task: 2, agent: 'code-reviewer', in: 500, out: 500, cr: 1500, cc: 0, at: 44 * DAY, model: 'claude-sonnet' },
  { task: 2, agent: 'swe', in: 200, out: 2000, cr: 600, cc: 200, at: 44 * DAY },
  { task: 3, agent: 'swe', in: 1000, out: 6000, cr: 3000, cc: 1000, at: 2 * DAY },
  { task: 3, agent: 'swe', in: 1, out: 999_999, cr: 1, cc: 1, at: 2 * DAY, source: 'unmeasured' },
  { task: 3, agent: 'code-reviewer', in: 1000, out: 1000, cr: 1000, cc: 0, at: 2 * DAY, model: 'claude-sonnet' },
  { task: 4, agent: 'swe', in: 1000, out: 4000, cr: 2000, cc: 0, at: DAY },
  { task: 5, agent: 'swe', in: 500, out: 2000, cr: 1500, cc: 0, at: HOUR },
  { task: null, agent: 'bro', in: 1000, out: 90_000, cr: 400_000, cc: 20_000, at: 45 * DAY, source: 'transcript' },
  { task: null, agent: 'bro', in: 800, out: 40_000, cr: 200_000, cc: 9000, at: DAY, source: 'transcript' },
  { task: null, agent: 'bro', in: 300, out: 10_000, cr: 50_000, cc: 2000, at: 2 * HOUR, source: 'transcript' },
];
const CLOSED_AT = { 1: 44 * DAY, 2: 43 * DAY, 3: DAY };

function seed(path, prices = '{}') {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  db.prepare(`UPDATE plugin_config SET value_json = ? WHERE key = 'model_prices'`).run(prices);
  const now = NOW.toISOString();
  const issue = Number(db.prepare('INSERT INTO issues (objective, created_at, updated_at) VALUES (?, ?, ?)').run('Compare issue', now, now).lastInsertRowid);
  const task = db.prepare(
    "INSERT INTO tasks (id, issue_id, branch_id, title, description, status, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'd', ?, ?, ?, ?)",
  );
  for (const id of [1, 2, 3, 4, 5]) {
    const closed = CLOSED_AT[id];
    task.run(id, issue, `feat/t${id}`, `Task ${id}`, closed === undefined ? 'running' : 'closed', closed === undefined ? null : ago(closed), now, now);
  }
  const run = db.prepare(
    `INSERT INTO agent_runs (task_id, agent_type, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens,
       tool_uses, duration_ms, started_at, completed_at, usage_source, model)
     VALUES (?, ?, ?, ?, ?, ?, 3, 60000, ?, ?, ?, ?)`,
  );
  for (const r of RUNS) run.run(r.task, r.agent, r.in, r.out, r.cr, r.cc, ago(r.at), ago(r.at), r.source ?? 'subagent_stop', r.model ?? 'claude-opus');
  const attempt = db.prepare("INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, created_at) VALUES (?, ?, 'code-reviewer', ?, 1, ?)");
  attempt.run(1, 1, 'pass', ago(44 * DAY));
  attempt.run(2, 1, 'fail', ago(44 * DAY));
  attempt.run(2, 2, 'pass', ago(43 * DAY));
  attempt.run(3, 1, 'pass', ago(DAY));
  attempt.run(4, 1, 'fail', ago(HOUR));
  const vrun = db.prepare("INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s) VALUES (?, 'abc1234', 'gate', ?, ?, ?, 600)");
  vrun.run(1, ago(44 * DAY), ago(44 * DAY), 0);
  vrun.run(3, ago(DAY), ago(DAY), 1);
  vrun.run(4, ago(HOUR), ago(HOUR), 0);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return db;
}

function startServer(dbPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, TRAJECTORY_DB_PATH: dbPath, TMB_DASHBOARD_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (chunk) => {
      out += chunk;
      const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(out)?.[0];
      if (url) resolve({ url, stop: () => new Promise((done) => (child.once('exit', done), child.kill())) });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
}

let mod;
before(async () => {
  const out = await build({
    stdin: {
      contents: `export { parseSlice, compare, compareQuery, insights, insightFilter, VERSION_PERIODS_ERROR } from './server/queries.ts';`,
      resolveDir: DASH,
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(SERVER)});` },
    write: false,
    logLevel: 'silent',
  });
  mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
});

const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tmb-dashboard-compare-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const agent = (body, name) => body.agents.find((a) => a.agent === name);
const METRICS = ['tokens_out', 'context', 'cache_hit', 'tool_uses'];

function assertSharedBuckets(body) {
  assert.ok(agent(body.p1, 'swe').histograms.tokens_out.length > 1);
  for (const name of ['swe', 'code-reviewer', 'bro']) {
    for (const m of METRICS) {
      const bounds = (p) => agent(body[p], name).histograms[m].map((b) => [b.from, b.to]);
      assert.deepEqual(bounds('p1'), bounds('p2'), `${name} ${m}`);
    }
  }
}

describe('parseSlice', () => {
  const now = new Date('2026-10-26T12:00:00.000Z');
  const parse = (s) => mod.parseSlice(s, now);
  const slice = (key, kind, since, until, from_task = null, to_task = null) => ({ key, kind, since, until, from_task, to_task });
  const until = now.toISOString();

  test('SC1: presets and previous windows bound [now − d, now] and [now − 2d, now − d)', () => {
    assert.deepEqual(parse('7d'), slice('7d', 'range', '2026-10-19T12:00:00.000Z', until));
    assert.deepEqual(parse('30d'), slice('30d', 'range', '2026-09-26T12:00:00.000Z', until));
    assert.deepEqual(parse('90d'), slice('90d', 'range', '2026-07-28T12:00:00.000Z', until));
    assert.deepEqual(parse('all'), slice('all', 'range', null, until));
    assert.deepEqual(parse('prev7d'), slice('prev7d', 'prev', '2026-10-12T12:00:00.000Z', '2026-10-19T12:00:00.000Z'));
    assert.deepEqual(parse('prev30d'), slice('prev30d', 'prev', '2026-08-27T12:00:00.000Z', '2026-09-26T12:00:00.000Z'));
    assert.deepEqual(parse('prev90d'), slice('prev90d', 'prev', '2026-04-29T12:00:00.000Z', '2026-07-28T12:00:00.000Z'));
  });

  test('SC1: date ranges are inclusive UTC days with optional ends', () => {
    assert.deepEqual(parse('dates:2026-10-01..2026-10-15'), slice('dates:2026-10-01..2026-10-15', 'dates', '2026-10-01T00:00:00.000Z', '2026-10-16T00:00:00.000Z'));
    assert.deepEqual(parse('dates:..2026-10-15'), slice('dates:..2026-10-15', 'dates', null, '2026-10-16T00:00:00.000Z'));
    assert.deepEqual(parse('dates:2026-10-15..'), slice('dates:2026-10-15..', 'dates', '2026-10-15T00:00:00.000Z', null));
    assert.deepEqual(parse('dates:2026-10-15..2026-10-15'), slice('dates:2026-10-15..2026-10-15', 'dates', '2026-10-15T00:00:00.000Z', '2026-10-16T00:00:00.000Z'));
  });

  test('SC1: task ranges default an empty start to 1 and an empty end to open', () => {
    assert.deepEqual(parse('tasks:100-200'), slice('tasks:100-200', 'tasks', null, null, 100, 200));
    assert.deepEqual(parse('tasks:201-'), slice('tasks:201-', 'tasks', null, null, 201, null));
    assert.deepEqual(parse('tasks:-99'), slice('tasks:-99', 'tasks', null, null, 1, 99));
    assert.deepEqual(parse('tasks:-'), slice('tasks:-', 'tasks', null, null, 1, null));
  });

  test('SC1: malformed, reversed, impossible and reserved periods are errors', () => {
    for (const s of ['tasks:200-100', 'tasks:0-5', 'tasks:1.5-', 'tasks:-0', 'tasks:a-b', 'dates:2026-02-30..', 'dates:2026-10-15..2026-10-01', 'dates:2026-1-01..', 'ver:1.2.0', 'bogus', '', '1y', 'prev1y']) {
      const r = parse(s);
      assert.ok('error' in r, `${JSON.stringify(s)} should be rejected`);
      assert.equal(typeof r.error, 'string');
    }
    assert.equal(parse('ver:1.2.0').error, mod.VERSION_PERIODS_ERROR);
    assert.equal(mod.VERSION_PERIODS_ERROR, 'version periods are not supported yet');
  });
});

describe('GET /api/insights/compare', () => {
  const dbPath = join(tmp, 'http.db');
  seed(dbPath).close();
  let server;
  before(async () => {
    server = await startServer(dbPath);
  });
  after(async () => {
    await server?.stop();
  });
  const get = async (query) => {
    const res = await fetch(`${server.url}api/insights/compare?${query}`);
    return { status: res.status, body: await res.json() };
  };

  test('SC2: two task ranges exclude bro and share every bucket edge', async () => {
    const { status, body } = await get('p1=tasks:1-2&p2=tasks:3-');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['bro_excluded', 'options', 'p1', 'p2', 'shared_runs']);
    assert.equal(body.p1.slice.kind, 'tasks');
    assert.deepEqual(body.p1.slice, { key: 'tasks:1-2', kind: 'tasks', since: null, until: null, from_task: 1, to_task: 2 });
    assert.deepEqual(body.p2.slice, { key: 'tasks:3-', kind: 'tasks', since: null, until: null, from_task: 3, to_task: null });
    assert.deepEqual(body.p1.range, { key: 'tasks:1-2', since: null, until: null });
    assert.equal(body.bro_excluded, true);
    assert.equal(body.shared_runs, 0);
    assert.equal(agent(body.p1, 'swe').n, 3);
    assert.equal(agent(body.p2, 'swe').n, 3);
    assert.equal(agent(body.p2, 'swe').total, 4);
    for (const p of ['p1', 'p2']) {
      assert.equal(agent(body[p], 'bro').n, 0);
      assert.equal(agent(body[p], 'bro').total, 0);
      for (const key of ['range', 'filters', 'options', 'agents', 'cost', 'quality', 'throughput', 'outliers', 'slice', 'per_task']) assert.ok(key in body[p], `${p}.${key}`);
    }
    assert.equal(body.options.max_task_id, 5);
    assertSharedBuckets(body);
  });

  test('SC2: a missing or bad period is 400 naming the key; range is ignored', async () => {
    for (const [query, key] of [['p1=30d', 'p2'], ['p1=tasks:5-1&p2=30d', 'p1'], ['p1=30d&p2=bogus', 'p2'], ['p2=30d', 'p1']]) {
      const { status, body } = await get(query);
      assert.equal(status, 400, query);
      assert.match(body.error, new RegExp(`^${key} must be a period like 30d, prev30d, dates:2026-10-01\\.\\.2026-10-15 or tasks:100-200`), query);
    }
    const ver = await get('p1=ver:1.2.0&p2=30d');
    assert.equal(ver.status, 400);
    assert.equal(ver.body.error, 'p1: version periods are not supported yet');
    assert.equal((await get('p1=30d&p2=7d&agent=bogus')).status, 400);
    assert.equal((await get('p1=30d&p2=7d&range=bogus')).status, 200);
  });

  test('SC2: filters and periods are bound as parameters, not spliced into SQL', async () => {
    const { status, body } = await get(`p1=tasks:1-2&p2=tasks:3-&repo=${encodeURIComponent("x' OR 1=1 --")}&model=${encodeURIComponent("'")}`);
    assert.equal(status, 200);
    for (const p of ['p1', 'p2']) assert.deepEqual(body[p].agents.map((a) => a.total), [0, 0, 0]);
    assert.equal(body.options.max_task_id, null);
    assert.equal((await get(`p1=${encodeURIComponent("tasks:1-2' OR 1=1 --")}&p2=30d`)).status, 400);
  });

  test('SC3: two date periods keep bro and share bucket edges', async () => {
    const { status, body } = await get('p1=prev30d&p2=30d');
    assert.equal(status, 200);
    assert.equal(body.bro_excluded, false);
    assert.equal(body.p1.slice.kind, 'prev');
    assert.equal(body.p2.slice.kind, 'range');
    assert.equal(agent(body.p1, 'bro').n, 1);
    assert.equal(agent(body.p2, 'bro').n, 2);
    assert.equal(body.shared_runs, 0);
    assertSharedBuckets(body);
  });
});

describe('compare()', () => {
  const db = seed(join(tmp, 'direct.db'));
  const priced = seed(join(tmp, 'priced.db'), PRICES);
  after(() => {
    db.close();
    priced.close();
  });
  const run = (d, p1, p2, query = '') => {
    const q = mod.compareQuery(new URLSearchParams(`p1=${encodeURIComponent(p1)}&p2=${encodeURIComponent(p2)}&${query}`), NOW);
    assert.ok(!('error' in q), q.error);
    return mod.compare(d, q.filter, q.p1, q.p2);
  };

  test('SC3: per_task by hand, unpriced', () => {
    const body = run(db, 'tasks:1-2', 'tasks:3-');
    assert.deepEqual(body.p1.per_task, { tasks: 2, runs: 4, tokens_out: 3250, context: 2500, cache_hit: 3900 / 5000, cost_usd: null, unpriced_runs: 4 });
    assert.deepEqual(body.p2.per_task, { tasks: 3, runs: 4, tokens_out: 13_000 / 3, context: 4000, cache_hit: 7500 / 12_000, cost_usd: null, unpriced_runs: 4 });
    assert.ok(body.p1.per_task.tasks > 0);
    assert.notEqual(body.p1.per_task.tokens_out, null);
  });

  test('SC3: per_task cost_usd by hand with model_prices, rounded to 4 decimals', () => {
    const body = run(priced, 'tasks:1-2', 'tasks:3-');
    assert.equal(body.p1.per_task.cost_usd, 0.2317);
    assert.equal(body.p1.per_task.unpriced_runs, 1);
    assert.equal(body.p2.per_task.cost_usd, 0.322);
    assert.equal(body.p2.per_task.unpriced_runs, 1);
  });

  test('SC3: an empty period has null per-task values', () => {
    const body = run(priced, 'tasks:100-', '30d');
    assert.deepEqual(body.p1.per_task, { tasks: 0, runs: 0, tokens_out: null, context: null, cache_hit: null, cost_usd: null, unpriced_runs: 0 });
  });

  test('SC3: overlapping periods count their shared runs', () => {
    const tasks = run(db, 'tasks:1-3', 'tasks:3-');
    assert.equal(tasks.shared_runs, 3);
    assert.equal(tasks.bro_excluded, true);
    const dates = run(db, '90d', '30d');
    assert.equal(dates.shared_runs, 7);
    assert.equal(dates.bro_excluded, false);
    const mixed = run(db, 'tasks:1-2', '30d');
    assert.equal(mixed.bro_excluded, true);
    assert.equal(agent(mixed.p2, 'bro').total, 0);
    assert.equal(agent(mixed.p2, 'swe').total, 4);
  });

  test('SC3: a dates period bounds runs by inclusive UTC day', () => {
    const body = run(db, `dates:${dayOf(50 * DAY)}..${dayOf(40 * DAY)}`, `dates:..${dayOf(40 * DAY)}`);
    assert.equal(body.p1.slice.kind, 'dates');
    for (const p of ['p1', 'p2']) {
      assert.equal(agent(body[p], 'swe').n, 3);
      assert.equal(agent(body[p], 'code-reviewer').n, 1);
      assert.equal(agent(body[p], 'bro').n, 1);
    }
    assert.equal(body.shared_runs, 5);
  });

  test('SC4: quality and throughput count only the tasks in range', () => {
    const body = run(db, 'tasks:1-2', 'tasks:3-');
    assert.deepEqual(body.p1.quality.first_pass, { passed: 1, total: 2 });
    assert.deepEqual(body.p2.quality.first_pass, { passed: 1, total: 2 });
    assert.deepEqual(body.p1.quality.verification, { passed: 1, total: 1 });
    assert.deepEqual(body.p2.quality.verification, { passed: 1, total: 2 });
    const days = (ids) => [...new Set(ids.map((id) => dayOf(CLOSED_AT[id])))].sort();
    assert.deepEqual(body.p1.throughput.map((t) => t.day), days([1, 2]));
    assert.equal(body.p1.throughput.reduce((s, t) => s + t.closed, 0), 2);
    assert.deepEqual(body.p2.throughput, [{ day: dayOf(CLOSED_AT[3]), closed: 1 }]);
  });

  test('SC4: a dates period bounds throughput by inclusive UTC day', () => {
    const day = dayOf(CLOSED_AT[3]);
    const body = run(db, `dates:${day}..${day}`, 'all');
    assert.deepEqual(body.p1.throughput, [{ day, closed: 1 }]);
  });

  test('SC4: /api/insights reports options.max_task_id', () => {
    const body = mod.insights(db, mod.insightFilter(new URLSearchParams('range=30d')), NOW);
    assert.equal(body.options.max_task_id, 5);
    assert.ok(body.options.max_task_id > 0);
    assert.equal(mod.insights(db, mod.insightFilter(new URLSearchParams('repo=nope')), NOW).options.max_task_id, null);
  });
});
