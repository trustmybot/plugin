// Dashboard UX test: seed a temp trajectory DB from schema.sql with a
// directory summary and a file purpose wrapped in <untrusted-content> and
// written in markdown, start the built dashboard server against it and check
// /api/world-model and /api/world-model/search return each as one plain line;
// unit-test summaryLine on a cut long line; and render the shared <Markdown>
// component to static HTML to check GFM renders and raw HTML never does.
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
