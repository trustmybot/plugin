// Insights test: seed a temp trajectory DB from schema.sql with 25 measured
// swe runs (plus unmeasured ones and one outside the range), 23 code-reviewer
// runs, 3 bro sessions, review verdicts, verification runs and
// closed tasks. Check GET /api/insights over HTTP (shape, 400 on a bad range or
// agent) and insights() directly against hand-computed values, priced and
// unpriced. Then bundle the Insights view with esbuild, render every section to
// static HTML from that data and check the hash round-trip, ChartCard parts,
// cost honesty, the CSV/table match, the marks and the chart accessibility, and
// on a second seed the GH 1948 idle runs and command grouping. On a third
// seed (resumed runs, a prompt-bearing task, plugin versions, a CHANGELOG
// fixture) check GET /api/insights/explore and explore() (groups, folding,
// review rounds, version labels, an unmigrated DB, the 400s), render the
// Explore pivot and charts, and check the histogram nouns and the
// slowest-command order. Last, check
// the build output (lazy chunk, its size, the size budget, devDependencies),
// the agent palette and the contrast and CVD separation of its colours.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const DASH = new URL('..', import.meta.url).pathname;
const SCHEMA = join(DASH, '../mcp/trajectory-server/src/schema.sql');
const SERVER = join(DASH, 'dist/server.mjs');
const WEB = join(DASH, 'dist/web');
const NOW = new Date();
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const SWE = Array.from({ length: 25 }, (_, i) => ({
  out: 1000 * (i + 1),
  in: 100 + i,
  cr: 5000 + 100 * i,
  cc: 500 + 10 * i,
  ms: 60_000 * (i + 1),
  tools: i + 1,
}));
const REVIEWER = Array.from({ length: 23 }, (_, i) => ({ out: 200 * (i + 1), in: 50, cr: 2000, cc: 100, ms: 30_000, tools: 3 }));
const BRO = [{ out: 90_000, in: 1000, cr: 400_000, cc: 20_000, ms: 3 * HOUR, tools: 120 }, { out: 40_000, in: 800, cr: 200_000, cc: 9000, ms: HOUR, tools: 60 }, { out: 10_000, in: 300, cr: 50_000, cc: 2000, ms: HOUR / 2, tools: 10 }];
const OPUS = { input: 15, output: 75, cache_read: 1.5, cache_creation: 18.75 };

function seed(path, prices = '{}') {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  db.prepare(`UPDATE plugin_config SET value_json = ? WHERE key = 'model_prices'`).run(prices);
  const now = NOW.toISOString();
  const issue = Number(db.prepare('INSERT INTO issues (objective, created_at, updated_at) VALUES (?, ?, ?)').run('Insights issue', now, now).lastInsertRowid);
  const task = db.prepare(
    "INSERT INTO tasks (issue_id, branch_id, title, description, status, completed_at, created_at, updated_at) VALUES (?, ?, ?, 'd', ?, ?, ?, ?)",
  );
  const ids = ['a', 'b', 'c', 'd'].map((k, i) =>
    Number(task.run(issue, `feat/${k}`, `Task ${k}`, i < 3 ? 'closed' : 'running', i < 3 ? ago(i === 0 ? DAY : 0) : null, now, now).lastInsertRowid),
  );
  const run = db.prepare(
    `INSERT INTO agent_runs (task_id, agent_type, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens,
       tool_uses, duration_ms, started_at, completed_at, usage_source, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const add = (taskId, agent, r, source, model, start) => run.run(taskId, agent, r.in, r.out, r.cr, r.cc, r.tools, r.ms, start, start, source, model);
  SWE.forEach((r, i) => add(ids[i % 3], 'swe', r, 'subagent_stop', 'claude-opus', ago(i * HOUR)));
  add(ids[0], 'swe', { in: 1, out: 999_999, cr: 1, cc: 1, ms: 1, tools: 1 }, 'unmeasured', 'claude-opus', ago(HOUR));
  add(ids[1], 'swe', { in: 1, out: 999_999, cr: 1, cc: 1, ms: 1, tools: 1 }, null, 'claude-opus', ago(HOUR));
  add(ids[2], 'swe', { in: 1, out: 777_777, cr: 1, cc: 1, ms: 1, tools: 1 }, 'subagent_stop', 'claude-opus', ago(100 * DAY));
  REVIEWER.forEach((r, i) => add(ids[i % 3], 'code-reviewer', r, 'subagent_stop', 'claude-sonnet', ago(i * HOUR)));
  BRO.forEach((r, i) => add(null, 'bro', r, 'transcript', 'claude-opus', ago(i * HOUR)));
  add(ids[0], 'bro', { in: 1, out: 555_555, cr: 1, cc: 1, ms: 1, tools: 1 }, 'transcript', 'claude-opus', ago(HOUR));
  const attempt = db.prepare("INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, created_at) VALUES (?, ?, 'code-reviewer', ?, 1, ?)");
  attempt.run(ids[0], 1, 'pass', now);
  attempt.run(ids[1], 1, 'fail', now);
  attempt.run(ids[1], 2, 'pass', now);
  attempt.run(ids[2], 1, 'escalate', now);
  const vrun = db.prepare("INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s) VALUES (?, 'abc1234', 'gate', ?, ?, ?, 600)");
  const cmd = db.prepare('INSERT INTO verification_run_commands (run_id, ordinal, command, exit_code, elapsed_s) VALUES (?, ?, ?, 0, ?)');
  [0, 0, 1].forEach((exit, i) => {
    const id = Number(vrun.run(ids[i], now, now, exit).lastInsertRowid);
    cmd.run(id, 1, 'bun run build', 10 + i);
    cmd.run(id, 2, 'node --test', 40 + 10 * i);
  });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return { db, ids };
}

function startServer(dbPath, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, TRAJECTORY_DB_PATH: dbPath, TMB_DASHBOARD_PORT: '0', ...env },
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
      contents: `import { renderToStaticMarkup } from 'react-dom/server';
        import { createElement, Fragment } from 'react';
        import { insights, insightFilter, nearestRank, metric, logEdges, histogram, likelyIdle, normalizeCommand, explore } from './server/queries.ts';
        import { parseChangelog, loadReleases, releaseAt } from './server/releases.ts';
        import { exploreTable, CACHE_HIT_HELP, COST_HELP, NEEDS_RUNS, ESTIMATED_TIP, mismatchNote } from './web/views/insights/explore.tsx';
        import { InsightsLayout } from './web/views/insights/InsightsView.tsx';
        import { parseInsightParams, insightHash, clearFilters } from './web/views/insights/params.ts';
        import { ChartCard, DataTableView } from './web/views/insights/ChartCard.tsx';
        import { toCsv, csvName } from './web/views/insights/csv.ts';
        import { NO_PRICES, EFFORT_CAPTION, BRO_CAPTION, IDLE_CAPTION, TASK_LEVEL_CAPTION, NO_MATCH_HEADING, histogramTable } from './web/views/insights/sections.tsx';
        import { AGENT_COLOR, compact, durationTicks } from './web/views/insights/format.ts';
        import { Histogram, barWidth, histBarWidth, labelBox, markerLeader, placeMarkerLabels, thinEdgeTicks } from './web/views/insights/charts.tsx';
        const withHash = (hash, fn) => {
          globalThis.window = { location: { hash }, history: { replaceState() {} }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
          try { return fn(); } finally { delete globalThis.window; }
        };
        const paramsOf = (hash) => {
          const [path, query = ''] = hash.replace(/^#\\/?/, '').split('?');
          return parseInsightParams(path, new URLSearchParams(query));
        };
        export const page = (hash, data, ex) => withHash(hash, () =>
          renderToStaticMarkup(createElement(InsightsLayout, { params: paramsOf(hash), q: { data, error: null }, explore: ex === undefined ? undefined : { data: ex, error: null } })));
        export const exploreRows = (hash, ex) => exploreTable(ex, paramsOf(hash));
        export const histogramSvg = (props) => renderToStaticMarkup(createElement(Histogram, props));
        export const table = (caption, t) => renderToStaticMarkup(createElement(DataTableView, { caption, table: t }));
        export const escaped = (text) => renderToStaticMarkup(createElement(Fragment, null, text));
        export const card = (props) => renderToStaticMarkup(createElement(ChartCard, props, createElement('svg', { role: 'img', 'aria-label': 'x' })));
        export { insights, insightFilter, nearestRank, metric, logEdges, histogram, parseInsightParams, insightHash, clearFilters, toCsv, csvName, NO_PRICES, EFFORT_CAPTION, BRO_CAPTION, IDLE_CAPTION, TASK_LEVEL_CAPTION, NO_MATCH_HEADING, histogramTable, likelyIdle, normalizeCommand, AGENT_COLOR, compact, durationTicks, barWidth, histBarWidth, labelBox, markerLeader, placeMarkerLabels, thinEdgeTicks, explore, parseChangelog, loadReleases, releaseAt, CACHE_HIT_HELP, COST_HELP, NEEDS_RUNS, ESTIMATED_TIP, mismatchNote };`,
      resolveDir: DASH,
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(SERVER)});` },
    write: false,
    logLevel: 'silent',
  });
  mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
});

const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tmb-dashboard-insights-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const filter = (query = '') => mod.insightFilter(new URLSearchParams(query));
const sum = (list, f) => list.reduce((s, r) => s + f(r), 0);

