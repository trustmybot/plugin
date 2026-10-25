// Tables test: bundle DataTable and TasksView with esbuild, render them to
// static HTML and check the table sits in a Box with aria-sort header buttons,
// an empty table shows a Blankslate, a hideBelow column hides its th and td
// below sm, and TasksView (fed from a seeded query cache) links each row to
// its issue.
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { build } from 'esbuild';

const DASH = new URL('..', import.meta.url).pathname;
const SERVER = join(DASH, 'dist/server.mjs');

let ui;
before(async () => {
  const out = await build({
    stdin: {
      contents: `import { renderToStaticMarkup } from 'react-dom/server';
        import { createElement } from 'react';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { DataTable } from './web/DataTable.tsx';
        import { TasksView } from './web/views/TasksView.tsx';
        export const render = (el) => renderToStaticMarkup(el);
        export const h = createElement;
        export const renderTasks = (rows) => {
          const client = new QueryClient();
          client.setQueryData(['tasks'], rows);
          return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(TasksView)));
        };
        export { DataTable };`,
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
  ui = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
});

const table = (props) => ui.render(ui.h(ui.DataTable, props));
const COLUMNS = [
  { key: 'name', header: 'Name' },
  { key: 'branch', header: 'Branch', hideBelow: 'sm' },
];

describe('DataTable', () => {
  test('renders inside a Box with sortable header buttons carrying aria-sort', () => {
    const out = table({ rows: [{ name: 'a', branch: 'main' }], columns: COLUMNS });
    assert.match(out, /^<div[^>]*><div[^>]*><svg[^>]*octicon-search/);
    assert.match(out, /<input[^>]*aria-label="Filter rows"/);
    assert.match(out, /<div class="rounded-md border border-\(--borderColor-default\) bg-canvas overflow-x-auto"><table/);
    const headers = [...out.matchAll(/<th [^>]*aria-sort="none"[^>]*><button type="button"/g)];
    assert.equal(headers.length, 2);
  });

  test('zero rows shows a Blankslate', () => {
    const out = table({ rows: [], columns: COLUMNS, filter: false });
    assert.match(out, /octicon-table/);
    assert.match(out, /<h2[^>]*>No rows yet<\/h2>/);
    assert.doesNotMatch(out, /<input/);
  });

  test('a hideBelow sm column hides both its th and td below sm', () => {
    const out = table({ rows: [{ name: 'a', branch: 'main' }], columns: COLUMNS });
    assert.match(out, /<th [^>]*class="[^"]*\bmax-sm:hidden\b[^"]*"[^>]*><button[^>]*>Branch/);
    assert.match(out, /<td class="[^"]*\bmax-sm:hidden\b[^"]*"[^>]*>main<\/td>/);
    assert.doesNotMatch(out, /<td class="[^"]*\bmax-sm:hidden\b[^"]*"[^>]*>a<\/td>/);
  });

  test('clickable rows are focusable', () => {
    const out = ui.render(ui.h(ui.DataTable, { rows: [{ name: 'a' }], columns: COLUMNS.slice(0, 1), onRowClick: () => {} }));
    assert.match(out, /<tr class="[^"]*cursor-pointer[^"]*" tabindex="0"/i);
  });
});

test('TasksView rows link to #/issues/<issue_id>', () => {
  const out = ui.renderTasks([
    { id: 7, issue_id: 42, title: 'Ship tables', status: 'running', branch_id: 'feat/x', effort: 'medium', repo: 'plugin', updated_at: null },
  ]);
  assert.match(out, /<a href="#\/issues\/42"[^>]*>Ship tables<\/a>/);
  assert.match(out, />#7 · issue #42</);
  assert.match(out, /octicon-git-branch/);
});
