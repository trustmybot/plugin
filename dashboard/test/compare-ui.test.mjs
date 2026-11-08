// Compare UI test: unit-test the period slices (parse, key, label, defaults),
// the hash keys p1/p2, the picker drafts and the delta text and colour. Then
// seed a temp trajectory DB from schema.sql (tasks 1–2 about 45 days ago,
// tasks 3–5 in the last two days, bro sessions), build the comparison with
// compare() directly, render Insights Tokens, Cost, Time, Quality and
// Throughput in compare mode to static HTML and check the Per Task strip, the
// agent table, the dashed Period 1 outline, the legend kinds, the paired cost
// and time rows, the rate tiles in points, the per-period throughput charts,
// the bro captions and tile, the empty states and the note on Efficiency.
// Explore is built with exploreCompare() and checked for the Pivot, the paired
// table with its Change column, the paired bars and the compare API path.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
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
const PRICES = JSON.stringify({ 'claude-opus': { input: 15, output: 75, cache_read: 1.5, cache_creation: 18.75 } });

const RUNS = [
  { task: 1, agent: 'swe', out: 1000, at: 45 * DAY },
  { task: 1, agent: 'swe', out: 3000, at: 45 * DAY - HOUR },
  { task: 2, agent: 'code-reviewer', out: 500, at: 44 * DAY, model: 'claude-sonnet' },
  { task: 2, agent: 'swe', out: 2000, at: 44 * DAY },
  { task: 3, agent: 'swe', out: 6000, at: 2 * DAY },
  { task: 3, agent: 'code-reviewer', out: 1000, at: 2 * DAY, model: 'claude-sonnet' },
  { task: 4, agent: 'swe', out: 4000, at: DAY },
  { task: 5, agent: 'swe', out: 2000, at: HOUR },
  { task: null, agent: 'bro', out: 90_000, at: 45 * DAY, source: 'transcript' },
  { task: null, agent: 'bro', out: 40_000, at: DAY, source: 'transcript' },
];

function seed(path, prices = '{}') {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  db.prepare(`UPDATE plugin_config SET value_json = ? WHERE key = 'model_prices'`).run(prices);
  const now = NOW.toISOString();
  const issue = Number(db.prepare('INSERT INTO issues (objective, created_at, updated_at) VALUES (?, ?, ?)').run('Compare UI issue', now, now).lastInsertRowid);
  const task = db.prepare("INSERT INTO tasks (id, issue_id, branch_id, title, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'd', 'running', ?, ?)");
  for (const id of [1, 2, 3, 4, 5]) task.run(id, issue, `feat/t${id}`, `Task ${id}`, now, now);
  const run = db.prepare(
    `INSERT INTO agent_runs (task_id, agent_type, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens,
       tool_uses, duration_ms, started_at, completed_at, usage_source, model)
     VALUES (?, ?, 500, ?, 1000, 100, 3, 60000, ?, ?, ?, ?)`,
  );
  for (const r of RUNS) run.run(r.task, r.agent, r.out, ago(r.at), ago(r.at), r.source ?? 'subagent_stop', r.model ?? 'claude-opus');
  return db;
}

// Period 1 (tasks 1–2): task 1 passes first time, task 2 fails then passes,
// one of two verifications passes. Period 2 (tasks 3–4): both pass first time,
// both verifications pass. Tasks 1–4 are closed on the day of their runs.
const REVIEWS = [
  { task: 1, n: 1, verdict: 'pass', at: 45 * DAY },
  { task: 2, n: 1, verdict: 'fail', at: 44 * DAY },
  { task: 2, n: 2, verdict: 'pass', at: 44 * DAY - HOUR },
  { task: 3, n: 1, verdict: 'pass', at: 2 * DAY },
  { task: 4, n: 1, verdict: 'pass', at: DAY },
];
const VERIFICATIONS = [
  { task: 1, exit: 0, at: 45 * DAY, command: 'npm test', elapsed: 4 },
  { task: 2, exit: 1, at: 44 * DAY, command: 'npm test', elapsed: 6 },
  { task: 3, exit: 0, at: 2 * DAY, command: 'npm run lint', elapsed: 9 },
  { task: 4, exit: 0, at: DAY, command: 'npm run lint', elapsed: 3 },
];
const CLOSED = [
  [1, 45 * DAY],
  [2, 44 * DAY],
  [3, 2 * DAY],
  [4, DAY],
];