describe('GET /api/insights', () => {
  const dbPath = join(tmp, 'http.db');
  seed(dbPath).db.close();
  let server;
  before(async () => {
    server = await startServer(dbPath);
  });
  after(async () => {
    await server?.stop();
  });

  test('returns range, agents, cost, quality, throughput and outliers', async () => {
    const res = await fetch(`${server.url}api/insights?range=30d`);
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const key of ['range', 'agents', 'cost', 'quality', 'throughput', 'outliers']) assert.ok(key in body, key);
    assert.deepEqual(body.agents.map((a) => a.agent), ['swe', 'code-reviewer', 'bro']);
    assert.equal(body.range.key, '30d');
  });

  test('a bad agent or range is 400; the default range is 30d', async () => {
    for (const q of ['agent=bogus', 'range=bogus', 'range=1y', 'agent=reviewer']) {
      const res = await fetch(`${server.url}api/insights?${q}`);
      assert.equal(res.status, 400, q);
      assert.match((await res.json()).error, /must be one of/);
    }
    assert.equal((await fetch(`${server.url}api/insights?agent=code-reviewer`)).status, 200);
    const body = await (await fetch(`${server.url}api/insights`)).json();
    assert.equal(body.range.key, '30d');
  });

  test('filters are bound as parameters, not spliced into SQL', async () => {
    const res = await fetch(`${server.url}api/insights?repo=${encodeURIComponent("x' OR 1=1 --")}&model=${encodeURIComponent("'")}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.agents.map((a) => a.total), [0, 0, 0]);
  });
});

describe('insights()', () => {
  const { db } = seed(join(tmp, 'direct.db'));
  const data = () => mod.insights(db, filter('range=30d'), NOW);
  const agent = (d, name) => d.agents.find((a) => a.agent === name);

  test('nearest-rank percentiles, and null p50/p95 under 20 values', () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    assert.equal(mod.nearestRank(values, 0.5), 10);
    assert.equal(mod.nearestRank(values, 0.95), 19);
    assert.deepEqual(mod.metric(values.slice(0, 19)), { p50: null, p95: null, max: 19, avg: 10 });
  });

  test('swe: unmeasured runs count in total only; p50/p95 by hand', () => {
    const swe = agent(data(), 'swe');
    assert.equal(swe.per, 'run');
    assert.equal(swe.n, 25);
    assert.equal(swe.total, 27);
    assert.deepEqual(swe.tokens_out, { p50: 13_000, p95: 24_000, max: 25_000, avg: 13_000 });
    const ctx = SWE.map((r) => r.in + r.cr + r.cc).sort((a, b) => a - b);
    assert.equal(swe.context.p50, ctx[12]);
    assert.equal(swe.context.p95, ctx[23]);
    assert.equal(swe.duration_ms.max, 25 * 60_000);
    assert.equal(swe.tool_uses.p50, 13);
    assert.equal(swe.cache_hit.avg, sum(SWE, (r) => r.cr) / sum(SWE, (r) => r.in + r.cr + r.cc));
  });

  test('code-reviewer is the code-reviewer runs', () => {
    const reviewer = agent(data(), 'code-reviewer');
    assert.equal(reviewer.n, 23);
    assert.equal(reviewer.total, 23);
    assert.equal(reviewer.tokens_out.p50, 200 * 12);
    assert.notEqual(reviewer.tokens_out.p95, null);
  });

  test('bro is per session, session rows only, with null p50/p95', () => {
    const bro = agent(data(), 'bro');
    assert.equal(bro.per, 'session');
    assert.equal(bro.n, 3);
    assert.equal(bro.tokens_out.p50, null);
    assert.equal(bro.tokens_out.p95, null);
    assert.equal(bro.tokens_out.max, 90_000);
    assert.equal(bro.cache_hit.avg, sum(BRO, (r) => r.cr) / sum(BRO, (r) => r.in + r.cr + r.cc));
  });

  test('SC1: one histogram per metric, at most 10 buckets covering every measured run; cache-hit on fixed 10% edges', () => {
    const d = data();
    const METRIC_KEYS = ['tokens_out', 'context', 'cache_hit', 'tool_uses'];
    const tenths = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
    for (const a of d.agents) {
      assert.ok(!('histogram' in a), a.agent);
      assert.deepEqual(Object.keys(a.histograms).sort(), [...METRIC_KEYS].sort(), a.agent);
      for (const m of METRIC_KEYS) {
        const h = a.histograms[m];
        assert.ok(h.length > 0 && h.length <= 10, `${a.agent} ${m}`);
        assert.equal(sum(h, (b) => b.count), a.n, `${a.agent} ${m}`);
        for (let i = 1; i < h.length; i++) assert.equal(h[i].from, h[i - 1].to);
      }
      assert.deepEqual([...a.histograms.cache_hit.map((b) => b.from), a.histograms.cache_hit.at(-1).to], tenths, a.agent);
    }
    for (const m of METRIC_KEYS) assert.deepEqual(agent(d, 'swe').histograms[m].map((b) => b.from), agent(d, 'code-reviewer').histograms[m].map((b) => b.from), m);
    assert.notDeepEqual(agent(d, 'swe').histograms.context.map((b) => b.from), agent(d, 'bro').histograms.context.map((b) => b.from));
    const swe = agent(d, 'swe').histograms;
    assert.equal(swe.tool_uses[0].from, 1);
    assert.equal(swe.tool_uses.at(-1).to, 25);
    assert.equal(swe.context[0].from, Math.min(...[...SWE, ...REVIEWER].map((r) => r.in + r.cr + r.cc)));
    const hits = SWE.map((r) => r.cr / (r.in + r.cr + r.cc));
    assert.equal(swe.cache_hit[Math.floor(hits[0] * 10)].count, hits.filter((h) => Math.floor(h * 10) === Math.floor(hits[0] * 10)).length);
    const edges = mod.logEdges([1, 10_000]);
    assert.equal(edges.length, 11);
    assert.ok(Math.abs(edges[5] - 100) <= 1);
  });

  test('range and agent filters', () => {
    assert.equal(agent(mod.insights(db, filter('range=all'), NOW), 'swe').n, 26);
    const onlySwe = mod.insights(db, filter('agent=swe'), NOW);
    assert.deepEqual(onlySwe.agents.map((a) => a.n), [25, 0, 0]);
    assert.deepEqual(filter('agent=bogus'), { error: 'agent must be one of swe, code-reviewer, bro' });
  });

  test('quality: first pass, attempts, verdicts, verification and slowest commands', () => {
    const q = data().quality;
    assert.deepEqual(q.first_pass, { passed: 1, total: 3 });
    assert.deepEqual(q.attempts, [{ attempts: 1, tasks: 2 }, { attempts: 2, tasks: 1 }]);
    assert.deepEqual(q.verdicts, { pass: 2, fail: 1, escalate: 1 });
    assert.deepEqual(q.verification, { passed: 2, total: 3 });
    assert.deepEqual(q.slowest_commands.map((c) => [c.command, c.n, c.max]), [['node --test', 3, 60], ['bun run build', 3, 12]]);
    assert.ok(q.slowest_commands.length <= 10);
  });

  test('throughput is closed tasks per day', () => {
    const t = data().throughput;
    assert.deepEqual(t.map((d) => d.day), [ago(DAY).slice(0, 10), NOW.toISOString().slice(0, 10)]);
    assert.deepEqual(t.map((d) => d.closed), [1, 2]);
  });

  test('outliers: top 10 per-run runs by output, context and duration, each with task_id', () => {
    const o = data().outliers;
    for (const key of ['tokens_out', 'context', 'duration_ms']) {
      assert.equal(o[key].length, 10, key);
      for (const r of o[key]) assert.equal(typeof r.task_id, 'number');
    }
    assert.deepEqual(o.tokens_out.slice(0, 2).map((r) => r.value), [25_000, 24_000]);
    assert.equal(o.duration_ms[0].value, 25 * 60_000);
  });

  test('cost with no complete price: priced false, nothing in USD', () => {
    const cost = data().cost;
    assert.equal(cost.priced, false);
    assert.deepEqual(cost.by_agent, []);
    assert.deepEqual(cost.by_model, []);
  });

  test('cost with one complete price: USD by agent and model, incomplete entries unpriced', () => {
    const { db: priced } = seed(join(tmp, 'priced.db'), JSON.stringify({ 'claude-opus': OPUS, 'claude-sonnet': { input: 3, output: 15 } }));
    try {
      const cost = mod.insights(priced, filter('range=30d'), NOW).cost;
      assert.equal(cost.priced, true);
      assert.equal(cost.unpriced_runs, 23);
      const usd = (rows) => Math.round(sum(rows, (r) => (r.in * OPUS.input + r.out * OPUS.output + r.cr * OPUS.cache_read + r.cc * OPUS.cache_creation) / 1e6) * 1e4) / 1e4;
      assert.deepEqual(cost.by_agent.find((a) => a.agent === 'swe'), { agent: 'swe', usd: usd(SWE), runs: 25 });
      assert.deepEqual(cost.by_agent.find((a) => a.agent === 'bro'), { agent: 'bro', usd: usd(BRO), runs: 3 });
      assert.equal(cost.by_agent.find((a) => a.agent === 'code-reviewer'), undefined);
      assert.deepEqual(cost.by_model, [{ model: 'claude-opus', usd: usd([...SWE, ...BRO]), runs: 28 }]);
    } finally {
      priced.close();
    }
  });
});

describe('GH 1948: idle runs and subshell command variants', () => {
  const MIN = 60_000;
  const SHAPES = {
    240: { agent: 'code-reviewer', ms: 217 * MIN, tools: 34, out: 18_000 },
    387: { agent: 'swe', ms: 137 * MIN, tools: 21, out: 7000 },
    178: { agent: 'swe', ms: 36.86 * MIN, tools: 43, out: 17_676 },
    329: { agent: 'swe', ms: 97.84 * MIN, tools: 454, out: 252_482 },
  };
  const CMD = 'cd mcp/trajectory-server && bun run test';
  const { db, ids } = seed(join(tmp, 'gh1948.db'));
  const runIds = {};
  for (const [name, s] of Object.entries(SHAPES)) {
    const r = db
      .prepare(`INSERT INTO agent_runs (task_id, agent_type, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, tool_uses, duration_ms, started_at, completed_at, usage_source, model)
                VALUES (?, ?, 10, ?, 0, 0, ?, ?, ?, ?, 'subagent_stop', 'claude-opus')`)
      .run(ids[0], s.agent, s.out, s.tools, s.ms, ago(HOUR), ago(HOUR));
    runIds[name] = Number(r.lastInsertRowid);
  }
  const vrun = db.prepare("INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s) VALUES (?, 'abc1234', 'gate', ?, ?, 0, 600)");
  const cmd = db.prepare('INSERT INTO verification_run_commands (run_id, ordinal, command, exit_code, elapsed_s) VALUES (?, 1, ?, 0, ?)');
  const now = NOW.toISOString();
  for (let i = 0; i < 39; i++) cmd.run(Number(vrun.run(ids[i % 3], now, now).lastInsertRowid), i < 31 ? CMD : `(${CMD})`, 100 + i);
  const data = () => mod.insights(db, filter('range=30d'), NOW);

  test('likelyIdle: over 30 min with under 1 tool use and 500 output tokens a minute', () => {
    const run = (s) => ({ duration_ms: s.ms, tool_uses: s.tools, tokens_out: s.out });
    assert.equal(mod.likelyIdle(run(SHAPES[240])), true);
    assert.equal(mod.likelyIdle(run(SHAPES[387])), true);
    assert.equal(mod.likelyIdle(run(SHAPES[178])), false);
    assert.equal(mod.likelyIdle(run(SHAPES[329])), false);
    assert.equal(mod.likelyIdle({ duration_ms: 29 * MIN, tool_uses: 0, tokens_out: 0 }), false);
    assert.equal(mod.likelyIdle({ duration_ms: 60 * MIN, tool_uses: 60, tokens_out: 0 }), false);
    assert.equal(mod.likelyIdle({ duration_ms: 60 * MIN, tool_uses: 0, tokens_out: 30_000 }), false);
  });

  test('duration outliers: top 10 non-idle runs, then idle runs, each with tool_uses, tokens_out and idle', () => {
    const rows = data().outliers.duration_ms;
    assert.equal(rows.length, 12);
    assert.deepEqual(rows.slice(-2).map((r) => r.run_id), [runIds[240], runIds[387]]);
    for (const r of rows.slice(-2)) {
      assert.equal(r.idle, true);
      assert.notEqual(r.tool_uses, null);
      assert.notEqual(r.tokens_out, null);
    }
    assert.deepEqual(rows.slice(-2).map((r) => [r.tool_uses, r.tokens_out]), [[34, 18_000], [21, 7000]]);
    assert.deepEqual(rows.slice(0, 2).map((r) => r.run_id), [runIds[329], runIds[178]]);
    assert.ok(rows.slice(0, 10).every((r) => r.idle === false && typeof r.tool_uses === 'number' && typeof r.tokens_out === 'number'));
    for (let i = 1; i < 10; i++) assert.ok(rows[i - 1].value >= rows[i].value);
  });

  test('normalizeCommand strips only parentheses that wrap the whole command', () => {
    assert.equal(mod.normalizeCommand(`  (${CMD})  `), CMD);
    assert.equal(mod.normalizeCommand(`((  cd   a &&  b ))`), 'cd a && b');
    assert.equal(mod.normalizeCommand('(a) && (b)'), '(a) && (b)');
    assert.equal(mod.normalizeCommand('(a) && b'), '(a) && b');
    assert.equal(mod.normalizeCommand('node\t--test'), 'node --test');
  });

  test('slowest commands group the subshell form with the bare one: one row, n = 39', () => {
    const rows = data().quality.slowest_commands.filter((c) => c.command.includes('trajectory-server'));
    assert.deepEqual(rows.map((c) => [c.command, c.n]), [[CMD, 39]]);
  });

  test('the Top runs table labels idle rows and lists them last', () => {
    const html = mod.page('#/insights/time?range=30d', data());
    const top = html.slice(html.indexOf('aria-label="Top runs by duration"'));
    const labelled = [...top.matchAll(/<tr[^>]*>.*?<\/tr>/gs)].filter((r) => r[0].includes('Likely idle'));
    assert.equal(labelled.length, 2);
    assert.match(labelled[0][0], /border-\(--borderColor-muted\) text-fg-muted[^>]*>Likely idle</);
    assert.ok(top.includes(mod.IDLE_CAPTION));
  });
});

const CHANGELOG = `# Changelog\n\n## v2.0.0 — ${ago(10 * DAY).slice(0, 10)}\n\n- two\n\n## v1.0.0 — ${ago(150 * DAY).slice(0, 10)}\n\n- one\n`;
const ESTIMATE_2 = '≈ v2.0.0 (by date)';
const ESTIMATE_1 = '≈ v1.0.0 (by date)';

// seed() plus: swe runs 1-4 resumed, task a prompt-bearing, a measured swe run
// 200 days ago, and plugin_version on swe runs (by `version(i)`) and on every
// code-reviewer run ('1.5.0').
function seedExplore(path, { prices = '{}', version = (i) => (i < 10 ? '1.4.0' : null) } = {}) {
  const { db, ids } = seed(path, prices);
  db.prepare(`INSERT INTO agent_runs (task_id, agent_type, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, tool_uses, duration_ms, started_at, completed_at, usage_source, model)
              VALUES (?, 'swe', 10, 3000, 100, 10, 2, 1000, ?, ?, 'subagent_stop', 'claude-opus')`).run(ids[0], ago(200 * DAY), ago(200 * DAY));
  const swe = db.prepare("SELECT id FROM agent_runs WHERE agent_type = 'swe' AND usage_source = 'subagent_stop' ORDER BY id").all().map((r) => Number(r.id));
  for (let k = 1; k <= 4; k++) db.prepare('UPDATE agent_runs SET resumed_from = ? WHERE id = ?').run(swe[k - 1], swe[k]);
  SWE.forEach((_, i) => db.prepare('UPDATE agent_runs SET plugin_version = ? WHERE id = ?').run(version(i), swe[i]));
  db.prepare("UPDATE agent_runs SET plugin_version = '1.5.0' WHERE agent_type = 'code-reviewer'").run();
  db.prepare('UPDATE tasks SET prompt_bearing = 1 WHERE id = ?').run(ids[0]);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return { db, ids };
}

const byKey = (ex) => Object.fromEntries(ex.groups.map((g) => [g.key.join(' / '), g.n]));

describe('GET /api/insights/explore', () => {
  const dbPath = join(tmp, 'explore.db');
  seedExplore(dbPath).db.close();
  const bare = join(tmp, 'explore-unmigrated.db');
  const copy = seedExplore(bare).db;
  copy.exec('ALTER TABLE agent_runs DROP COLUMN plugin_version');
  copy.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  copy.close();
  const changelog = join(tmp, 'CHANGELOG.md');
  writeFileSync(changelog, CHANGELOG);
  let server;
  let unmigrated;
  before(async () => {
    server = await startServer(dbPath, { TMB_DASHBOARD_CHANGELOG: changelog });
    unmigrated = await startServer(bare, { TMB_DASHBOARD_CHANGELOG: changelog });
  });
  after(async () => {
    await server?.stop();
    await unmigrated?.stop();
  });
  const get = async (query, s = server) => {
    const res = await fetch(`${s.url}api/insights/explore?${query}`);
    return { status: res.status, body: await res.json() };
  };

  test('returns measure, agg, dims, groups, review_round_mismatch, days and options; defaults m=tokens_out a=p50 g=agent', async () => {
    const { status, body } = await get('range=30d');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['agg', 'days', 'dims', 'groups', 'measure', 'options', 'review_round_mismatch']);
    assert.deepEqual([body.measure, body.agg, body.dims, body.days], ['tokens_out', 'p50', ['agent'], 30]);
    for (const g of body.groups) assert.deepEqual(Object.keys(g).sort(), ['key', 'n', 'value']);
    assert.deepEqual(body.options.dims.length, 13);
    assert.equal(body.options.priced, false);
  });

  test('every bad query is 400 with {error}', async () => {
    for (const query of ['m=bogus', 'a=bogus', 'g=bogus', 'g=agent,model,effort', 'g=agent,agent', 'm=cache_hit&a=sum', 'm=cache_hit&a=p95', 'm=cost', 'range=bogus']) {
      const { status, body } = await get(query);
      assert.equal(status, 400, query);
      assert.equal(typeof body.error, 'string', query);
    }
    assert.equal((await get('m=cache_hit&a=avg')).status, 200);
  });

  test('SC2: exact plugin_version, ≈ v<X> (by date) from the CHANGELOG, unknown before the first release', async () => {
    const { body } = await get('range=all&m=tokens_out&a=count&g=plugin_version');
    assert.deepEqual(byKey(body), { '1.5.0': 23, [ESTIMATE_2]: 18, '1.4.0': 10, [ESTIMATE_1]: 1, unknown: 1 });
  });

  test('SC2: a DB without agent_runs.plugin_version serves, with every row estimated by date', async () => {
    const { status, body } = await get('range=all&m=tokens_out&a=count&g=plugin_version', unmigrated);
    assert.equal(status, 200);
    assert.deepEqual(byKey(body), { [ESTIMATE_2]: 51, [ESTIMATE_1]: 1, unknown: 1 });
  });
});

test('dashboard/README.md documents GET /api/insights/explore and the TMB_DASHBOARD_CHANGELOG override', () => {
  const readme = readFileSync(join(DASH, 'README.md'), 'utf8');
  assert.ok(readme.includes('| `/api/insights/explore?m=&a=&g=&range=&repo=&agent=&model=&effort=` | `{ measure, agg, dims, groups, review_round_mismatch, days, options }`'));
  assert.ok(readme.includes('TMB_DASHBOARD_CHANGELOG'));
});

describe('explore()', () => {
  const { db } = seedExplore(join(tmp, 'explore-direct.db'));
  const { db: folded } = seedExplore(join(tmp, 'explore-fold.db'), { version: (i) => (i < 24 ? `1.0.${i % 12}` : null) });
  after(() => {
    db.close();
    folded.close();
  });
  const releases = () => mod.parseChangelog(CHANGELOG);
  const ex = (query, d = db, range = 'range=30d') => mod.explore(d, filter(range), new URLSearchParams(query), releases(), NOW);

  test('g=agent&a=count: swe 25, code-reviewer 23, bro 3', () => {
    assert.deepEqual(byKey(ex('a=count&g=agent')), { swe: 25, 'code-reviewer': 23, bro: 3 });
    assert.equal(ex('a=count&g=agent').groups.find((g) => g.key[0] === 'code-reviewer').value, 23);
  });

  test('g=review_round: 1, 2 and 3+ per task, Not a review for the rest', () => {
    assert.deepEqual(byKey(ex('a=count&g=review_round')), { '1': 3, '2': 3, '3+': 17, 'Not a review': 28 });
  });

  test('g=resumed, g=prompt_bearing and g=task_status', () => {
    assert.deepEqual(byKey(ex('a=count&g=resumed')), { resumed: 4, fresh: 47 });
    assert.deepEqual(byKey(ex('a=count&g=prompt_bearing')), { 'prompt-bearing': 17, 'not prompt-bearing': 31, 'No task': 3 });
    assert.deepEqual(byKey(ex('a=count&g=task_status')), { closed: 48, 'No task': 3 });
  });

  test('cache_hit by agent is Σcache_read ÷ Σcontext over measured runs', () => {
    const ratio = (list) => sum(list, (r) => r.cr) / sum(list, (r) => r.in + r.cr + r.cc);
    const got = Object.fromEntries(ex('m=cache_hit&a=avg&g=agent').groups.map((g) => [g.key[0], g.value]));
    for (const [agent, list] of [['swe', SWE], ['code-reviewer', REVIEWER], ['bro', BRO]]) assert.ok(Math.abs(got[agent] - ratio(list)) < 1e-12, agent);
  });

  test('p50 and p95 are nearest-rank, null under 20 runs', () => {
    const groups = Object.fromEntries(ex('a=p95&g=agent').groups.map((g) => [g.key[0], g.value]));
    assert.equal(groups.swe, mod.nearestRank(SWE.map((r) => r.out).sort((a, b) => a - b), 0.95));
    assert.equal(groups.bro, null);
    assert.equal(ex('a=p95&g=agent').groups.at(-1).key[0], 'bro');
  });

  test('review_round_mismatch counts tasks whose reviewer run count differs from their highest attempt', () => {
    assert.equal(ex('g=review_round').review_round_mismatch, 3);
  });

  test('one dimension: at most 10 groups, sorted descending, the rest folded into Other last', () => {
    const { groups } = ex('a=count&g=plugin_version', folded);
    assert.equal(groups.length, 10);
    assert.deepEqual(groups.at(-1).key, ['Other']);
    for (let i = 1; i < 9; i++) assert.ok(groups[i - 1].value >= groups[i].value);
    assert.equal(sum(groups, (g) => g.n), 51);
    assert.equal(groups.at(-1).value, groups.at(-1).n);
  });

  test('two dimensions: at most 4 first-level values with at most 7 groups each', () => {
    for (const query of ['a=count&g=plugin_version,agent', 'a=count&g=agent,plugin_version', 'a=p95&g=agent,review_round']) {
      const { groups } = ex(query, folded);
      const panels = [...new Set(groups.map((g) => g.key[0]))];
      assert.ok(panels.length <= 4, query);
      for (const p of panels) assert.ok(groups.filter((g) => g.key[0] === p).length <= 7, `${query}: ${p}`);
    }
    const panels = [...new Set(ex('a=count&g=plugin_version,agent', folded).groups.map((g) => g.key[0]))];
    assert.deepEqual([panels.length, panels.at(-1)], [4, 'Other']);
    const bars = ex('a=count&g=agent,plugin_version', folded).groups.filter((g) => g.key[0] === 'swe');
    assert.deepEqual([bars.length, bars.at(-1).key], [7, ['swe', 'Other']]);
  });

  test('day, week, model, exit_reason and usage_source labels', () => {
    const days = Object.keys(byKey(ex('a=count&g=day')));
    assert.ok(days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)), days.join());
    for (const w of Object.keys(byKey(ex('a=count&g=week')))) assert.equal(new Date(`${w}T00:00:00Z`).getUTCDay(), 1, w);
    assert.deepEqual(byKey(ex('a=count&g=model')), { 'claude-opus': 28, 'claude-sonnet': 23 });
    assert.deepEqual(byKey(ex('a=count&g=exit_reason')), { open: 51 });
    assert.deepEqual(byKey(ex('a=count&g=usage_source')), { subagent_stop: 48, transcript: 3 });
  });

  test('cost: 400 unpriced; priced runs only when prices are set', () => {
    assert.ok('error' in ex('m=cost&a=sum'));
    const { db: priced } = seedExplore(join(tmp, 'explore-priced.db'), { prices: JSON.stringify({ 'claude-opus': OPUS }) });
    try {
      const got = byKey(mod.explore(priced, filter('range=30d'), new URLSearchParams('m=cost&a=count&g=agent'), [], NOW));
      assert.deepEqual(got, { swe: 25, bro: 3 });
    } finally {
      priced.close();
    }
  });

  test('parseChangelog reads ## v<X> — YYYY-MM-DD headings; releaseAt picks the last at or before the run', () => {
    const r = releases();
    assert.deepEqual(r.map((x) => x.version), ['2.0.0', '1.0.0']);
    assert.equal(mod.releaseAt(r, ago(50 * DAY)).version, '1.0.0');
    assert.equal(mod.releaseAt(r, ago(DAY)).version, '2.0.0');
    assert.equal(mod.releaseAt(r, ago(200 * DAY)), null);
    assert.deepEqual(mod.loadReleases(join(tmp, 'no-such-CHANGELOG.md')), []);
    assert.ok(mod.loadReleases(join(DASH, '../CHANGELOG.md')).length > 0);
  });
});

describe('Explore view', () => {
  const { db } = seedExplore(join(tmp, 'explore-view.db'));
  const { db: folded } = seedExplore(join(tmp, 'explore-view-fold.db'), { version: (i) => (i < 24 ? `1.0.${i % 12}` : null) });
  const { db: pricedDb } = seedExplore(join(tmp, 'explore-view-priced.db'), { prices: JSON.stringify({ 'claude-opus': OPUS }) });
  after(() => {
    db.close();
    folded.close();
    pricedDb.close();
  });
  const releases = () => mod.parseChangelog(CHANGELOG);
  const view = (query, d = db) => {
    const hash = `#/insights/explore?range=30d&${query}`;
    const params = new URLSearchParams(query);
    if (params.get('m') === 'cache_hit') params.set('a', 'avg');
    const ex = mod.explore(d, filter('range=30d'), params, releases(), NOW);
    assert.ok(!('error' in ex), ex.error);
    return { hash, ex, html: mod.page(hash, mod.insights(d, filter('range=30d'), NOW), ex) };
  };

  test('#/insights/explore?m=tokens_out&a=p95&g=agent,review_round&range=30d round-trips', () => {
    const hash = '#/insights/explore?m=tokens_out&a=p95&g=agent,review_round&range=30d';
    const [path, query] = hash.slice(2).split('?');
    const params = mod.parseInsightParams(path, new URLSearchParams(query));
    assert.deepEqual([params.section, params.range, params.measure, params.agg, params.dims], ['explore', '30d', 'tokens_out', 'p95', ['agent', 'review_round']]);
    const again = mod.insightHash(params);
    assert.match(again, /&m=tokens_out&x=tokens_out&a=p95&g=agent,review_round$/);
    const [path2, query2] = again.slice(2).split('?');
    assert.deepEqual(mod.parseInsightParams(path2, new URLSearchParams(query2)), params);
    assert.equal(mod.parseInsightParams('insights/explore', new URLSearchParams('g=agent,agent,model,bogus')).dims.join(), 'agent,model');
  });

  test('the pivot: four labelled selects in one group, stacking under sm', () => {
    const { html } = view('m=tokens_out&a=p50&g=agent');
    const pivot = /<div role="group" aria-label="Pivot" class="([^"]+)">(.*?)<\/div>/s.exec(html);
    assert.ok(pivot);
    assert.match(pivot[1], /max-sm:flex-col/);
    const labels = [...pivot[2].matchAll(/<label[^>]*>(.*?)<\/label>/gs)];
    assert.equal(labels.length, 4);
    assert.deepEqual(labels.map((l) => /<span class="sr-only">([^<]+)<\/span>/.exec(l[1])[1]), ['Aggregate', 'Measure', 'Dimension', 'Then by']);
    for (const l of labels) assert.match(l[1], /<select/);
  });

  test('sum is disabled for cache-hit %, cost when unpriced; both show helper text', () => {
    const cache = view('m=cache_hit&a=avg&g=agent').html;
    assert.match(cache, /<option value="sum" disabled="">Sum<\/option>/);
    assert.match(cache, /<option value="avg" selected="">Average<\/option>/);
    assert.ok(cache.includes(mod.escaped(mod.CACHE_HIT_HELP)));
    assert.match(cache, /<option value="cost" disabled="">Cost<\/option>/);
    assert.ok(cache.includes(mod.COST_HELP));
    const plain = view('m=tokens_out&a=sum&g=agent').html;
    assert.doesNotMatch(plain, /<option value="sum" disabled/);
    assert.ok(!plain.includes(mod.escaped(mod.CACHE_HIT_HELP)));
    const priced = view('m=cost&a=sum&g=agent', pricedDb).html;
    assert.doesNotMatch(priced, /<option value="cost" disabled/);
    assert.ok(!priced.includes(mod.COST_HELP));
    assert.match(priced, /\$/);
  });

  test('one dimension: bars labelled with the run count, each focusable with an aria-label', () => {
    const { html, ex } = view('m=tokens_out&a=count&g=agent');
    for (const label of ['swe · 25 runs', 'code-reviewer · 23 runs', 'bro · 3 runs']) assert.ok(html.includes(`>${label}</text>`), label);
    const hits = [...html.matchAll(/data-hit="" tabindex="0"[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(hits.length, ex.groups.length);
    assert.match(hits[0], /^swe, 25 runs: Count output tokens 25$/);
    assert.ok(html.includes(`>${mod.NEEDS_RUNS}<`) === false);
    assert.match(view('m=tokens_out&a=p50&g=resumed').html, />resumed · 4 runs<\/text>/);
  });

  test('a null p50 or p95 under 20 runs reads "needs 20 runs", with no bar', () => {
    const { html, ex } = view('m=tokens_out&a=p50&g=agent');
    assert.ok(html.includes(`>${mod.NEEDS_RUNS}</text>`));
    assert.equal((html.match(/data-mark=""/g) ?? []).length, ex.groups.filter((g) => g.value !== null).length);
  });

  test('two dimensions: at most 4 panels on a shared x scale, n<20 p95 shows "needs 20 runs"', () => {
    const { html } = view('m=tokens_out&a=p95&g=agent,review_round');
    const panels = html.split('data-panel=""').slice(1);
    assert.ok(panels.length >= 2 && panels.length <= 4, String(panels.length));
    assert.ok(html.includes(`>${mod.NEEDS_RUNS}</text>`));
    const axisTop = (p) => [...p.matchAll(/<tspan[^>]*>([^<]+)<\/tspan>/g)].map((m) => m[1]).at(-1);
    assert.equal(new Set(panels.map(axisTop)).size, 1);
    const fold = view('m=tokens_out&a=count&g=plugin_version,agent', folded).html;
    assert.equal(fold.split('data-panel=""').length - 1, 4);
  });

  test('Other is --fgColor-muted; estimated versions carry the tooltip text', () => {
    const { html } = view('m=tokens_out&a=count&g=plugin_version', folded);
    assert.ok(html.includes('>Other · '));
    assert.match(html, /stroke="var\(--fgColor-muted\)" stroke-width="2" data-cap=""/);
    assert.ok(html.includes(mod.ESTIMATED_TIP));
  });

  test('the CSV equals the table rows', () => {
    const { hash, ex } = view('m=tokens_out&a=p95&g=agent,review_round');
    const t = mod.exploreRows(hash, ex);
    assert.deepEqual(t.columns, ['Agent', 'Review round', 'Runs', 'p95 output tokens']);
    assert.equal(t.rows.length, ex.groups.length);
    assert.ok(t.rows.some((r) => r[3] === mod.NEEDS_RUNS));
    const html = mod.table('cap', t);
    const decode = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
    const head = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => decode(m[1]));
    const cells = [...html.matchAll(/<tr[^>]*>((?:<td[^>]*>[^<]*<\/td>)+)<\/tr>/g)].map((r) => [...r[1].matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((m) => decode(m[1])));
    assert.deepEqual(mod.toCsv(t).split('\r\n').map((line) => line.split(',')), [head, ...cells]);
  });

  test('the review-round footnote shows the mismatch count only when grouping by review round', () => {
    assert.equal(mod.mismatchNote(1), '1 task has a different review count than their recorded attempts, so round numbers may be off.');
    assert.ok(view('m=tokens_out&a=count&g=review_round').html.includes(mod.mismatchNote(3)));
    assert.ok(!view('m=tokens_out&a=count&g=agent').html.includes('different review count'));
  });

  test('cost unpriced: the Flash instead of a chart', () => {
    const html = mod.page('#/insights/explore?range=30d&m=cost&a=sum', mod.insights(db, filter('range=30d'), NOW), undefined);
    assert.ok(html.includes(mod.COST_HELP));
    assert.doesNotMatch(html, /data-chart-card/);
  });
});

describe('GH 1347 polish: histogram nouns and slowest-command order', () => {
  const { db, ids } = seed(join(tmp, 'polish.db'));
  const vrun = db.prepare("INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s) VALUES (?, 'abc1234', 'gate', ?, ?, 0, 600)");
  const cmd = db.prepare('INSERT INTO verification_run_commands (run_id, ordinal, command, exit_code, elapsed_s) VALUES (?, 1, ?, 0, ?)');
  const now = NOW.toISOString();
  const add = (command, elapsed) => elapsed.forEach((s, i) => cmd.run(Number(vrun.run(ids[i % 3], now, now).lastInsertRowid), command, s));
  add('slow suite', Array.from({ length: 20 }, (_, i) => 30 + i));
  add('fast suite', Array.from({ length: 25 }, (_, i) => 1 + i));
  add('rare outlier', [5, 6, 7, 8, 500]);
  after(() => db.close());
  const data = () => mod.insights(db, filter('range=30d'), NOW);

  test('slowest commands: n ≥ 20 by p95 first, then n < 20 by max', () => {
    const rows = data().quality.slowest_commands;
    assert.deepEqual(rows.map((c) => [c.command, c.n]), [['slow suite', 20], ['fast suite', 25], ['rare outlier', 5], ['node --test', 3], ['bun run build', 3]]);
    assert.ok(rows[2].max > rows[0].p95 && rows[1].p95 < rows[0].p95);
    assert.equal(rows[2].p95, null);
  });

  test('the heading reads "Slowest verification commands"; the n<20 p95 cell is —', () => {
    const html = mod.page('#/insights/quality?range=30d', data());
    assert.match(html, /<h3[^>]*>Slowest verification commands<\/h3>/);
    assert.ok(!html.includes('(by p95)'));
    const slow = html.slice(html.indexOf('aria-label="Slowest verification commands"'));
    const row = slow.slice(slow.indexOf('title="rare outlier"'), slow.indexOf('</tr>', slow.indexOf('title="rare outlier"')));
    assert.match(row, />—</);
  });

  test('histogram aria text: bro counts sessions, swe counts runs', () => {
    const html = mod.page('#/insights/tokens?range=30d', data());
    const bro = html.slice(html.indexOf('data-agent="bro"'));
    const broHits = [...bro.matchAll(/aria-label="(bro, [^"]+)"/g)].map((m) => m[1]);
    assert.ok(broHits.length > 0);
    for (const a of broHits) {
      assert.match(a, /: \d+ sessions?$/);
      assert.doesNotMatch(a, /\bruns?\b/);
    }
    const swe = [...html.matchAll(/aria-label="(swe, [^"]+ output tokens: \d+ [a-z]+)"/g)].map((m) => m[1]);
    assert.ok(swe.length > 0 && swe.every((a) => /: \d+ runs?$/.test(a)));
  });
});

describe('Insights view', () => {
  const { db } = seed(join(tmp, 'view.db'));
  const { db: pricedDb } = seed(join(tmp, 'view-priced.db'), JSON.stringify({ 'claude-opus': OPUS }));
  let data;
  let priced;
  before(() => {
    data = mod.insights(db, filter('range=30d'), NOW);
    priced = mod.insights(pricedDb, filter('range=30d'), NOW);
  });
  const SECTIONS = ['tokens', 'cost', 'time', 'quality', 'throughput'];
  const at = (section, query = 'range=30d') => mod.page(`#/insights/${section}?${query}`, data);

  test('the hash round-trips every param; an unknown section falls back to Tokens', () => {
    const params = { section: 'quality', range: '90d', metric: 'cache_hit', measure: 'duration_ms', agg: 'p50', dims: ['agent'], filters: { repo: 'plugin', agent: 'code-reviewer', model: 'claude-opus', effort: 'high' } };
    const hash = mod.insightHash(params);
    assert.equal(hash, '#/insights/quality?range=90d&repo=plugin&agent=code-reviewer&model=claude-opus&effort=high&m=cache_hit&x=duration_ms');
    const [path, query] = hash.slice(2).split('?');
    assert.deepEqual(mod.parseInsightParams(path, new URLSearchParams(query)), params);
    assert.equal(mod.parseInsightParams('insights/bogus', new URLSearchParams('range=nope&m=nope')).section, 'tokens');
    assert.deepEqual(mod.parseInsightParams('insights', new URLSearchParams()), { section: 'tokens', range: '30d', metric: 'tokens_out', measure: 'tokens_out', agg: 'p50', dims: ['agent'], filters: { repo: '', agent: '', model: '', effort: '' } });
    assert.match(at('bogus'), /<h2[^>]*>Tokens<\/h2>/);
  });

  test('layout: a NavList of the five sections, a mobile select, the filter bar', () => {
    const html = at('time', 'range=7d&agent=swe&effort=low');
    const nav = html.match(/<nav aria-label="Insights sections"[^>]*>(.*?)<\/nav>/)[1];
    const links = [...nav.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)];
    assert.deepEqual(links.map((l) => l[2]), ['Tokens', 'Cost', 'Time', 'Quality', 'Throughput', 'Explore']);
    assert.match(links[2][0], /aria-current="page"/);
    assert.match(links[0][1], /^#\/insights\/tokens\?range=7d&amp;repo=&amp;agent=swe&amp;model=&amp;effort=low&amp;m=tokens_out&amp;x=tokens_out$/);
    assert.match(html, /class="max-md:hidden"/);
    assert.match(html, /<div class="md:hidden"><label[^>]*>Section<select/);
    assert.match(html, /Period<select[^>]*>.*<option value="7d" selected="">Last 7 days<\/option>/);
    assert.match(html, /Filters \(2\)/);
    assert.doesNotMatch(html, />Metric<select/);
    assert.match(at('tokens'), />Metric<select[^>]*><option value="tokens_out" selected="">Output tokens<\/option><option value="context">Context<\/option><option value="cache_hit">Cache-hit %<\/option><option value="tool_uses">Tool uses<\/option>/);
    assert.ok(html.includes(mod.EFFORT_CAPTION));
    for (const label of ['Repo', 'Agent', 'Model', 'Effort']) assert.match(html, new RegExp(`>${label}<select`));
  });

  test('every section renders its heading and charts, each SVG with role=img and a summary label', () => {
    for (const section of SECTIONS) {
      const html = at(section);
      assert.match(html, new RegExp(`<h2[^>]*>${section[0].toUpperCase()}${section.slice(1)}</h2>`), section);
      for (const svg of html.matchAll(/<svg width="\d+" height="\d+"[^>]*>/g)) {
        assert.match(svg[0], /role="img"/, section);
        assert.match(svg[0], /aria-label="[^"]+"/, section);
      }
    }
  });

  test('Tokens: agent cards with rank, measured line, stats and histogram; bro on its own scale', () => {
    const html = at('tokens');
    assert.match(html, /Rank 1 of 2 by average output tokens/);
    assert.match(html, /Tokens measured for 25 of 27 runs/);
    assert.match(html, /Tokens measured for 23 of 23 runs/);
    assert.match(html, /Tokens measured for 3 of 3 sessions/);
    assert.match(html, /Last 30 days · Per run · Runs by Output Tokens/);
    assert.match(html, /Last 30 days · Per session · Sessions by Output Tokens/);
    assert.ok(html.includes(mod.BRO_CAPTION));
    assert.match(html, /Early data · 3 of 20 runs/);
    assert.match(html, /p50 13K/);
    assert.match(html, /p95 24K/);
    const innerH = 224 - 36 - 24;
    const markers = [...html.matchAll(/<g data-marker="">(.*?)<\/g>/g)].map((m) => m[1]);
    assert.equal(markers.length, 4);
    const ys = (line) => [/ y1="([\d.-]+)"/, / y2="([\d.-]+)"/].map((re) => Number(re.exec(line)[1]));
    for (const g of markers) {
      const lines = [...g.matchAll(/<line[^>]*>/g)].map((m) => m[0]);
      assert.equal(lines.length, 2, 'one leader and one tick per marker');
      const leaders = lines.filter((l) => l.includes('data-marker-leader'));
      const ticks = lines.filter((l) => l.includes('data-marker-tick'));
      assert.equal(leaders.length, 1);
      assert.equal(ticks.length, 1);
      for (const line of lines) {
        assert.match(line, /stroke="var\(--fgColor-muted\)" stroke-width="1"/);
        const [y1, y2] = ys(line);
        assert.ok(!(Math.min(y1, y2) <= 0 && Math.max(y1, y2) >= innerH), 'no marker line spans the plot');
      }
      assert.deepEqual(ys(ticks[0]), [innerH, innerH + 4]);
      const [y1, y2] = ys(leaders[0]);
      assert.ok(y1 < 0 && y2 >= y1 && y2 < innerH, `leader ${y1}→${y2} drops from the band and stops above the baseline`);
    }
    assert.doesNotMatch(html, /stroke-dasharray/);
    const broCard = html.slice(html.indexOf('data-agent="bro"'));
    assert.doesNotMatch(broCard, /p50 \d|p95 \d|data-marker/);
    assert.match(html, /aria-label="swe, [^"]+ output tokens: \d+ runs?"/);
    assert.match(html, /Top runs by output tokens/);
    assert.match(html, /Top runs by context/);
    assert.match(html, /href="#\/tasks\/\d+"/);
  });

  test('Tokens: the Metric select switches the stats shown', () => {
    const html = at('tokens', 'range=30d&m=cache_hit');
    assert.match(html, /p50 Cache-hit %/);
    assert.match(html, /Rank \d of 2 by average cache-hit %/);
  });

  const decode = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
  const cardOf = (html, who) => {
    const start = html.indexOf(`data-agent="${who}"`);
    const ends = [html.indexOf('data-agent="', start + 1), html.indexOf('aria-label="Top runs', start)].filter((i) => i !== -1);
    return html.slice(start, Math.min(...ends));
  };
  const agentsShown = (html) => [...html.matchAll(/data-agent="([^"]+)"/g)].map((m) => m[1]);
  const sectionBody = (html, title) => html.slice(html.indexOf(`>${title}</h2>`));

  test('SC2: the Metric drives each card subtitle, table columns, aria label and bars', () => {
    const cases = [
      ['context', 'Context Size', ['From (Tokens)', 'To (Tokens)'], 'context'],
      ['cache_hit', 'Cache-Hit %', ['From (%)', 'To (%)'], 'cache-hit %'],
      ['tool_uses', 'Tool Uses', ['From (Uses)', 'To (Uses)'], 'tool uses'],
    ];
    for (const [m, by, cols, noun] of cases) {
      const html = at('tokens', `range=30d&m=${m}`);
      assert.ok(html.includes(`Last 30 days · Per run · Runs by ${by}`), m);
      assert.ok(html.includes(`Last 30 days · Per session · Sessions by ${by}`), m);
      for (const a of data.agents) {
        assert.deepEqual(mod.histogramTable(a, m).columns, [...cols, a.per === 'session' ? 'Sessions' : 'Runs'], `${m} ${a.agent}`);
        const card = cardOf(html, a.agent);
        assert.ok(!card.includes('output tokens'), `${m} ${a.agent}`);
        const label = /<svg width="\d+" height="\d+"[^>]*aria-label="([^"]+)"/.exec(card)[1];
        assert.ok(label.startsWith(`${a.agent} ${noun} per `), label);
        const bars = [...card.matchAll(new RegExp(`aria-label="${a.agent}, [^"]+ ${noun}: (\\d+) (?:runs?|sessions?)"`, 'g'))].map((x) => Number(x[1]));
        assert.deepEqual(bars, a.histograms[m].map((b) => b.count), `${m} ${a.agent}`);
      }
    }
    assert.deepEqual(mod.histogramTable(data.agents[0], 'cache_hit').rows.map((r) => [r[0], r[1]]), Array.from({ length: 10 }, (_, i) => [10 * i, 10 * i + 10]));
    const empty = structuredClone(data);
    empty.agents[0].histograms.context = [];
    const html = mod.page('#/insights/tokens?range=30d&m=context', empty);
    const swe = cardOf(html, 'swe');
    assert.ok(swe.includes('No context data in this period.'));
    assert.doesNotMatch(swe, /<svg width="\d+"/);
    assert.match(cardOf(html, 'code-reviewer'), /<svg width="\d+"/);
    assert.ok(!html.includes('No output tokens data'));
  });

  test('SC3: a filter hides the agents it leaves without runs on Tokens, Time and Cost; none left is one empty state', () => {
    const onlySwe = mod.insights(db, filter('range=30d&agent=swe'), NOW);
    const onlySwePriced = mod.insights(pricedDb, filter('range=30d&agent=swe'), NOW);
    const tokens = mod.page('#/insights/tokens?range=30d&agent=swe', onlySwe);
    assert.deepEqual(agentsShown(tokens), ['swe']);
    assert.doesNotMatch(tokens, /Rank \d of/);
    const bodies = [
      sectionBody(tokens, 'Tokens'),
      sectionBody(mod.page('#/insights/time?range=30d&agent=swe', onlySwe), 'Time'),
      sectionBody(mod.page('#/insights/cost?range=30d&agent=swe', onlySwePriced), 'Cost'),
    ];
    for (const body of bodies) {
      assert.doesNotMatch(body, /code-reviewer|\bbro\b/);
      assert.match(body, /\bswe\b/);
    }

    const modelDbPath = join(tmp, 'view-model.db');
    const { db: modelDb, ids } = seed(modelDbPath, JSON.stringify({ 'claude-swe-only': OPUS }));
    modelDb
      .prepare(
        `INSERT INTO agent_runs (task_id, agent_type, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, tool_uses, duration_ms, started_at, completed_at, usage_source, model)
         VALUES (?, 'swe', 10, 500, 100, 10, 4, 60000, ?, ?, 'subagent_stop', 'claude-swe-only')`,
      )
      .run(ids[0], NOW.toISOString(), NOW.toISOString());
    const byModel = mod.insights(modelDb, filter('range=30d&model=claude-swe-only'), NOW);
    modelDb.close();
    assert.deepEqual(byModel.agents.map((a) => a.total), [1, 0, 0]);
    for (const [section, title] of [['tokens', 'Tokens'], ['time', 'Time'], ['cost', 'Cost']]) {
      const body = sectionBody(mod.page(`#/insights/${section}?range=30d&model=claude-swe-only`, byModel), title);
      assert.doesNotMatch(body, /code-reviewer|\bbro\b/, section);
      assert.match(body, /\bswe\b/, section);
    }

    const none = mod.insights(db, filter('range=30d&model=nope'), NOW);
    for (const [section, title] of [['tokens', 'Tokens'], ['time', 'Time'], ['cost', 'Cost']]) {
      const html = mod.page(`#/insights/${section}?range=7d&repo=x&agent=swe&model=nope&effort=high&m=context`, mod.insights(pricedDb, filter('range=7d&repo=x&agent=swe&model=nope&effort=high'), NOW));
      const body = decode(sectionBody(html, title));
      assert.ok(body.includes(mod.NO_MATCH_HEADING), section);
      assert.ok(body.includes('Nothing in last 7 days matches Repo: x · Agent: swe · Model: nope · Effort: high.'), section);
      assert.equal(agentsShown(body).length, 0, section);
      assert.equal((body.match(/No Runs Match These Filters/g) ?? []).length, 1, section);
      const href = /<a href="([^"]+)"[^>]*>Clear Filters<\/a>/.exec(body)[1];
      const [path, query] = href.slice(2).split('?');
      const cleared = mod.parseInsightParams(path, new URLSearchParams(query));
      assert.deepEqual(cleared.filters, { repo: '', agent: '', model: '', effort: '' }, section);
      assert.deepEqual([cleared.section, cleared.range, cleared.metric], [section, '7d', 'context'], section);
    }
    assert.ok(decode(mod.page('#/insights/tokens?range=30d&model=nope', none)).includes('Nothing in last 30 days matches Model: nope.'));
    assert.deepEqual(mod.clearFilters({ ...onlySwe, filters: { repo: 'a', agent: 'swe', model: 'b', effort: 'low' } }).filters, { repo: '', agent: '', model: '', effort: '' });

    const all = at('tokens');
    assert.deepEqual(agentsShown(all), ['swe', 'code-reviewer', 'bro']);
    assert.match(all, /Rank 1 of 2/);
    assert.doesNotMatch(all, /No Runs Match/);
  });

  test('SC4: Quality and Throughput hide Agent and Model, with a caption only while one is set', () => {
    const caption = (html) => decode(html).includes(mod.TASK_LEVEL_CAPTION);
    for (const section of ['quality', 'throughput']) {
      const html = at(section, 'range=30d&repo=plugin&agent=swe&model=claude-opus&effort=high');
      assert.doesNotMatch(html, />Agent<select/, section);
      assert.doesNotMatch(html, />Model<select/, section);
      assert.match(html, />Repo<select/, section);
      assert.match(html, />Effort<select/, section);
      assert.ok(caption(html), section);
      assert.match(html, /href="#\/insights\/tokens\?range=30d&amp;repo=plugin&amp;agent=swe&amp;model=claude-opus&amp;effort=high/, section);
      assert.ok(caption(at(section, 'range=30d&model=claude-opus')), section);
      assert.ok(caption(at(section, 'range=30d&agent=swe')), section);
      assert.ok(!caption(at(section, 'range=30d&repo=plugin&effort=high')), section);
      assert.ok(!caption(at(section)), section);
    }
    const tokens = at('tokens', 'range=30d&agent=swe&model=claude-opus');
    assert.match(tokens, />Agent<select[^>]*>(?:<option[^>]*>[^<]*<\/option>)*<option value="swe" selected="">/);
    assert.match(tokens, />Model<select[^>]*>(?:<option[^>]*>[^<]*<\/option>)*<option value="claude-opus" selected="">/);
    assert.ok(!caption(tokens));
  });

  test('SC5: Metric is m and Measure is x; neither overwrites the other; a legacy explore m is the Measure', () => {
    const reparse = (hash) => {
      const [path, query] = hash.slice(2).split('?');
      return mod.parseInsightParams(path, new URLSearchParams(query));
    };
    const p = mod.parseInsightParams('insights/tokens', new URLSearchParams('m=context&x=duration_ms'));
    assert.deepEqual([p.metric, p.measure], ['context', 'duration_ms']);
    assert.match(mod.insightHash(p), /&m=context&x=duration_ms$/);
    for (const section of ['tokens', 'explore', 'quality']) {
      const back = reparse(mod.insightHash({ ...p, section }));
      assert.deepEqual([back.metric, back.measure], ['context', 'duration_ms'], section);
    }
    assert.equal(reparse(mod.insightHash({ ...p, metric: 'tool_uses' })).measure, 'duration_ms');
    assert.equal(reparse(mod.insightHash({ ...p, measure: 'cost' })).metric, 'context');
    const legacy = mod.parseInsightParams('insights/explore', new URLSearchParams('m=cost'));
    assert.equal(legacy.measure, 'cost');
    assert.match(mod.insightHash(legacy), /&x=cost$/);
    assert.equal(mod.parseInsightParams('insights/tokens', new URLSearchParams('m=context')).measure, 'tokens_out');
    assert.equal(mod.parseInsightParams('insights/explore', new URLSearchParams('m=context&x=cost')).measure, 'cost');
  });

  test('swe and code-reviewer histograms share one y scale; bro has its own', () => {
    const html = at('tokens');
    const cards = html.split('data-agent="').slice(1);
    assert.equal(cards.length, 3);
    const top = (card) => {
      const right = card.slice(card.indexOf('visx-axis-right'));
      return Math.max(...[...right.matchAll(/<tspan[^>]*>(\d+)<\/tspan>/g)].map((m) => Number(m[1])));
    };
    assert.ok(cards.every((card) => card.includes('visx-axis-right')));
    assert.equal(top(cards[0]), top(cards[1]));
    assert.notEqual(top(cards[2]), top(cards[0]));
  });

  test('axes: solid muted horizontal grid before the marks, the baseline the only axis line, no tick strokes or rotated title', () => {
    for (const section of ['throughput', 'tokens', 'quality']) {
      const html = at(section);
      const svgs = [...html.matchAll(/<svg width="\d+" height="224"[^>]*>(.*?)<\/svg><\/div>/gs)].map((m) => m[1]);
      assert.ok(svgs.length > 0, section);
      for (const svg of svgs) {
        const grid = svg.indexOf('visx-rows');
        assert.ok(grid >= 0 && grid < svg.indexOf('data-mark=""') || !svg.includes('data-mark'), section);
        assert.doesNotMatch(svg, /visx-columns/);
        const rows = svg.slice(grid, svg.indexOf('</g>', grid));
        for (const line of rows.matchAll(/<line[^>]*>/g)) assert.match(line[0], /stroke="var\(--borderColor-muted\)" stroke-width="1"/);
        const axisLines = [...svg.matchAll(/class="visx-line visx-axis-line"[^>]*>/g)].map((m) => m[0]);
        assert.equal(axisLines.length, 1, section);
        assert.match(axisLines[0], /stroke="var\(--borderColor-default\)"/);
        assert.doesNotMatch(svg, /visx-axis-tick">\s*<line|class="visx-line visx-axis-tick/);
        assert.doesNotMatch(svg, /rotate\(/);
        assert.doesNotMatch(svg, /stroke-dasharray/);
      }
      for (const tick of html.matchAll(/<text transform=""[^>]*>/g)) {
        assert.match(tick[0], /fill="var\(--fgColor-muted\)" font-size="11" style="font-variant-numeric:tabular-nums"/);
      }
    }
    assert.doesNotMatch(at('throughput'), /<circle/);
  });

  test('histogram: edge labels anchored start and end, at most innerW/56 of them', () => {
    const cards = at('tokens').split('data-agent="').slice(1);
    for (const card of cards) {
      const bottom = card.slice(card.indexOf('visx-axis-bottom'), card.indexOf('visx-axis-right'));
      const anchors = [...bottom.matchAll(/text-anchor="(\w+)"/g)].map((m) => m[1]);
      assert.ok(anchors.length >= 2 && anchors.length <= Math.floor((480 - 48) / 56), anchors.join());
      assert.equal(anchors[0], 'start');
      assert.equal(anchors.at(-1), 'end');
      assert.ok(anchors.slice(1, -1).every((a) => a === 'middle'));
    }
    const edges = Array.from({ length: 11 }, (_, i) => ({ at: i, label: String(i) }));
    const thin = mod.thinEdgeTicks(edges, 200);
    assert.ok(thin.length <= Math.floor(200 / 56));
    assert.deepEqual([thin[0].at, thin.at(-1).at], [0, 10]);
  });

  test('marks: histogram bars band - 2, other columns at most 24px wide, a 2px gap, washed fill, one cap per non-zero bar, full-band hit targets', () => {
    assert.equal(mod.barWidth(100), 24);
    assert.equal(mod.barWidth(13), 11);
    assert.equal(mod.barWidth(1), 0);
    assert.equal(mod.histBarWidth(100), 98);
    assert.equal(mod.histBarWidth(30), 28);
    assert.equal(mod.histBarWidth(2), 1);
    for (const section of ['throughput', 'tokens', 'quality', 'time']) {
      const html = at(section);
      for (const svg of html.matchAll(/<svg width="(\d+)" height="(\d+)" role="img"[^>]*>(.*?)<\/svg><\/div>/gs)) {
        const body = svg[3];
        const hits = [...body.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="transparent" data-hit="" tabindex="0"/g)];
        const contiguous = section === 'tokens' && svg[2] === '224';
        const marks = [...body.matchAll(/<g data-mark=""><path class="visx-bar-rounded" d="([^"]+)"([^>]*)><\/path><path d="([^"]+)"([^>]*)><\/path><\/g>/g)];
        assert.equal(marks.length, (body.match(/data-mark=""/g) ?? []).length, section);
        assert.equal((body.match(/data-cap=""/g) ?? []).length, marks.length, section);
        for (const [, bar, barAttrs, cap, capAttrs] of marks) {
          assert.match(barAttrs, /style="fill-opacity:var\(--chart-wash\)"/);
          assert.match(capAttrs, /fill="none" stroke="[^"]+" stroke-width="2" data-cap=""/);
          const [, mx, run, r] = /^M([\d.-]+),[\d.-]+ h([\d.-]+)\s*a([\d.]+),/.exec(bar);
          const across = Number(run) + 2 * Number(r);
          if (cap.includes('V')) {
            const [, v] = /v([\d.-]+)/.exec(bar.slice(bar.indexOf('a')));
            assert.equal(Number(v) + 2 * Number(r), 12, `${section}: slim bar 12px thick`);
          } else if (contiguous) {
            const band = Number(hits[0][3]);
            assert.ok(Math.abs(across - (band - 2)) < 1e-6 && across > 24, `${section} histogram bar ${across}px in a ${band}px band`);
            const left = Number(mx) - Number(r);
            assert.ok(hits.some((h) => Math.abs(Number(h[1]) + 1 - left) < 1e-6), `${section}: bar centred 1px inside its band`);
          } else {
            assert.ok(across <= 24, `${section} bar ${across}px`);
          }
        }
        assert.equal(hits.length, (body.match(/tabindex="0"/g) ?? []).length, `${section}: every tabindex=0 is a hit rect`);
        for (let i = 1; i < hits.length; i++) {
          const [prev, cur] = [hits[i - 1], hits[i]];
          if (prev[2] === cur[2]) assert.ok(Math.abs(Number(prev[1]) + Number(prev[3]) - Number(cur[1])) < 1e-6, `${section}: columns tile the plot`);
          else assert.ok(Math.abs(Number(prev[2]) + Number(prev[4]) - Number(cur[2])) < 1e-6, `${section}: rows tile the plot`);
        }
      }
    }
    const days = at('throughput');
    const zero = [...days.matchAll(/aria-label="([^"]+): 0 closed tasks"/g)].length;
    assert.equal((days.match(/data-cap=""/g) ?? []).length, 31 - zero);
  });

  test('histogram: 10 buckets at 480px draw innerW/10 - 2 bars, 1px inside each band, rounded on top only', () => {
    const edges = Array.from({ length: 11 }, (_, i) => 10 ** (3 + 0.3 * i));
    const counts = [1, 0, 2, 3, 5, 8, 12, 20, 30, 28];
    const buckets = counts.map((count, i) => ({ from: edges[i], to: edges[i + 1], count }));
    const svg = mod.histogramSvg({ label: 'swe', measure: 'output tokens', who: 'swe', noun: (n) => (n === 1 ? 'run' : 'runs'), buckets, color: 'var(--data-blue-color-emphasis)', p50: null, p95: null, format: mod.compact });
    const band = (480 - 8 - 40) / 10;
    const hits = [...svg.matchAll(/<rect x="([\d.]+)" y="0" width="([\d.]+)"[^>]*data-hit=""/g)].map((m) => Number(m[1]));
    assert.equal(hits.length, 10);
    const bars = [...svg.matchAll(/<path class="visx-bar-rounded" d="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(bars.length, 9);
    assert.equal((svg.match(/data-cap=""/g) ?? []).length, 9);
    const nonZero = counts.flatMap((c, i) => (c > 0 ? [i] : []));
    bars.forEach((d, k) => {
      const [, mx, run, r] = /^M([\d.-]+),[\d.-]+ h([\d.-]+)\s*a([\d.]+),/.exec(d);
      const across = Number(run) + 2 * Number(r);
      assert.ok(Math.abs(across - (band - 2)) < 1e-6 && across > 24, `bar ${across}px`);
      assert.ok(Math.abs(Number(mx) - Number(r) - (hits[nonZero[k]] + 1)) < 1e-6, `bar ${k} left edge 1px right of x(i)`);
      assert.equal((d.match(/a/g) ?? []).length, 2, 'only the top corners are rounded');
    });
  });

  test('marker labels: start-anchored, end-anchored in the right third, clamped, stacked when they collide', () => {
    const near = mod.placeMarkerLabels([{ x: 100, label: 'p50 13K' }, { x: 110, label: 'p95 24K' }], 400);
    assert.deepEqual(near.map((p) => [p.anchor, p.row]), [['start', 0], ['start', 1]]);
    const far = mod.placeMarkerLabels([{ x: 50, label: 'p50 13K' }, { x: 300, label: 'p95 24K' }], 400);
    assert.deepEqual(far.map((p) => [p.anchor, p.row, p.x]), [['start', 0, 50], ['end', 0, 300]]);
    const edge = mod.placeMarkerLabels([{ x: 400, label: 'p95 24K' }], 400)[0];
    assert.deepEqual([edge.anchor, edge.x, edge.right], ['end', 400, 400]);
    assert.ok(edge.left >= 0);
    const start = mod.placeMarkerLabels([{ x: 0, label: 'p50 1K' }], 400)[0];
    assert.deepEqual([start.anchor, start.left], ['start', 0]);
    for (const p of [...near, ...far, edge, start]) assert.ok(mod.labelBox(p).bottom < 0, 'labels sit above the plot');
  });

  test('marker labels near the right edge (bro card shape) sit in the band, clear of bars, y ticks and each other', () => {
    const edges = Array.from({ length: 11 }, (_, i) => Math.round(10 ** (3 + 0.3 * i)));
    const counts = [1, 0, 2, 3, 5, 8, 12, 20, 30, 28];
    const buckets = counts.map((count, i) => ({ from: edges[i], to: edges[i + 1], count }));
    const p50 = Math.sqrt(edges[8] * edges[9]);
    const p95 = 746_200;
    const svg = mod.histogramSvg({ label: 'bro', measure: 'output tokens', who: 'bro', noun: (n) => (n === 1 ? 'session' : 'sessions'), buckets, color: 'var(--data-blue-color-emphasis)', p50, p95, format: mod.compact });
    const innerW = 480 - 8 - 40;
    const [, gx, gy] = /<g class="visx-group" transform="translate\(([\d.]+), ([\d.]+)\)"/.exec(svg);
    assert.deepEqual([Number(gx), Number(gy)], [8, 36]);
    const labels = [...svg.matchAll(/<text x="([\d.-]+)" y="([\d.-]+)" text-anchor="(\w+)"[^>]*data-marker-label="">([^<]+)<\/text>/g)].map(([, x, y, anchor, text]) => {
      const w = text.length * 6.6;
      const left = anchor === 'end' ? Number(x) - w : Number(x);
      return { text, anchor, left, right: left + w, top: Number(y) - 11, bottom: Number(y) + 3 };
    });
    assert.deepEqual(labels.map((l) => [l.text, l.anchor]), [['p50 354.8K', 'end'], ['p95 746.2K', 'end']]);
    const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    assert.ok(!overlap(labels[0], labels[1]), 'the two labels stack instead of overlapping');
    assert.ok(labels[1].bottom <= labels[0].top, 'p95 sits on the band row above p50');
    for (const l of labels) {
      assert.ok(l.left >= 0 && l.right <= innerW, `${l.text} inside the plot x-range`);
      assert.ok(l.bottom < 0 && l.top >= -Number(gy), `${l.text} inside the band above the plot`);
    }
    const bars = [...svg.matchAll(/<path class="visx-bar-rounded" d="M([\d.-]+),([\d.-]+) /g)].map((m) => Number(m[2]));
    assert.equal(bars.length, 9);
    assert.ok(bars.every((y) => y >= 0), 'every bar stays below the band');
    const [, axisX] = /class="visx-group visx-axis visx-axis-right" transform="translate\(([\d.]+), 0\)"/.exec(svg);
    assert.equal(Number(axisX), innerW);
    const ticks = [...svg.slice(svg.indexOf('visx-axis-right')).matchAll(/<svg x="([\d.-]+)"[^>]*><text transform="" x="([\d.-]+)"[^>]*text-anchor="start"/g)];
    assert.ok(ticks.length >= 2);
    for (const [, dx, x] of ticks) {
      assert.ok(Number(axisX) + Number(dx) + Number(x) > Math.max(...labels.map((l) => l.right)), 'y tick labels stay right of every marker label');
    }
  });

  test('marker leaders: drop from under the label to 4px above the bar they touch, on a crisp pixel', () => {
    const innerH = 164;
    const leader = (x, labelBottom, bars) => mod.markerLeader({ x, labelBottom, bars, innerH });
    const over = leader(15, -3, [{ left: 10, right: 20, top: 60 }]);
    assert.deepEqual([over.y1, over.y2], [-1, 56]);
    assert.equal(leader(50, -3, [{ left: 10, right: 20, top: 60 }]).y2, innerH - 4);
    assert.equal(leader(50, -3, []).y2, innerH - 4);
    const gap = [{ left: 0, right: 10, top: 80 }, { left: 12, right: 22, top: 40 }];
    assert.equal(leader(11, -3, gap).y2, 36, 'a marker mid-gap clears the taller neighbour');
    for (const x of [10.5, 11.5]) assert.equal(leader(x, -3, gap).y2, 36);
    assert.equal(leader(5, -3, gap).y2, 76, 'inside the shorter bar, away from the gap');
    const tall = leader(15, -3, [{ left: 10, right: 20, top: -10 }]);
    assert.equal(tall.y2, tall.y1, 'a bar above the label leaves a zero-length leader');
    for (const x of [15, 15.2, 15.5, 15.7, 0, 431.9]) assert.equal(leader(x, -3, []).x, Math.round(x) + 0.5);
  });

  test('marker leaders in the rendered histogram start under their labels and stop above the bars', () => {
    const edges = Array.from({ length: 11 }, (_, i) => Math.round(10 ** (3 + 0.3 * i)));
    const counts = [1, 0, 2, 3, 5, 8, 12, 20, 30, 28];
    const buckets = counts.map((count, i) => ({ from: edges[i], to: edges[i + 1], count }));
    for (const [p50, p95] of [[Math.sqrt(edges[8] * edges[9]), 746_200], [edges[3], edges[7]], [edges[1] * 1.1, edges[9]]]) {
      const svg = mod.histogramSvg({ label: 'swe', measure: 'output tokens', who: 'swe', noun: (n) => (n === 1 ? 'run' : 'runs'), buckets, color: 'var(--data-blue-color-emphasis)', p50, p95, format: mod.compact });
      const bars = [...svg.matchAll(/<path class="visx-bar-rounded" d="M([\d.-]+),([\d.-]+) h([\d.-]+)\s*a([\d.]+),/g)].map(([, mx, my, run, r]) => {
        const left = Number(mx) - Number(r);
        return { left, right: left + Number(run) + 2 * Number(r), top: Number(my) };
      });
      assert.equal(bars.length, 9);
      const groups = [...svg.matchAll(/<g data-marker="">(.*?)<\/g>/g)].map((m) => m[1]);
      assert.equal(groups.length, 2);
      for (const g of groups) {
        const [lx, y1, y2] = /<line[^>]*x1="([\d.-]+)" y1="([\d.-]+)" x2="[\d.-]+" y2="([\d.-]+)"[^>]*data-marker-leader=""/.exec(g).slice(1).map(Number);
        const [, x, baseline, anchor, text] = /<text x="([\d.-]+)" y="([\d.-]+)" text-anchor="(\w+)"[^>]*>([^<]+)<\/text>/.exec(g);
        const w = text.length * 6.6;
        const left = anchor === 'end' ? Number(x) - w : Number(x);
        const bottom = mod.labelBox({ x: Number(x), anchor, left, right: left + w, row: 0, baseline: Number(baseline) }).bottom;
        assert.ok(y1 >= bottom, `${text}: leader y1 ${y1} at or below the label bottom ${bottom}`);
        assert.equal(lx % 1, 0.5, `${text}: leader on a half pixel`);
        for (const b of bars.filter((b) => b.left < lx + 0.5 && b.right > lx - 0.5)) assert.ok(y2 <= b.top - 4 || (y2 === y1 && b.top - 4 < y1), `${text}: leader ends ${y2}, 4px above the bar top ${b.top} or zero-length`);
      }
    }
  });

  test('duration ticks step through 1s … 2h with integer labels', () => {
    const labels = (ms) => mod.durationTicks(ms).ticks.map((t) => t.label);
    assert.deepEqual(labels(9 * 60_000), ['0', '5m', '10m']);
    assert.deepEqual(labels(14_000), ['0', '5s', '10s', '15s']);
    assert.deepEqual(labels(50 * 60_000), ['0', '15m', '30m', '45m', '60m']);
    assert.deepEqual(labels(3.5 * 3_600_000), ['0', '1h', '2h', '3h', '4h']);
    for (const ms of [800, 42_000, 13 * 60_000, 7 * 3_600_000]) {
      const { top, ticks } = mod.durationTicks(ms);
      assert.ok(top >= ms && ticks.length <= 5, String(ms));
      for (const t of ticks) assert.match(t.label, /^(0|\d+[smh])$/);
    }
  });

  test('Throughput: focusable columns labelled by day', () => {
    const html = at('throughput');
    const bars = [...html.matchAll(/<rect [^>]*tabindex="0"[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(bars.length, 31);
    const today = new Date(NOW).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    assert.ok(bars.includes(`${today}: 2 closed tasks`), bars.slice(-3).join(' | '));
  });

  test('Time: duration and tool uses, bro separate, duration outliers', () => {
    const html = at('time');
    for (const title of ['Duration per run', 'Tool uses per run', 'bro duration per session', 'bro tool uses per session', 'Top runs by duration']) assert.ok(html.includes(title), title);
    assert.match(html, /aria-label="swe: average [^"]+ over 25 runs"/);
    const cards = html.split('data-chart-card=""').slice(1);
    assert.equal(cards.length, 4);
    for (const card of cards.slice(0, 2)) {
      assert.equal((card.match(/data-tile=""/g) ?? []).length, 2);
      assert.equal((card.match(/data-hit=""/g) ?? []).length, 2);
      assert.match(card, /<dt[^>]*>p50<\/dt>.*<dt[^>]*>p95<\/dt>.*<dt[^>]*>max<\/dt>/s);
      assert.match(card, /<text x="0" y="12" fill="var\(--fgColor-default\)" font-size="12">swe<\/text>/);
      assert.doesNotMatch(card, /height="224"/);
    }
    assert.match(cards[0], /Per run · duration; bars show the average/);
    assert.match(cards[0], />0<\/tspan>.*>\d+m<\/tspan>/s);
    for (const card of cards.slice(2)) {
      assert.equal((card.match(/data-tile=""/g) ?? []).length, 1);
      assert.doesNotMatch(card, /<svg width/);
    }
  });

  test('outlier tables fit: the Title and Command cells truncate with the full text in title, numbers stay on one line', () => {
    const long = `Title ${'x'.repeat(114)}`;
    assert.equal(long.length, 120);
    const [first, ...rest] = data.outliers.duration_ms;
    const html = mod.page('#/insights/time?range=30d', { ...data, outliers: { ...data.outliers, duration_ms: [{ ...first, task_title: long }, ...rest] } });
    const top = html.slice(html.indexOf('aria-label="Top runs by duration"'));
    const cell = new RegExp(`<td class="([^"]*)" title="${long}">`).exec(top);
    assert.ok(cell, 'the title cell carries the full title');
    assert.match(cell[1], /(^| )truncate( |$)/);
    assert.match(cell[1], /(^| )max-w-0( |$)/);
    assert.match(cell[1], /(^| )w-full( |$)/);
    const firstRow = top.slice(top.indexOf('<tbody>'), top.indexOf('</tr>', top.indexOf('<tbody>')));
    assert.equal((firstRow.match(/class="whitespace-nowrap tabular-nums"|class="inline-flex items-center gap-2 whitespace-nowrap tabular-nums"/g) ?? []).length, 4);
    const quality = at('quality');
    const slow = quality.slice(quality.indexOf('aria-label="Slowest verification commands"'));
    assert.match(slow, /<td class="[^"]*w-full min-w-32 max-w-0 truncate[^"]*" title="node --test">/);
    for (const kind of ['Top runs by output tokens', 'Top runs by context']) {
      const t = at('tokens').slice(at('tokens').indexOf(`aria-label="${kind}"`));
      assert.match(t, /<td class="[^"]*w-full min-w-32 max-w-0 truncate[^"]*" title="Task [abc]">/, kind);
    }
  });

  test('Time: duration outliers show tool uses and output tokens, with the idle caption', () => {
    const html = at('time');
    const top = html.slice(html.indexOf('aria-label="Top runs by duration"'));
    assert.match(top, />Tool uses<.*>Output tokens</s);
    assert.ok(top.includes(mod.IDLE_CAPTION));
    assert.equal(mod.IDLE_CAPTION, 'Likely idle: over 30 min with under 1 tool use and 500 output tokens a minute. Listed last.');
  });

  test('Quality: first-pass rate, attempts, stacked verdict mix, verification rate, slowest commands', () => {
    const html = at('quality');
    assert.match(html, /First-pass rate.*?33\.3%/s);
    assert.match(html, /1 of 3 tasks passed review on the first attempt/);
    assert.match(html, /role="img" aria-label="Review verdicts: Pass 2, Fail 1, Escalate 1 of 4"/);
    assert.match(html, /Verification pass rate.*?66\.7%/s);
    assert.match(html, /aria-label="1 attempt: 2 tasks"/);
    assert.match(html, /Slowest verification commands.*node --test.*bun run build/s);
  });

  test('Cost, no prices: only the Flash, and no "$" anywhere in Insights', () => {
    const html = at('cost');
    assert.ok(html.includes(mod.NO_PRICES));
    assert.doesNotMatch(html, /data-chart-card/);
    for (const section of SECTIONS) assert.ok(!at(section).includes('$'), section);
  });

  test('Cost, priced: USD columns by agent and model, unpriced runs flagged', () => {
    const html = mod.page('#/insights/cost?range=30d', priced);
    assert.ok(!html.includes(mod.NO_PRICES));
    assert.match(html, /Cost by agent/);
    assert.match(html, /Cost by model/);
    assert.match(html, /aria-label="swe: \$[\d,.]+ over 25 runs"/);
    assert.match(html, /23 measured runs have no price/);
    const cards = html.split('data-chart-card=""').slice(1);
    const byTitle = (t) => cards.find((c) => c.includes(`>${t}</h3>`));
    for (const t of ['Cost by agent', 'Cost by model']) {
      assert.doesNotMatch(byTitle(t), /height="224"/, t);
      assert.match(byTitle(t), /data-cap=""/, t);
    }
    assert.match(byTitle('bro cost'), /data-tile=""/);
    assert.doesNotMatch(byTitle('bro cost'), /<svg width/);
  });

  test('ChartCard: h3, subheader, kebab menu with both actions, legend only for 2+ series', () => {
    const t = { columns: ['Day', 'Closed'], rows: [['2026-10-24', 1]] };
    const one = mod.card({ title: 'T', subtitle: 'Last 7 days · tasks', section: 'throughput', range: '7d', table: t, legend: [{ label: 'a', color: 'red' }] });
    assert.match(one, /<h3[^>]*>T<\/h3><p[^>]*>Last 7 days · tasks<\/p>/);
    assert.match(one, /<button[^>]*aria-label="T options"[^>]*aria-haspopup="menu"/);
    assert.match(one, /role="menuitem"[^>]*>.*?View as table<\/button>/);
    assert.match(one, /role="menuitem"[^>]*>.*?Download CSV<\/button>/);
    assert.doesNotMatch(one, /aria-label="Legend"/);
    const two = mod.card({ title: 'T', subtitle: 's', section: 'x', range: '7d', table: t, legend: [{ label: 'a', color: 'red' }, { label: 'b', color: 'blue' }] });
    assert.match(two, /aria-label="Legend"/);
    const tabled = mod.card({ title: 'T', subtitle: 's', section: 'x', range: '7d', table: t, defaultTable: true });
    assert.match(tabled, /<caption tabindex="-1"[^>]*>T, s<\/caption>/);
    assert.match(tabled, /View as chart/);
    assert.doesNotMatch(tabled, /<svg role="img"/);
  });

  test('the CSV body equals the table cells, quoted per RFC 4180', () => {
    const t = { columns: ['Command', 'p95'], rows: [['bun run "build", fast', 12.5], ['node --test', 60]] };
    const html = mod.table('cap', t);
    const decode = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
    const head = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => decode(m[1]));
    const cells = [...html.matchAll(/<tr[^>]*>((?:<td[^>]*>[^<]*<\/td>)+)<\/tr>/g)].map((r) => [...r[1].matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((m) => decode(m[1])));
    const csv = mod.toCsv(t);
    const parse = (text) =>
      text.split('\r\n').map((line) => [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)].filter((m) => m.index < line.length || m[1] !== '').map((m) => (m[1].startsWith('"') ? m[1].slice(1, -1).replace(/""/g, '"') : m[1])));
    assert.deepEqual(parse(csv), [head, ...cells]);
    assert.equal(csv.split('\r\n')[1], '"bun run ""build"", fast",12.5');
    assert.equal(mod.csvName('quality', '90d'), 'insights-quality-90d.csv');
  });

  test('numbers use tabular-nums', () => {
    assert.match(at('quality'), /text-2xl font-semibold text-fg tabular-nums/);
    assert.match(at('tokens'), /<svg[^>]*class="[^"]*tabular-nums/);
  });
});

describe('build and bundle', () => {
  const BASELINE = {
    '@primer/octicons-react': '19.15.0',
    '@primer/primitives': '11.10.0',
    '@tailwindcss/cli': '^4.1.0',
    '@tanstack/react-query': '^5.0.0',
    '@tanstack/react-table': '^8.20.0',
    '@types/node': '^22.0.0',
    '@types/react': '^19.0.0',
    '@types/react-dom': '^19.0.0',
    esbuild: '^0.28.0',
    react: '^19.0.0',
    'react-dom': '^19.0.0',
    'react-markdown': '^10.1.0',
    'remark-gfm': '^4.0.1',
    tailwindcss: '^4.1.0',
    typescript: '^5.4.0',
  };
  const VISX = ['scale', 'shape', 'axis', 'grid', 'group', 'brush', 'tooltip', 'responsive', 'glyph'];

  test('devDependencies are the dev baseline plus exactly the nine @visx packages at 4.0.0', () => {
    const pkg = JSON.parse(readFileSync(join(DASH, 'package.json'), 'utf8'));
    const expected = { ...BASELINE, ...Object.fromEntries(VISX.map((p) => [`@visx/${p}`, '4.0.0'])) };
    assert.deepEqual(Object.fromEntries(Object.entries(pkg.devDependencies).sort()), Object.fromEntries(Object.entries(expected).sort()));
    assert.equal(pkg.dependencies, undefined);
    const lock = readFileSync(join(DASH, 'bun.lock'), 'utf8');
    for (const p of VISX) assert.ok(lock.includes(`"@visx/${p}": "4.0.0"`), p);
    assert.ok(!lock.includes('"@visx/xychart"'));
  });

  test('the build emits app.js and a lazy chunk holding Insights-only code', () => {
    const app = readFileSync(join(WEB, 'app.js'), 'utf8');
    const chunks = readdirSync(join(WEB, 'chunks')).filter((f) => f.endsWith('.js'));
    assert.ok(chunks.length >= 1);
    const marker = 'Cost tracking is off';
    assert.ok(!app.includes(marker));
    assert.ok(chunks.some((c) => readFileSync(join(WEB, 'chunks', c), 'utf8').includes(marker)));
    assert.match(app, /import\("\.\/chunks\/InsightsView-[A-Z0-9]+\.js"\)/);
    assert.match(readFileSync(join(WEB, 'index.html'), 'utf8'), /<script type="module" src="\/app\.js"><\/script>/);
  });

  test('size-budget.sh passes on the build and fails on a 61 KiB chunk', () => {
    const ok = spawnSync('bash', [join(DASH, 'test/size-budget.sh')], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /app\.js\s+\d+ B gz/);
    const copy = join(tmp, 'web');
    cpSync(WEB, copy, { recursive: true });
    let body = randomBytes(46 * 1024).toString('base64');
    while (gzipSync(body, { level: 9 }).length < 61 * 1024) body += randomBytes(256).toString('base64');
    writeFileSync(join(copy, 'chunks/synthetic.js'), body);
    const bad = spawnSync('bash', [join(DASH, 'test/size-budget.sh'), copy], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /chunks\/synthetic\.js/);
    assert.match(bad.stderr, /chunks\/synthetic\.js is \d+ B gzipped, over the 61440 B per-chunk budget/);
  });

  test('every --data-*-color-emphasis Insights uses is at least 3:1 on --bgColor-default, light and dark', () => {
    const css = readFileSync(join(DASH, 'web/theme/primer-tokens.css'), 'utf8');
    const src = readdirSync(join(DASH, 'web/views/insights')).map((f) => readFileSync(join(DASH, 'web/views/insights', f), 'utf8')).join('\n');
    const used = [...new Set([...src.matchAll(/--data-[a-z]+-color-emphasis/g)].map((m) => m[0]))];
    assert.ok(used.length >= 3, used.join());
    const block = (selector) => {
      const start = css.indexOf(`${selector},`);
      assert.ok(start >= 0, selector);
      return css.slice(start, css.indexOf('}', start));
    };
    const value = (b, name) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`).exec(b)?.[1];
    const lum = (hex) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a, b) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const rgb = (hex) => [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
    // Machado, Oliveira & Fernandes 2009, severity 1.0, applied in linear RGB.
    const MACHADO = {
      protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
      deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
    };
    const simulate = (c, m) => m.map((row) => Math.min(1, Math.max(0, row[0] * c[0] + row[1] * c[1] + row[2] * c[2])));
    const oklab = ([r, g, b]) => {
      const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
      const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
      const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
      return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
    };
    const deltaE = (p, q) => 100 * Math.hypot(...p.map((v, i) => v - q[i]));
    const cvdDelta = (a, b) => Math.min(...Object.values(MACHADO).map((m) => deltaE(oklab(simulate(rgb(a), m)), oklab(simulate(rgb(b), m)))));
    const agents = Object.values(mod.AGENT_COLOR).map((v) => /--data-[a-z]+-color-emphasis/.exec(v)[0]);
    const floors = {};
    for (const [mode, selector] of [['light', '[data-color-mode="light"][data-light-theme="light"]'], ['dark', '[data-color-mode="dark"][data-dark-theme="dark"]']]) {
      const b = block(selector);
      const bg = value(b, '--bgColor-default');
      assert.equal(bg, mode === 'light' ? '#ffffff' : '#0d1117');
      for (const name of used) {
        const fg = value(b, name);
        assert.ok(fg, `${name} missing in ${mode}`);
        assert.ok(contrast(fg, bg) >= 3, `${name} ${fg} on ${bg} (${mode}) is ${contrast(fg, bg).toFixed(2)}:1`);
      }
      let floor = Infinity;
      for (let i = 0; i < agents.length; i++) {
        for (let j = i + 1; j < agents.length; j++) {
          const d = cvdDelta(value(b, agents[i]), value(b, agents[j]));
          assert.ok(d >= 8, `${agents[i]} vs ${agents[j]} (${mode}) CVD ΔE ${d.toFixed(1)} < 8`);
          floor = Math.min(floor, d);
        }
      }
      floors[mode] = Math.round(floor * 10) / 10;
    }
    assert.deepEqual(floors, { light: 14.3, dark: 15.7 });
  });

  test('agent palette: swe pink, code-reviewer orange, bro blue', () => {
    assert.deepEqual(mod.AGENT_COLOR, {
      swe: 'var(--data-pink-color-emphasis)',
      'code-reviewer': 'var(--data-orange-color-emphasis)',
      bro: 'var(--data-blue-color-emphasis)',
    });
  });

  test('the chunk holding Insights-only code is at most 55 KiB gzipped', () => {
    const chunks = readdirSync(join(WEB, 'chunks')).filter((f) => readFileSync(join(WEB, 'chunks', f), 'utf8').includes(mod.COST_HELP));
    assert.equal(chunks.length, 1, chunks.join());
    const [chunk] = chunks;
    const size = gzipSync(readFileSync(join(WEB, 'chunks', chunk)), { level: 9 }).length;
    assert.ok(size <= 56_320, `${chunk} is ${size} B gzipped`);
  });

  test('the web tree has no hex colour under views/insights', () => {
    const grep = spawnSync('grep', ['-rnE', '#[0-9a-fA-F]{3,8}\\b', join(DASH, 'web/views/insights')], { encoding: 'utf8' });
    assert.equal(grep.status, 1, grep.stdout);
  });
});
