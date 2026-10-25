// Overview test: bundle the Overview layout with esbuild, render it to static
// HTML from fixture summary, issues and runs data, and check each stat cell
// links to its tab, the tasks-by-status rows sort by count with an "of"
// aria-label on each bar, the open-issues list shows at most 5 rows linking
// #/issues/<id>, and no open issues renders a Blankslate.
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { build } from 'esbuild';

const DASH = new URL('..', import.meta.url).pathname;
const SERVER = join(DASH, 'dist/server.mjs');

let mod;
before(async () => {
  const out = await build({
    stdin: {
      contents: `import { renderToStaticMarkup } from 'react-dom/server';
        import { createElement } from 'react';
        import { Overview } from './web/views/overview/Overview.tsx';
        export const render = (props) => renderToStaticMarkup(createElement(Overview, props));`,
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

const SUMMARY = {
  issues: { open: 7, closed: 3 },
  tasks_by_status: [
    { status: 'closed', count: 4 },
    { status: 'running', count: 12 },
    { status: 'failed', count: 1 },
    { status: 'completed', count: 23 },
  ],
  open_runs: 2,
  recent_runs: [
    { id: 41, agent_type: 'swe', task_id: 9, task_title: 'Build it', started_at: '2026-10-25T10:00:00Z', completed_at: null, exit_reason: null },
    { id: 40, agent_type: 'pr-reviewer', task_id: 8, task_title: 'Review it', started_at: '2026-10-24T10:00:00Z', completed_at: '2026-10-24T11:00:00Z', exit_reason: 'completed' },
  ],
};

const issue = (id, status, day) => ({ id, objective: `Issue ${id}`, status, updated_at: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z` });
const ISSUES = [
  issue(1, 'open', 1),
  issue(2, 'closed', 25),
  issue(3, 'open', 20),
  issue(4, 'open', 5),
  issue(5, 'open', 22),
  issue(6, 'open', 10),
  issue(7, 'open', 15),
  issue(8, 'closed', 24),
];

const page = (issues = ISSUES) => mod.render({ summary: SUMMARY, issues: { data: issues, error: null } });

describe('Overview', () => {
  test('each stat cell is a link to its tab hash', () => {
    const nav = page().match(/<nav aria-label="Totals"[^>]*>(.*?)<\/nav>/)[1];
    const cells = [...nav.matchAll(/<a [^>]*href="([^"]+)"[^>]*>.*?<\/a>/g)];
    assert.equal(cells.length, 4);
    assert.deepEqual(cells.map((c) => c[1]), ['#/issues', '#/issues', '#/runs', '#/tasks']);
    for (const [label, value] of [['Open issues', 7], ['Closed issues', 3], ['Agents running', 2], ['Tasks', 40]]) {
      assert.ok(cells.some((c) => c[0].includes(`>${value}<`) && c[0].includes(`>${label}<`)), label);
    }
  });

  test('tasks-by-status rows sort by count and each bar has an "of" aria-label', () => {
    const out = page();
    const order = [...out.matchAll(/data-status="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(order, ['completed', 'running', 'closed', 'failed']);
    const bars = [...out.matchAll(/role="progressbar" aria-label="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(bars, ['23 of 40 tasks', '12 of 40 tasks', '4 of 40 tasks', '1 of 40 tasks']);
  });

  test('open issues show at most 5 rows, newest first, each linking #/issues/<id>', () => {
    const out = page();
    const ids = [...out.matchAll(/data-issue="(\d+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, ['5', '3', '7', '6', '4']);
    for (const id of ids) assert.match(out, new RegExp(`href="#/issues/${id}"`));
    assert.doesNotMatch(out, /href="#\/issues\/(1|2|8)"/);
    assert.match(out, /View all issues/);
  });

  test('no open issues renders a Blankslate', () => {
    const out = page([issue(2, 'closed', 25)]);
    assert.doesNotMatch(out, /data-issue=/);
    assert.match(out, /No open issues/);
    assert.match(out, /octicon-issue-opened/);
  });

  test('recent runs render in the run table', () => {
    const out = page();
    assert.match(out, /Recent agent runs/);
    assert.match(out, /<table[^>]*>.*Build it.*Review it.*<\/table>/);
  });
});
