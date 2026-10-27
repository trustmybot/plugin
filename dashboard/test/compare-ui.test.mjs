// Compare UI test: unit-test the period slices (parse, key, label, defaults),
// the hash keys p1/p2, the picker drafts and the delta text and colour. Then
// seed a temp trajectory DB from schema.sql (tasks 1–2 about 45 days ago,
// tasks 3–5 in the last two days, bro sessions), build the comparison with
// compare() directly, render Insights Tokens and Cost in compare mode to static
// HTML and check the Per Task strip, the agent table, the dashed Period 1
// outline, the legend kinds, the paired cost rows, the bro captions and tile,
// the empty states and the note on the sections compare doesn't cover.
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

let mod;
before(async () => {
  const out = await build({
    stdin: {
      contents: `import { renderToStaticMarkup } from 'react-dom/server';
        import { createElement } from 'react';
        import { compare, compareQuery } from './server/queries.ts';
        import { InsightsLayout } from './web/views/insights/InsightsView.tsx';
        import { DeltaLabel } from './web/views/insights/compare.tsx';
        export * from './web/views/insights/compare.ts';
        export * as copy from './web/views/insights/params.ts';
        export { NO_PRICES, BRO_CAPTION } from './web/views/insights/sections.tsx';
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
    const off = mod.page(`#/insights/cost?range=30d${TASKS}`, mod.comparison(db, 'tasks:1-2', 'tasks:3-'));
    assert.ok(off.includes(mod.NO_PRICES));
    assert.ok(!off.includes('data-pair='));
  });

  test('SC4: other sections keep their view and say compare covers Tokens and Cost', () => {
    const cmp = mod.comparison(db, 'tasks:1-2', 'tasks:3-');
    const html = mod.plainPage(`#/insights/time?range=30d${TASKS}`, cmp.p2);
    assert.ok(html.includes(mod.copy.COMPARE_SCOPE_NOTE));
    assert.ok(!html.includes('data-compare-bar'));
    assert.match(html, /aria-pressed="true"/);
    const off = mod.plainPage('#/insights/time?range=30d', cmp.p2);
    assert.ok(!off.includes(mod.copy.COMPARE_SCOPE_NOTE));
    assert.match(off, /aria-pressed="false"/);
  });
});