function seedQuality(db) {
  const review = db.prepare('INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, created_at) VALUES (?, ?, ?, ?, 1, ?)');
  for (const r of REVIEWS) review.run(r.task, r.n, 'code-reviewer', r.verdict, ago(r.at));
  const verification = db.prepare("INSERT INTO verification_runs (id, task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s) VALUES (?, ?, 'abc1234', 'gate', ?, ?, ?, 600)");
  const command = db.prepare('INSERT INTO verification_run_commands (run_id, ordinal, command, exit_code, elapsed_s) VALUES (?, 0, ?, ?, ?)');
  VERIFICATIONS.forEach((v, i) => {
    verification.run(i + 1, v.task, ago(v.at), ago(v.at), v.exit);
    command.run(i + 1, v.command, v.exit, v.elapsed);
  });
  const close = db.prepare("UPDATE tasks SET status = 'closed', completed_at = ? WHERE id = ?");
  for (const [id, at] of CLOSED) close.run(ago(at), id);
  return db;
}

let mod;
before(async () => {
  const out = await build({
    stdin: {
      contents: `import { renderToStaticMarkup } from 'react-dom/server';
        import { createElement } from 'react';
        import { compare, compareQuery, exploreCompare } from './server/queries.ts';
        import { InsightsLayout } from './web/views/insights/InsightsView.tsx';
        import { DeltaLabel } from './web/views/insights/compare.tsx';
        export * from './web/views/insights/compare.ts';
        export * as copy from './web/views/insights/params.ts';
        export { NO_PRICES, BRO_CAPTION } from './web/views/insights/sections.tsx';
        export * as label from './web/ui/Label.tsx';
        export { textWidth } from './web/views/insights/charts.tsx';
        import { parseInsightParams } from './web/views/insights/params.ts';
        const withHash = (hash, fn) => {
          globalThis.window = { location: { hash }, history: { replaceState() {} }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
          try { return fn(); } finally { delete globalThis.window; }
        };
        export const paramsOf = (hash) => {
          const [path, query = ''] = hash.replace(/^#\\/?/, '').split('?');
          return parseInsightParams(path, new URLSearchParams(query));
        };
        export const comparison = (db, p1, p2, query = '') => {
          const q = compareQuery(new URLSearchParams(\`p1=\${encodeURIComponent(p1)}&p2=\${encodeURIComponent(p2)}&\${query}\`));
          if ('error' in q) throw new Error(q.error);
          return compare(db, q.filter, q.p1, q.p2);
        };
        export const page = (hash, cmp) => withHash(hash, () =>
          renderToStaticMarkup(createElement(InsightsLayout, { params: paramsOf(hash), q: { data: cmp.p2, error: null }, cmp: { data: cmp, error: null } })));
        export const exploreComparison = (db, p1, p2, query) => {
          const search = new URLSearchParams(\`p1=\${encodeURIComponent(p1)}&p2=\${encodeURIComponent(p2)}&\${query}\`);
          const q = compareQuery(search);
          if ('error' in q) throw new Error(q.error);
          return exploreCompare(db, q.filter, q.p1, q.p2, search);
        };
        export const explorePage = (hash, cmp, ex) => withHash(hash, () =>
          renderToStaticMarkup(createElement(InsightsLayout, { params: paramsOf(hash), q: { data: cmp.p2, error: null }, cmp: { data: cmp, error: null }, exploreCmp: { data: ex, error: null } })));
        export const plainPage = (hash, data) => withHash(hash, () =>
          renderToStaticMarkup(createElement(InsightsLayout, { params: paramsOf(hash), q: { data, error: null } })));
        export const deltaLabel = (props) => renderToStaticMarkup(createElement(DeltaLabel, props));`,
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

const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tmb-dashboard-compare-ui-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe('period slices', () => {
  test('SC1: every server grammar key round-trips through parseSlice and sliceKey', () => {
    for (const key of ['7d', '30d', '90d', 'all', 'prev7d', 'prev30d', 'prev90d', 'dates:2026-05-01..2026-05-31', 'dates:2026-05-01..', 'dates:..2026-05-31', 'tasks:100-200', 'tasks:201-', 'tasks:-50']) {
      const s = mod.parseSlice(key);
      assert.ok(s, key);
      assert.equal(mod.sliceKey(s), key);
    }
  });

  test('SC1: malformed or reversed periods parse to null', () => {
    for (const key of ['', 'bogus', 'prev1d', 'dates:2026-02-30..', 'dates:2026-05-02..2026-05-01', 'tasks:0-', 'tasks:5-3', 'tasks:a-b', 'tasks:1.5-']) {
      assert.equal(mod.parseSlice(key), null, key);
    }
    assert.equal(mod.parseSlice(null), null);
  });

  test('SC1: slice labels name presets, task ranges and date ranges', () => {
    const label = (k) => mod.sliceLabel(mod.parseSlice(k));
    assert.equal(label('tasks:100-200'), 'Tasks 100–200');
    assert.equal(label('tasks:201-'), 'Tasks 201+');
    assert.equal(label('tasks:1-'), mod.copy.ALL_TASKS);
    assert.match(label('dates:2026-05-01..2026-05-31'), /^May 1\s–\s31, 2026$/);
    assert.equal(label('tasks:-50'), 'Tasks up to 50');
    assert.equal(label('tasks:7-7'), 'Task 7');
    assert.equal(label('30d'), mod.copy.RANGES.find(([k]) => k === '30d')[1]);
    assert.equal(label('prev30d'), mod.copy.PREV_RANGES.find(([k]) => k === 'prev30d')[1]);
  });

  test('SC1: defaults are the last 50 tasks against the 50 before, halves under 100, dates with no tasks', () => {
    const keys = (c) => [mod.sliceKey(c.p1), mod.sliceKey(c.p2)];
    assert.deepEqual(keys(mod.defaultCompare(250)), ['tasks:151-200', 'tasks:201-']);
    assert.deepEqual(keys(mod.defaultCompare(100)), ['tasks:1-50', 'tasks:51-']);
    assert.deepEqual(keys(mod.defaultCompare(41)), ['tasks:1-20', 'tasks:21-']);
    assert.deepEqual(keys(mod.defaultCompare(null)), ['prev30d', '30d']);
    assert.deepEqual(keys(mod.defaultCompare(1)), ['prev30d', '30d']);
  });

  test('SC1: the hash carries p1 and p2, and the API path drops range', () => {
    const hash = '#/insights/tokens?range=30d&p1=tasks:100-200&p2=tasks:201-';
    const p = mod.paramsOf(hash);
    assert.deepEqual(p.compare, { p1: { kind: 'tasks', from: 100, to: 200 }, p2: { kind: 'tasks', from: 201, to: null } });
    assert.ok(mod.copy.insightHash(p).endsWith('&p1=tasks:100-200&p2=tasks:201-'));
    assert.deepEqual(mod.paramsOf(mod.copy.insightHash(p)), p);
    assert.equal(mod.copy.compareApiPath(p), 'insights/compare?p1=tasks:100-200&p2=tasks:201-');
    assert.equal(mod.copy.compareApiPath(mod.paramsOf('#/insights/tokens?range=7d&repo=plugin&p1=prev7d&p2=7d')), 'insights/compare?repo=plugin&p1=prev7d&p2=7d');
    assert.ok(!('compare' in mod.paramsOf('#/insights/tokens?range=30d')));
    assert.ok(!('compare' in mod.paramsOf('#/insights/tokens?range=30d&p1=tasks:1-2')));
    assert.ok(!mod.copy.insightHash({ ...p, compare: null }).includes('p1='));
  });

  test('SC1: picker drafts reject non-numbers and reversed ends, accept an open end', () => {
    assert.deepEqual(mod.taskDraft('abc', ''), { slice: null, error: mod.copy.TASK_NUMBER_ERROR, field: 'from' });
    assert.deepEqual(mod.taskDraft('0', ''), { slice: null, error: mod.copy.TASK_NUMBER_ERROR, field: 'from' });
    assert.deepEqual(mod.taskDraft('200', '100'), { slice: null, error: mod.copy.TASK_ORDER_ERROR, field: 'to' });
    assert.deepEqual(mod.taskDraft(' 201 ', ''), { slice: { kind: 'tasks', from: 201, to: null }, error: null, field: null });
    assert.deepEqual(mod.dateDraft('2026-05-02', '2026-05-01'), { slice: null, error: mod.copy.DATE_ORDER_ERROR, field: 'to' });
    assert.deepEqual(mod.dateDraft('2026-05-01', ''), { slice: { kind: 'dates', from: '2026-05-01', to: null }, error: null, field: null });
  });
});

describe('deltas', () => {
  const d = (m, a, b) => mod.delta(m, 'x', a, b);

  test('SC2: relative change against Period 1, with sign, rounding and colour by polarity', () => {
    assert.deepEqual([d('tokens_out', 100, 80).text, d('tokens_out', 100, 80).variant, d('tokens_out', 100, 80).direction], ['−20% vs Period 1', 'success', 'down']);
    assert.deepEqual([d('cost', 100, 130).text, d('cost', 100, 130).variant], ['+30% vs Period 1', 'danger']);
    assert.deepEqual([d('tokens_out', 100, 103).text, d('tokens_out', 100, 103).variant], ['+3.0% vs Period 1', 'secondary']);
    assert.equal(d('tokens_out', 100, 100.01).text, '+<0.1% vs Period 1');
    assert.deepEqual([d('tool_uses', 10, 20).text, d('tool_uses', 10, 20).variant], ['+100% vs Period 1', 'secondary']);
    assert.deepEqual([d('context', 50, 50).text, d('context', 50, 50).direction], [mod.copy.NO_CHANGE, 'none']);
  });

  test('SC2: cache-hit changes in points, higher is better', () => {
    assert.deepEqual([d('cache_hit', 0.5, 0.62).text, d('cache_hit', 0.5, 0.62).variant], ['+12.0 pts vs Period 1', 'success']);
    assert.deepEqual([d('cache_hit', 0.5, 0.495).text, d('cache_hit', 0.5, 0.495).variant], ['−0.5 pts vs Period 1', 'secondary']);
    assert.equal(d('cache_hit', 0, 0.2).text, '+20.0 pts vs Period 1');
  });

  test('B1: pass rates move in points and higher is better; throughput is relative and higher is better; task-level baselines name tasks', () => {
    assert.deepEqual([d('first_pass', 0.5, 0.75).text, d('first_pass', 0.5, 0.75).variant], ['+25.0 pts vs Period 1', 'success']);
    assert.deepEqual([d('verification', 0.9, 0.6).text, d('verification', 0.9, 0.6).variant], ['−30.0 pts vs Period 1', 'danger']);
    assert.deepEqual([d('throughput', 2, 3).text, d('throughput', 2, 3).variant], ['+50% vs Period 1', 'success']);
    assert.deepEqual([d('share', 0.5, 0.2).text, d('share', 0.5, 0.2).variant], ['−30.0 pts vs Period 1', 'secondary']);
    assert.equal(d('duration_ms', 1000, 2000).variant, 'danger');
    assert.equal(d('throughput', 0, 3).title, mod.copy.NO_BASELINE_TASKS_TITLE);
    assert.equal(d('first_pass', null, 0.5).title, mod.copy.NO_BASELINE_TASKS_TITLE);
  });

  test('SC2: no baseline shows a dash with the reason as its title', () => {
    for (const [a, b] of [[null, 5], [0, 5]]) {
      const x = d('tokens_out', a, b);
      assert.deepEqual([x.text, x.variant, x.title], ['— vs Period 1', 'secondary', mod.copy.NO_BASELINE_TITLE]);
    }
    const html = mod.deltaLabel({ measure: 'tokens_out', subject: 'swe p50 output tokens', p1: 100, p2: 80 });
    assert.match(html, /role="img"/);
    assert.match(html, /aria-label="swe p50 output tokens/);
    assert.match(html, /data-delta="success"/);
  });
});

describe('compare mode render', () => {
  const db = seed(join(tmp, 'unpriced.db'));
  const priced = seed(join(tmp, 'priced.db'), PRICES);
  after(() => {
    db.close();
    priced.close();
  });
  const TASKS = '&p1=tasks:1-2&p2=tasks:3-';
  const DATES = '&p1=prev90d&p2=7d';

  test('SC3: Tokens shows the Per Task strip, the agent table, the overlay and the legend kinds', () => {
    const html = mod.page(`#/insights/tokens?range=30d${TASKS}`, mod.comparison(priced, 'tasks:1-2', 'tasks:3-'));
    assert.match(html, /data-compare-toggle="" aria-pressed="true"|aria-pressed="true"[^>]*data-compare-toggle/);
    assert.match(html, /data-compare-bar=""/);
    assert.match(html, /data-compare-summary=""/);
    assert.match(html, /data-per-task=""/);
    assert.equal((html.match(/data-compare-tile="/g) ?? []).length, 4);
    assert.match(html, />Measure</);
    assert.match(html, />Change</);
    assert.match(html, /data-delta="/);
    assert.match(html, /data-agent="swe"/);
    assert.match(html, /<path[^>]*data-outline=""/);
    assert.match(html, /data-legend-kind="outline"/);
    assert.match(html, /data-legend-kind="fill"/);
    assert.match(html, /Period 1: Tasks 1–2/);
    assert.match(html, /Period 2: Tasks 3\+/);
    assert.ok(html.includes(mod.copy.LOWER_BETTER));
    assert.ok(html.includes(`Top Runs by Output Tokens${mod.copy.OUTLIERS_P2}`));
    assert.ok(!/>Period<select/.test(html));
  });

  test('SC3: task periods leave bro out and say why; date periods keep the bro card', () => {
    const tasks = mod.page(`#/insights/tokens?range=30d${TASKS}`, mod.comparison(db, 'tasks:1-2', 'tasks:3-'));
    assert.ok(!tasks.includes('data-agent="bro"'));
    assert.ok(tasks.includes(mod.copy.BRO_TASKS_CAPTION.replaceAll("'", '&#x27;')));
    const mixed = mod.page(`#/insights/tokens?range=30d&p1=prev90d&p2=tasks:3-`, mod.comparison(db, 'prev90d', 'tasks:3-'));
    assert.ok(mixed.includes(mod.copy.BRO_EXCLUDED_CAPTION.replaceAll("'", '&#x27;')));
    const dates = mod.page(`#/insights/tokens?range=30d${DATES}`, mod.comparison(db, 'prev90d', '7d'));
    assert.match(dates, /data-agent="bro"/);
    assert.ok(dates.includes(mod.BRO_CAPTION));
    assert.ok(!dates.includes('data-bro-caption'));
  });

  test('SC3: the cost tile shows only when a period is priced', () => {
    const html = mod.page(`#/insights/tokens?range=30d${TASKS}`, mod.comparison(db, 'tasks:1-2', 'tasks:3-'));
    assert.equal((html.match(/data-compare-tile="/g) ?? []).length, 3);
    assert.ok(!html.includes('data-compare-tile="cost"'));
  });

  test('SC3: empty periods say which one is empty, or that both are', () => {
    const both = mod.page('#/insights/tokens?range=30d&p1=tasks:900-950&p2=tasks:960-', mod.comparison(db, 'tasks:900-950', 'tasks:960-'));
    assert.ok(both.includes(mod.copy.NO_RUNS_EITHER));
    assert.ok(!both.includes('data-per-task'));
    const one = mod.page('#/insights/tokens?range=30d&p1=tasks:1-2&p2=tasks:900-', mod.comparison(db, 'tasks:1-2', 'tasks:900-'));
    assert.match(one, /data-period-empty="2"/);
    assert.ok(one.includes(mod.copy.noRunsIn(2, 'Tasks 900+')));
  });

  test('SC4: Cost per Run pairs Period 1 as a dashed outline over Period 2 filled, 10px each, delta after', () => {
    const html = mod.page(`#/insights/cost?range=30d${TASKS}`, mod.comparison(priced, 'tasks:1-2', 'tasks:3-'));
    assert.ok(html.includes(mod.copy.COST_PER_RUN_AGENT));
    assert.ok(html.includes(mod.copy.COST_PER_RUN_MODEL));
    const rows = html.match(/<g data-pair=""/g) ?? [];
    assert.equal(rows.length, 3);
    const outline = /<rect[^>]*data-outline=""[^>]*>/.exec(html)?.[0] ?? '';
    assert.match(outline, / y="18.75"/);
    assert.match(outline, /height="8.5"/);
    assert.match(html, /<path[^>]*d="M4,32 h[^"]* v2 [^"]*"/);
    assert.match(outline, /stroke-dasharray="4 3"/);
    assert.match(outline, /fill="none"/);
    assert.match(html, /<foreignObject[^>]*>.*?data-delta="/s);
    assert.ok(html.includes(mod.copy.LOWER_BETTER));
    assert.ok(!html.includes(mod.copy.BRO_COST_PER_SESSION));
  });

  test('SC4: date periods show bro cost per session as a tile; unpriced shows the notice', () => {
    const html = mod.page(`#/insights/cost?range=30d${DATES}`, mod.comparison(priced, 'prev90d', '7d'));
    assert.ok(html.includes(mod.copy.BRO_COST_PER_SESSION));
    assert.match(html, /data-compare-tile="cost"/);
    assert.ok(html.includes('bro cost per session'));
    assert.ok(!html.includes('bro cost per run'));
    const off = mod.page(`#/insights/cost?range=30d${TASKS}`, mod.comparison(db, 'tasks:1-2', 'tasks:3-'));
    assert.ok(off.includes(mod.NO_PRICES));
    assert.ok(!off.includes('data-pair='));
  });

  test('GH 2069 C2: Efficiency renders its compare view under the period pickers, with no scope note', () => {
    const cmp = mod.comparison(db, 'tasks:1-2', 'tasks:3-');
    assert.equal(mod.copy.COMPARE_SCOPE_NOTE, undefined);
    const html = mod.page(`#/insights/efficiency?range=30d${TASKS}`, cmp);
    assert.ok(html.includes(mod.copy.EFFICIENCY_TITLE));
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /data-compare-bar=""/);
    assert.ok(!html.includes('data-compare-scope'));
    const off = mod.plainPage('#/insights/efficiency?range=30d', cmp.p2);
    assert.match(off, /aria-pressed="false"/);
    assert.ok(!off.includes('data-compare-bar'));
  });
});

describe('compare mode render: Explore (GH 2069 B2)', () => {
  const db = seed(join(tmp, 'explore.db'));
  after(() => db.close());
  const PIVOT = 'x=tokens_out&a=avg&g=agent';
  const view = (p1, p2) =>
    mod.explorePage(`#/insights/explore?range=30d&${PIVOT}&p1=${p1}&p2=${p2}`, mod.comparison(db, p1, p2), mod.exploreComparison(db, p1, p2, 'm=tokens_out&a=avg&g=agent'));

  test('SC3: the Pivot stays, the table pairs runs and value per period with a Change column, and bars pair each group', () => {
    const html = view('tasks:1-2', 'tasks:3-');
    assert.match(html, /aria-label="Pivot"/);
    const table = /<table[^>]*data-explore-compare=""[^>]*>.*?<\/table>/s.exec(html)?.[0] ?? '';
    const headers = [...table.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((m) => m[1]);
    assert.deepEqual(headers.slice(1), ['Period 1 Runs', 'Period 1 Average Output Tokens', 'Period 2 Runs', 'Period 2 Average Output Tokens', 'Change']);
    assert.match(table, /data-delta="/);
    assert.match(table, /swe/);
    assert.match(table, /code-reviewer/);
    assert.ok(!table.includes('bro'));
    assert.equal((html.match(/<g data-pair=""/g) ?? []).length, 2);
    assert.ok(html.includes(mod.copy.BRO_TASKS_CAPTION.replaceAll("'", '&#x27;')));
  });

  test('SC3: date periods keep bro and show no bro caption', () => {
    const html = view('prev90d', '7d');
    const table = /<table[^>]*data-explore-compare=""[^>]*>.*?<\/table>/s.exec(html)?.[0] ?? '';
    assert.match(table, />bro</);
    assert.ok(!html.includes(mod.copy.BRO_TASKS_CAPTION.replaceAll("'", '&#x27;')));
  });

  test('SC3: Explore reuses the both-empty and one-empty states', () => {
    assert.ok(view('tasks:900-950', 'tasks:960-').includes(mod.copy.NO_RUNS_EITHER));
    assert.match(view('tasks:1-2', 'tasks:900-'), /data-period-empty="2"/);
  });

  test('SC4: Explore is a compare section and fetches the compare path only while comparing', () => {
    assert.ok(mod.copy.COMPARE_SECTIONS.has('explore'));
    const on = mod.paramsOf(`#/insights/explore?range=30d&${PIVOT}&p1=tasks:1-2&p2=tasks:3-`);
    assert.equal(mod.copy.exploreApiPath(on), 'insights/explore/compare?m=tokens_out&a=avg&g=agent&p1=tasks:1-2&p2=tasks:3-');
    const off = mod.paramsOf(`#/insights/explore?range=30d&${PIVOT}`);
    assert.equal(mod.copy.exploreApiPath(off), 'insights/explore?range=30d&m=tokens_out&a=avg&g=agent');
  });
});

describe('compare mode render: Time, Quality and Throughput (GH 2069 B1)', () => {
  const db = seedQuality(seed(join(tmp, 'quality.db')));
  after(() => db.close());
  const TASKS = '&p1=tasks:1-2&p2=tasks:3-';
  const DATES = '&p1=prev90d&p2=7d';
  const rows = (html) => [...html.matchAll(/<table[^>]*data-compare-stats=""[^>]*>.*?<\/table>/gs)].map((m) => [...m[0].matchAll(/<th scope="row"[^>]*>(.*?)<\/th>/g)].map((r) => r[1]));

  test('SC1: Time pairs each agent in a p50/p95/avg delta table with Period 1 outlined and Period 2 filled', () => {
    const html = mod.page(`#/insights/time?range=30d${TASKS}`, mod.comparison(db, 'tasks:1-2', 'tasks:3-'));
    assert.ok(html.includes(mod.copy.DURATION_PER_RUN));
    assert.ok(html.includes(mod.copy.TOOL_USES_PER_RUN));
    const tables = rows(html);
    assert.equal(tables.length, 4);
    for (const t of tables) assert.deepEqual(t, ['p50', 'p95', 'avg']);
    assert.match(html, />Measure<.*?>Period 1<.*?>Period 2<.*?>Change</s);
    assert.match(html, /data-agent="swe"/);
    assert.match(html, /data-agent="code-reviewer"/);
    assert.equal((html.match(/<g data-pair=""/g) ?? []).length, 4);
    assert.match(html, /<rect[^>]*stroke-dasharray="4 3"[^>]*data-outline=""/);
    assert.match(html, /data-legend-kind="outline"/);
    assert.match(html, /data-legend-kind="fill"/);
    assert.ok(html.includes(mod.copy.LOWER_BETTER));
    assert.ok(html.includes(`Top Runs by Duration${mod.copy.OUTLIERS_P2}`));
  });

  test('SC1: bro session cards show only when bro is not excluded', () => {
    const tasks = mod.comparison(db, 'tasks:1-2', 'tasks:3-');
    assert.equal(tasks.bro_excluded, true);
    const hidden = mod.page(`#/insights/time?range=30d${TASKS}`, tasks);
    assert.ok(!hidden.includes('data-agent="bro"'));
    assert.ok(!hidden.includes(mod.copy.BRO_DURATION_PER_SESSION));
    assert.ok(hidden.includes(mod.copy.BRO_TASKS_CAPTION.replaceAll("'", '&#x27;')));
    const dates = mod.comparison(db, 'prev90d', '7d');
    assert.equal(dates.bro_excluded, false);
    const shown = mod.page(`#/insights/time?range=30d${DATES}`, dates);
    assert.match(shown, /data-agent="bro"/);
    assert.ok(shown.includes(mod.copy.BRO_DURATION_PER_SESSION));
    assert.ok(shown.includes(mod.copy.BRO_TOOL_USES_PER_SESSION));
    assert.ok(!shown.includes('data-bro-caption'));
  });

  test('SC2: Quality rate tiles show Period 2 large, Period 1 muted and the change in points', () => {
    const html = mod.page(`#/insights/quality?range=30d${TASKS}`, mod.comparison(db, 'tasks:1-2', 'tasks:3-'));
    const tile = (k) => new RegExp(`data-rate-tile="${k}".*?</div>`, 's').exec(html)?.[0] ?? '';
    const first = tile('first_pass');
    assert.match(first, />100%</);
    assert.match(first, /data-period1-rate="">Period 1: 50%</);
    assert.match(first, /\+50\.0 pts vs Period 1/);
    assert.match(first, /data-delta="success"/);
    assert.match(tile('verification'), /data-period1-rate="">Period 1: 50%</);
    assert.equal((html.match(/role="progressbar"/g) ?? []).length, 4);
    assert.equal((html.match(/data-period-bar="1"/g) ?? []).length, 3);
    assert.equal((html.match(/data-period-bar="2"/g) ?? []).length, 3);
    assert.match(html, /aria-hidden="true" class="[^"]*">1<\/span>/);
    assert.match(html, /aria-hidden="true" class="[^"]*">2<\/span>/);
    assert.equal((html.match(/role="img" aria-label="Period [12]: Review verdicts/g) ?? []).length, 2);
  });

  test('SC2: Review Attempts pairs each bucket share; Slowest Commands shows Period 2 only', () => {
    const html = mod.page(`#/insights/quality?range=30d${TASKS}`, mod.comparison(db, 'tasks:1-2', 'tasks:3-'));
    assert.ok(html.includes(mod.copy.REVIEW_ATTEMPTS));
    const pairs = html.match(/<g data-pair=""/g) ?? [];
    assert.equal(pairs.length, 2);
    assert.ok(html.includes('1 attempt: Period 1 50%, Period 2 100%'));
    assert.ok(html.includes('2 attempts: Period 1 50%, Period 2 0%'));
    assert.ok(html.includes(`${mod.copy.SLOWEST_COMMANDS}${mod.copy.OUTLIERS_P2}</h3>`));
    assert.ok(html.includes('npm run lint'));
    assert.ok(!html.includes('npm test'));
  });

  test('SC3: Throughput shows each period average with a higher-is-better delta and one chart per period on a shared y', () => {
    const html = mod.page(`#/insights/throughput?range=30d${TASKS}`, mod.comparison(db, 'tasks:1-2', 'tasks:3-'));
    const stats = /data-throughput-stats="".*?<\/p>/s.exec(html)?.[0] ?? '';
    assert.ok(stats.includes(mod.copy.AVG_CLOSED_PER_DAY));
    assert.match(stats, /Period 1<\/span><span[^>]*>1<\/span>/);
    assert.match(stats, /Period 2<\/span><span[^>]*>1<\/span>/);
    assert.match(stats, /data-delta="secondary"/);
    assert.ok(stats.includes(mod.copy.HIGHER_BETTER));
    assert.ok(html.includes('Period 1: Tasks 1–2'));
    assert.ok(html.includes('Period 2: Tasks 3+'));
    assert.match(html, /data-throughput-period="1"/);
    assert.match(html, /data-throughput-period="2"/);
    assert.ok(html.includes('Period 1: Tasks 1–2: 2 closed tasks over 2 days'));
    assert.ok(html.includes('Period 2: Tasks 3+: 2 closed tasks over 2 days'));
  });

  test('SC4: Time, Quality and Throughput reuse the both-empty and one-empty states', () => {
    for (const section of ['time', 'quality', 'throughput']) {
      const both = mod.page(`#/insights/${section}?range=30d&p1=tasks:900-950&p2=tasks:960-`, mod.comparison(db, 'tasks:900-950', 'tasks:960-'));
      assert.ok(both.includes(mod.copy.NO_RUNS_EITHER), section);
      const one = mod.page(`#/insights/${section}?range=30d&p1=tasks:1-2&p2=tasks:900-`, mod.comparison(db, 'tasks:1-2', 'tasks:900-'));
      assert.match(one, /data-period-empty="2"/, section);
    }
  });
});

describe('paired-bar change pills (GH 2545)', () => {
  const db = seedQuality(seed(join(tmp, 'pills.db')));
  const priced = seed(join(tmp, 'pills-priced.db'), PRICES);
  after(() => {
    db.close();
    priced.close();
  });
  const TASKS = '&p1=tasks:1-2&p2=tasks:3-';
  const unescape = (s) => s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&amp;', '&');
  const stripTags = (s) => {
    let prev;
    do {
      prev = s;
      s = s.replace(/<svg.*?<\/svg>/gs, '').replace(/<[^>]+>/g, '');
    } while (s !== prev);
    return unescape(s);
  };
  const pages = () => ({
    cost: mod.page(`#/insights/cost?range=30d${TASKS}`, mod.comparison(priced, 'tasks:1-2', 'tasks:3-')),
    time: mod.page(`#/insights/time?range=30d${TASKS}`, mod.comparison(db, 'tasks:1-2', 'tasks:3-')),
    quality: mod.page(`#/insights/quality?range=30d${TASKS}`, mod.comparison(db, 'tasks:1-2', 'tasks:3-')),
    explore: mod.explorePage(
      `#/insights/explore?range=30d&x=tokens_out&a=avg&g=agent${TASKS}`,
      mod.comparison(db, 'tasks:1-2', 'tasks:3-'),
      mod.exploreComparison(db, 'tasks:1-2', 'tasks:3-', 'm=tokens_out&a=avg&g=agent'),
    ),
  });

  test('SC2: the pill chrome constants match the classes labelClass emits', () => {
    const cls = mod.label.labelClass().split(' ');
    for (const c of ['px-[7px]', 'border', 'gap-1']) assert.ok(cls.includes(c), c);
    assert.equal(mod.label.LABEL_PAD_X, 7);
    assert.equal(mod.label.LABEL_BORDER, 1);
    assert.equal(mod.label.LABEL_ICON_GAP, 4);
    assert.equal(mod.label.LABEL_ICON, 12);
    assert.match(mod.deltaLabel({ measure: 'tokens_out', subject: 'swe p50 output tokens', p1: 100, p2: 80 }), /<svg[^>]*width="12"/);
  });

  test('SC1: every foreignObject is wide enough for its pill text, padding, border, icon and gap', () => {
    const { LABEL_PAD_X, LABEL_BORDER, LABEL_ICON, LABEL_ICON_GAP } = mod.label;
    let checked = 0;
    for (const [section, html] of Object.entries(pages())) {
      const pills = [...html.matchAll(/<foreignObject[^>]*width="([\d.]+)"[^>]*>(.*?)<\/foreignObject>/gs)];
      assert.ok(pills.length > 0, section);
      for (const [, width, inner] of pills) {
        const text = stripTags(inner);
        assert.ok(text.length > 0, `${section}: ${inner}`);
        const need = mod.textWidth(text) + 2 * LABEL_PAD_X + 2 * LABEL_BORDER + LABEL_ICON + LABEL_ICON_GAP;
        assert.ok(Number(width) >= need, `${section} "${text}": ${width} < ${need}`);
        checked++;
      }
    }
    assert.ok(checked >= 8, String(checked));
  });

  test('SC4: explore, cost, time and quality paired bars draw no divider', () => {
    for (const [section, html] of Object.entries(pages())) {
      assert.match(html, /<g data-pair=""/, section);
      assert.doesNotMatch(html, /data-divider=/, section);
    }
  });
});
