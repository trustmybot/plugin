// Insights test: seed a temp trajectory DB from schema.sql with 25 measured
// swe runs (plus unmeasured ones and one outside the range), 21 pr-reviewer and
// 2 code-reviewer runs, 3 bro sessions, review verdicts, verification runs and
// closed tasks. Check GET /api/insights over HTTP (shape, 400 on a bad range or
// agent) and insights() directly against hand-computed values, priced and
// unpriced. Then bundle the Insights view with esbuild, render every section to
// static HTML from that data and check the hash round-trip, ChartCard parts,
// cost honesty, the CSV/table match and the chart accessibility. Last, check
// the build output (lazy chunk, size budget, devDependencies) and the contrast
// of the --data-* colours Insights uses.
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
  REVIEWER.forEach((r, i) => add(ids[i % 3], i < 21 ? 'pr-reviewer' : 'code-reviewer', r, 'subagent_stop', 'claude-sonnet', ago(i * HOUR)));
  BRO.forEach((r, i) => add(null, 'bro', r, 'transcript', 'claude-opus', ago(i * HOUR)));
  add(ids[0], 'bro', { in: 1, out: 555_555, cr: 1, cc: 1, ms: 1, tools: 1 }, 'transcript', 'claude-opus', ago(HOUR));
  const attempt = db.prepare("INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, created_at) VALUES (?, ?, 'pr-reviewer', ?, 1, ?)");
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
      contents: `import { renderToStaticMarkup } from 'react-dom/server';
        import { createElement } from 'react';
        import { insights, insightFilter, nearestRank, metric, logEdges, histogram } from './server/queries.ts';
        import { InsightsLayout } from './web/views/insights/InsightsView.tsx';
        import { parseInsightParams, insightHash } from './web/views/insights/params.ts';
        import { ChartCard, DataTableView } from './web/views/insights/ChartCard.tsx';
        import { toCsv, csvName } from './web/views/insights/csv.ts';
        import { NO_PRICES, EFFORT_CAPTION, BRO_CAPTION } from './web/views/insights/sections.tsx';
        const withHash = (hash, fn) => {
          globalThis.window = { location: { hash }, history: { replaceState() {} }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
          try { return fn(); } finally { delete globalThis.window; }
        };
        export const page = (hash, data) => withHash(hash, () => {
          const [path, query = ''] = hash.replace(/^#\\/?/, '').split('?');
          return renderToStaticMarkup(createElement(InsightsLayout, { params: parseInsightParams(path, new URLSearchParams(query)), q: { data, error: null } }));
        });
        export const table = (caption, t) => renderToStaticMarkup(createElement(DataTableView, { caption, table: t }));
        export const card = (props) => renderToStaticMarkup(createElement(ChartCard, props, createElement('svg', { role: 'img', 'aria-label': 'x' })));
        export { insights, insightFilter, nearestRank, metric, logEdges, histogram, parseInsightParams, insightHash, toCsv, csvName, NO_PRICES, EFFORT_CAPTION, BRO_CAPTION };`,
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
    assert.deepEqual(body.agents.map((a) => a.agent), ['swe', 'reviewer', 'bro']);
    assert.equal(body.range.key, '30d');
  });

  test('a bad agent or range is 400; the default range is 30d', async () => {
    for (const q of ['agent=bogus', 'range=bogus', 'range=1y', 'agent=pr-reviewer']) {
      const res = await fetch(`${server.url}api/insights?${q}`);
      assert.equal(res.status, 400, q);
      assert.match((await res.json()).error, /must be one of/);
    }
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

  test('reviewer is pr-reviewer and code-reviewer together', () => {
    const reviewer = agent(data(), 'reviewer');
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

  test('histograms have at most 10 log-spaced buckets covering every measured run', () => {
    const d = data();
    for (const a of d.agents) {
      assert.ok(a.histogram.length <= 10, a.agent);
      assert.equal(sum(a.histogram, (b) => b.count), a.n, a.agent);
      for (let i = 1; i < a.histogram.length; i++) assert.equal(a.histogram[i].from, a.histogram[i - 1].to);
    }
    assert.deepEqual(agent(d, 'swe').histogram.map((b) => b.from), agent(d, 'reviewer').histogram.map((b) => b.from));
    const edges = mod.logEdges([1, 10_000]);
    assert.equal(edges.length, 11);
    assert.ok(Math.abs(edges[5] - 100) <= 1);
  });

  test('range and agent filters', () => {
    assert.equal(agent(mod.insights(db, filter('range=all'), NOW), 'swe').n, 26);
    const onlySwe = mod.insights(db, filter('agent=swe'), NOW);
    assert.deepEqual(onlySwe.agents.map((a) => a.n), [25, 0, 0]);
    assert.deepEqual(filter('agent=bogus'), { error: 'agent must be one of swe, reviewer, bro' });
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
      assert.equal(cost.by_agent.find((a) => a.agent === 'reviewer'), undefined);
      assert.deepEqual(cost.by_model, [{ model: 'claude-opus', usd: usd([...SWE, ...BRO]), runs: 28 }]);
    } finally {
      priced.close();
    }
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
    const params = { section: 'quality', range: '90d', metric: 'cache_hit', filters: { repo: 'plugin', agent: 'reviewer', model: 'claude-opus', effort: 'high' } };
    const hash = mod.insightHash(params);
    assert.equal(hash, '#/insights/quality?range=90d&repo=plugin&agent=reviewer&model=claude-opus&effort=high&m=cache_hit');
    const [path, query] = hash.slice(2).split('?');
    assert.deepEqual(mod.parseInsightParams(path, new URLSearchParams(query)), params);
    assert.equal(mod.parseInsightParams('insights/bogus', new URLSearchParams('range=nope&m=nope')).section, 'tokens');
    assert.deepEqual(mod.parseInsightParams('insights', new URLSearchParams()), { section: 'tokens', range: '30d', metric: 'tokens_out', filters: { repo: '', agent: '', model: '', effort: '' } });
    assert.match(at('bogus'), /<h2[^>]*>Tokens<\/h2>/);
  });

  test('layout: a NavList of the five sections, a mobile select, the filter bar', () => {
    const html = at('time', 'range=7d&agent=swe&effort=low');
    const nav = html.match(/<nav aria-label="Insights sections"[^>]*>(.*?)<\/nav>/)[1];
    const links = [...nav.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)];
    assert.deepEqual(links.map((l) => l[2]), ['Tokens', 'Cost', 'Time', 'Quality', 'Throughput']);
    assert.match(links[2][0], /aria-current="page"/);
    assert.match(links[0][1], /^#\/insights\/tokens\?range=7d&amp;repo=&amp;agent=swe&amp;model=&amp;effort=low&amp;m=tokens_out$/);
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
    assert.match(html, /Last 30 days · Per session · output tokens/);
    assert.ok(html.includes(mod.BRO_CAPTION));
    assert.match(html, /Early data · 3 of 20 runs/);
    assert.match(html, /p50 13K/);
    assert.match(html, /p95 24K/);
    assert.match(html, /<line[^>]*stroke="var\(--fgColor-default\)"[^>]*stroke-width="2"[^>]*stroke-dasharray="6 4"/);
    const broCard = html.slice(html.indexOf('data-agent="bro"'));
    assert.doesNotMatch(broCard, /p50 \d|p95 \d|stroke-dasharray="6 4"/);
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

  test('swe and reviewer histograms share one y scale; bro has its own', () => {
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

  test('axes: y on the right with a rotated unit, Primer strokes, dashed muted gridlines, no dots', () => {
    const html = at('throughput');
    assert.match(html, /visx-axis-right/);
    assert.match(html, /<text[^>]*transform="rotate\(90\)"[^>]*>.*?Tasks/s);
    assert.match(html, /class="visx-line visx-axis-line"[^>]*stroke="var\(--borderColor-emphasis\)"/);
    assert.match(html, /visx-rows[^]*?stroke="var\(--borderColor-muted\)"[^>]*stroke-dasharray="4 4"/);
    assert.match(html, /fill="var\(--fgColor-muted\)"/);
    assert.doesNotMatch(html, /<circle/);
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
    const decode = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'");
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
    for (const [mode, selector] of [['light', '[data-color-mode="light"][data-light-theme="light"]'], ['dark', '[data-color-mode="dark"][data-dark-theme="dark"]']]) {
      const b = block(selector);
      const bg = value(b, '--bgColor-default');
      for (const name of used) {
        const fg = value(b, name);
        assert.ok(fg, `${name} missing in ${mode}`);
        assert.ok(contrast(fg, bg) >= 3, `${name} ${fg} on ${bg} (${mode}) is ${contrast(fg, bg).toFixed(2)}:1`);
      }
    }
  });

  test('the web tree has no hex colour under views/insights', () => {
    const grep = spawnSync('grep', ['-rnE', '#[0-9a-fA-F]{3,8}\\b', join(DASH, 'web/views/insights')], { encoding: 'utf8' });
    assert.equal(grep.status, 1, grep.stdout);
  });
});
