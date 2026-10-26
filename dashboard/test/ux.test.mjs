// Dashboard UX test: seed a temp trajectory DB from schema.sql with a
// directory summary and a file purpose wrapped in <untrusted-content> and
// written in markdown, start the built dashboard server against it and check
// /api/world-model and /api/world-model/search return each as one plain line;
// unit-test summaryLine on a cut long line; and render the shared <Markdown>
// component to static HTML to check GFM renders and raw HTML never does; then
// check the per-page help copy, render the ? help marker closed and open and
// inside <App> on detail and Insights routes, and step helpTransition through
// focus, Escape, click-pin, blur, outside click, hover delay and leave grace.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { summaryLine } from '../server/queries.ts';

const DASH = new URL('..', import.meta.url).pathname;
const SCHEMA = join(DASH, '../mcp/trajectory-server/src/schema.sql');
const SERVER = join(DASH, 'dist/server.mjs');

const DIR_SUMMARY = '<untrusted-content source="readme">\n## Uxmap dashboard\n\nA **local** web view of the [trajectory DB](https://example.com).\n</untrusted-content>';
const FILE_PURPOSE = '<untrusted-content source="file-purpose"> ## Uxmap server entry with **bold** and `code` </untrusted-content>';

function seed(path) {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  const dir = db.prepare(
    "INSERT INTO wm_directories (repo, path, parent_path, summary, summary_source, file_count) VALUES ('plugin', ?, ?, ?, 'readme', ?)",
  );
  dir.run('', null, 'Plugin root', 2);
  dir.run('dashboard', '', DIR_SUMMARY, 1);
  db.prepare(
    "INSERT INTO wm_files (repo, path, dir, purpose, updated_at) VALUES ('plugin', 'dashboard/main.ts', 'dashboard', ?, ?)",
  ).run(FILE_PURPOSE, new Date().toISOString());
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
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

const assertPlainLine = (text) => {
  assert.equal(typeof text, 'string');
  assert.ok(!text.includes('<untrusted-content'), text);
  assert.ok(!text.includes('</untrusted-content'), text);
  assert.ok(!text.startsWith('#'), text);
  assert.ok(!text.includes('**'), text);
  assert.ok(!text.includes('`'), text);
  assert.ok(!text.includes('\n'), text);
};

describe('dashboard world-model summaries', () => {
  const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tmb-dashboard-ux-'));
  const dbPath = join(tmp, 'trajectory.db');
  seed(dbPath);
  let server;
  const get = async (path) => (await fetch(`${server.url}api/${path}`)).json();

  before(async () => {
    server = await startServer(dbPath);
  });
  after(async () => {
    await server?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('/api/world-model returns the directory summary as one plain line', async () => {
    const wm = await get('world-model?repo=plugin&depth=1');
    const node = wm.nodes.find((n) => n.path === 'dashboard');
    assertPlainLine(node.summary);
    assert.equal(node.summary, 'Uxmap dashboard');
  });

  test('/api/world-model/search returns directory and file hits as plain lines', async () => {
    const { hits } = await get('world-model/search?q=Uxmap');
    assert.equal(hits.length, 2);
    for (const h of hits) assertPlainLine(h.text);
    assert.equal(hits.find((h) => h.kind === 'file').text, 'Uxmap server entry with bold and code');
  });
});

describe('summaryLine', () => {
  test('cuts a long line to 160 characters with an ellipsis', () => {
    const line = summaryLine(`<untrusted-content source="readme">\n\n# ${'word '.repeat(60)}\nsecond line</untrusted-content>`);
    assert.equal(line.length, 160);
    assert.ok(line.endsWith('…'));
    assert.ok(line.startsWith('word word'));
  });

  test('keeps link text, drops emphasis and passes a short line through', () => {
    assert.equal(summaryLine('See *the* [docs](https://x.y) and __this__'), 'See the docs and this');
    assert.equal(summaryLine('snake_case_name stays'), 'snake_case_name stays');
    assert.equal(summaryLine(null), null);
  });
});

describe('Markdown component', () => {
  let render;
  before(async () => {
    const out = await build({
      stdin: {
        contents: `import { renderToStaticMarkup } from 'react-dom/server';
          import { createElement } from 'react';
          import { Markdown } from './web/Markdown.tsx';
          export const render = (md) => renderToStaticMarkup(createElement(Markdown, null, md));`,
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
    const url = `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`;
    ({ render } = await import(url));
  });

  test('renders GFM headings, lists, code, tables and safe links', () => {
    const html = render('## Title\n\n- one\n- two\n\n`code`\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[link](https://example.com)');
    assert.match(html, /<h2[^>]*>Title<\/h2>/);
    assert.match(html, /<li>one<\/li>/);
    assert.match(html, /<code[^>]*>code<\/code>/);
    assert.match(html, /<pre/);
    assert.match(html, /<table/);
    const link = /<a [^>]*>link<\/a>/.exec(html)?.[0] ?? '';
    assert.match(link, /href="https:\/\/example.com"/);
    assert.match(link, /rel="noreferrer noopener"/);
  });

  test('raw HTML and javascript: links never render live', () => {
    const html = render('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[x](javascript:alert(1))');
    assert.ok(!/<script/i.test(html), html);
    assert.ok(!/<img/i.test(html), html);
    assert.ok(!/onerror/i.test(html), html);
    assert.ok(!/javascript:/i.test(html), html);
  });
});

describe('help marker', () => {
  let ui;
  before(async () => {
    const out = await build({
      stdin: {
        contents: `import { renderToStaticMarkup } from 'react-dom/server';
          import { createElement } from 'react';
          import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
          import { App, TABS } from './web/App.tsx';
          import { HELP, helpKey } from './web/shared/help-copy.ts';
          import { HelpToggletip, helpTransition, HELP_CLOSED } from './web/ui/HelpToggletip.tsx';
          export const tip = (props) => renderToStaticMarkup(createElement(HelpToggletip, props));
          export function app(hash) {
            const location = { hash };
            globalThis.window = { location, history: { replaceState(_s, _t, url) { location.hash = url; } }, addEventListener() {}, removeEventListener() {} };
            try {
              const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(App)));
              return { html, hash: location.hash };
            } finally {
              delete globalThis.window;
            }
          }
          export { TABS, HELP, helpKey, helpTransition, HELP_CLOSED };`,
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

  test('every tab, the issue page and the task page have an intro and 2 to 4 uses', () => {
    const keys = [...ui.TABS.map(([key]) => key), 'issue', 'task'];
    assert.deepEqual(Object.keys(ui.HELP).sort(), [...keys].sort());
    for (const key of keys) {
      const entry = ui.HELP[key];
      assert.ok(entry.intro.trim().length > 0, key);
      assert.ok(entry.uses.length >= 2 && entry.uses.length <= 4, `${key}: ${entry.uses.length} uses`);
    }
    assert.deepEqual(ui.HELP.map.layers.map((l) => l.name), ['Structure', 'Concepts']);
  });

  test('helpKey maps detail routes and Insights sections to their page', () => {
    assert.equal(ui.helpKey('issues', '5'), 'issue');
    assert.equal(ui.helpKey('tasks', '9'), 'task');
    assert.equal(ui.helpKey('issues', undefined), 'issues');
    assert.equal(ui.helpKey('insights', 'explore'), 'insights');
    assert.equal(ui.helpKey('map', undefined), 'map');
    assert.equal(ui.helpKey('issue', undefined), 'overview');
    assert.equal(ui.helpKey('nope', undefined), 'overview');
  });

  test('the closed marker is a labelled button controlling its panel', () => {
    const html = ui.tip({ page: 'Project map', help: ui.HELP.map });
    const button = /<button [^>]*>/.exec(html)[0];
    assert.match(button, /type="button"/);
    assert.match(button, /aria-label="About this page: Project map"/);
    assert.match(button, /aria-expanded="false"/);
    const controls = /aria-controls="([^"]+)"/.exec(button)[1];
    assert.match(html, /<\/button><div id="[^"]+" role="region"/, 'the panel follows the button in the DOM');
    assert.ok(html.includes(`<div id="${controls}" role="region"`));
    assert.match(html, /octicon-question/);
    assert.match(html, /size-8/);
    assert.match(html, /invisible opacity-0/);
  });

  test('the open marker renders a region labelled by its h2 with the layers and uses', () => {
    const html = ui.tip({ page: 'Project map', help: ui.HELP.map, defaultOpen: true });
    assert.match(html, /aria-expanded="true"/);
    const labelledBy = /role="region" aria-labelledby="([^"]+)"/.exec(html)[1];
    assert.ok(html.includes(`<h2 id="${labelledBy}"`));
    assert.match(html, /<h2 [^>]*>Project map<\/h2>/);
    assert.match(html, />Use it to</);
    assert.match(html, />Structure:</);
    assert.match(html, />Concepts:</);
    assert.equal(html.match(/<li>/g).length, 4);
    assert.doesNotMatch(html, /Jump to the issue/);
    assert.match(html, /max-w-\[22rem\]/);
    assert.match(html, /bg-\(--overlay-bgColor\)/);
    assert.match(html, /motion-reduce:transition-none/);
    assert.match(html, /max-sm:inset-x-3/);
    assert.match(html, /max-sm:max-h-\[60vh\]/);
    assert.match(html, /visible opacity-100/);
  });

  test('the overview copy has no jump-to-last-issue line and Insights names recorded runs', () => {
    assert.ok(!ui.HELP.overview.uses.some((u) => u.includes('Jump to the issue')));
    assert.equal(ui.HELP.insights.intro, 'Charts of tokens, cost, time and outcomes per agent. Figures come from recorded runs in this project.');
    assert.equal(ui.HELP.insights.uses[0], 'Compare token use and cost across agents and models.');
  });

  test('the app puts the marker on detail pages and Insights sections', () => {
    for (const [hash, page] of [['#/issues/5', 'Issue detail'], ['#/tasks/9', 'Task detail'], ['#/insights/explore', 'Insights'], ['#/map', 'Project map'], ['', 'Overview']]) {
      const { html } = ui.app(hash);
      assert.ok(html.includes(`aria-label="About this page: ${page}"`), hash);
      assert.match(html, /<main [^>]*><div class="flex justify-end"><div class="relative"/, hash);
    }
  });

  test('the app redirects #/concepts links to the Project map concept scope', () => {
    const { html, hash } = ui.app('#/concepts/7?q=cold');
    assert.equal(hash, '#/map?scope=concepts&q=cold&concept=7');
    assert.match(html, /<a [^>]*href="#\/map" aria-current="page"/);
    assert.ok(html.includes('aria-label="About this page: Project map"'));
    assert.equal(ui.app('#/issues').hash, '#/issues');
  });
});

describe('helpTransition', () => {
  const run = (events, from) => events.reduce((s, e) => ui.helpTransition(s, e), from ?? ui.HELP_CLOSED);
  let ui;
  before(async () => {
    const out = await build({
      stdin: {
        contents: `export { helpTransition, HELP_CLOSED, HOVER_OPEN_MS, HOVER_GRACE_MS } from './web/ui/HelpToggletip.tsx';`,
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

  test('focus opens it and Escape closes it, restoring focus to the button', () => {
    const open = run([{ type: 'focus' }]);
    assert.equal(open.open, true);
    const closed = ui.helpTransition(open, { type: 'escape' });
    assert.equal(closed.open, false);
    assert.equal(closed.restoreFocus, true);
    assert.equal(ui.helpTransition(closed, { type: 'focus' }).restoreFocus, false);
  });

  test('click pins it, blur leaves a pinned tip open and a second click closes it', () => {
    const pinned = run([{ type: 'focus' }, { type: 'click' }]);
    assert.equal(pinned.open, true);
    assert.equal(pinned.pinned, true);
    assert.equal(ui.helpTransition(pinned, { type: 'blur' }).open, true);
    assert.equal(ui.helpTransition(pinned, { type: 'click' }).open, false);
    assert.equal(run([{ type: 'focus' }, { type: 'blur' }]).open, false, 'an unpinned tip closes on blur');
  });

  test('an outside click closes a pinned tip', () => {
    const closed = run([{ type: 'click' }, { type: 'outside' }]);
    assert.equal(closed.open, false);
    assert.equal(closed.pinned, false);
  });

  test('hover opens it only after 150 ms', () => {
    assert.equal(ui.HOVER_OPEN_MS, 150);
    const hovering = run([{ type: 'pointerenter', at: 1000 }]);
    assert.equal(hovering.open, false);
    assert.equal(ui.helpTransition(hovering, { type: 'tick', at: 1149 }).open, false);
    assert.equal(ui.helpTransition(hovering, { type: 'tick', at: 1150 }).open, true);
    assert.equal(run([{ type: 'pointerleave', at: 1100 }, { type: 'tick', at: 1150 }], hovering).open, false, 'leaving before the delay cancels it');
  });

  test('pointer-leave closes it after a 200 ms grace and re-entering within the grace keeps it open', () => {
    assert.equal(ui.HOVER_GRACE_MS, 200);
    const open = run([{ type: 'pointerenter', at: 0 }, { type: 'tick', at: 150 }]);
    const leaving = ui.helpTransition(open, { type: 'pointerleave', at: 500 });
    assert.equal(leaving.open, true);
    assert.equal(ui.helpTransition(leaving, { type: 'tick', at: 699 }).open, true);
    assert.equal(ui.helpTransition(leaving, { type: 'tick', at: 700 }).open, false);
    assert.equal(run([{ type: 'pointerenter', at: 650 }, { type: 'tick', at: 700 }, { type: 'tick', at: 2000 }], leaving).open, true);
    const pinned = run([{ type: 'click' }, { type: 'pointerleave', at: 0 }, { type: 'tick', at: 1000 }]);
    assert.equal(pinned.open, true, 'a pinned tip ignores pointer-leave');
  });
});
