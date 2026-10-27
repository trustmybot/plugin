// Issues view test: seed a temp trajectory DB from schema.sql with a labelled
// open issue (two tasks, one done, and two discussions) plus an unlabelled one,
// start the built dashboard server against it and check /api/issues returns
// labels and discussion_count; then render the issue list and issue page to
// static HTML from the API data and check the GitHub-style row, the StateLabel,
// a comment card per discussion and the sidebar Tasks progress.
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

const LABELS = ['Feature', 'Area: Dashboard'];
const DISCUSSIONS = [
  ['bro', 'decision', 'We go with **Primer** tokens.\n\nSecond paragraph.'],
  ['human', 'note', 'A longer note that is long enough to be shown as a full comment card instead of a compact timeline event.'],
];

function seed(path) {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  const now = new Date().toISOString();
  const issue = Number(
    db
      .prepare('INSERT INTO issues (objective, description, labels, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('GitHub-style issues', '## Plan\n\nRestyle the views.', JSON.stringify(LABELS), now, now).lastInsertRowid,
  );
  db.prepare('INSERT INTO issues (objective, created_at, updated_at) VALUES (?, ?, ?)').run('Unlabelled issue', now, now);
  const task = db.prepare(
    "INSERT INTO tasks (issue_id, branch_id, title, description, status, created_at, updated_at) VALUES (?, ?, ?, 'd', ?, ?, ?)",
  );
  task.run(issue, 'feat/issues-github', 'Done task', 'completed', now, now);
  task.run(issue, 'feat/issues-sidebar', 'Running task', 'running', now, now);
  const disc = db.prepare('INSERT INTO discussions (issue_id, author, kind, body, created_at) VALUES (?, ?, ?, ?, ?)');
  for (const [author, kind, body] of DISCUSSIONS) disc.run(issue, author, kind, body, now);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return issue;
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

async function loadViews() {
  const out = await build({
    stdin: {
      contents: `import { renderToStaticMarkup } from 'react-dom/server';
        import { createElement } from 'react';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { IssueList } from './web/views/issues/IssueList.tsx';
        import { IssuePage } from './web/views/issues/IssuePage.tsx';
        const wrap = (el) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, el));
        export const list = (rows, state) => wrap(createElement(IssueList, { rows, state }));
        export const page = (id, detail) => wrap(createElement(IssuePage, { id, detail }));`,
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
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

describe('dashboard issues', () => {
  const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tmb-dashboard-issues-'));
  const dbPath = join(tmp, 'trajectory.db');
  const id = seed(dbPath);
  let server;
  let views;
  const get = async (path) => (await fetch(`${server.url}api/${path}`)).json();

  before(async () => {
    [server, views] = await Promise.all([startServer(dbPath), loadViews()]);
  });
  after(async () => {
    await server?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('/api/issues returns labels and discussion_count', async () => {
    const rows = await get('issues');
    const seeded = rows.find((r) => r.id === id);
    assert.ok(seeded.discussion_count > 0);
    assert.equal(seeded.discussion_count, DISCUSSIONS.length);
    assert.deepEqual(JSON.parse(seeded.labels), LABELS);
    const bare = rows.find((r) => r.objective === 'Unlabelled issue');
    assert.ok(bare.labels === null || JSON.parse(bare.labels).length === 0);
    assert.equal(bare.discussion_count, 0);
  });

  test('an open issue row shows the IssueOpened octicon, its title link and its labels', async () => {
    const html = views.list(await get('issues'), 'open');
    assert.match(html, /<svg [^>]*class="[^"]*\bocticon-issue-opened\b/);
    assert.match(html, new RegExp(`<a href="#/issues/${id}"[^>]*>GitHub-style issues</a>`));
    for (const label of LABELS) assert.ok(html.includes(`>${label}</span>`), label);
    assert.match(html, />2 Open</);
    assert.ok(!html.includes('octicon-issue-closed'));
    assert.match(html, /<a href="#\/issues" aria-current="page"/);
    assert.match(html, /<a href="#\/issues\?state=closed"/);
    assert.match(html, /<ul role="list"><li /);
    assert.match(html, /aria-live="polite">2 open issues</);
    assert.ok(!html.includes('<table'));
  });

  test('the closed list is empty and shows a Blankslate', async () => {
    const html = views.list(await get('issues'), 'closed');
    assert.match(html, /No Closed Issues/);
  });

  test('the issue page shows a StateLabel, a comment card per discussion and the Tasks progress', async () => {
    const detail = await get(`issues/${id}`);
    const html = views.page(String(id), detail);
    assert.match(html, /<span class="[^"]*bg-\(--bgColor-open-emphasis\)[^"]*"><svg [^>]*octicon-issue-opened[^>]*>.*?<\/svg>Open<\/span>/);
    const cards = html.match(/<article [^>]*data-comment/g) ?? [];
    assert.equal(cards.length, DISCUSSIONS.length + 1, 'description card plus one per discussion');
    assert.match(html, /<strong>Primer<\/strong>/);
    assert.match(html, /<span data-progress="true">1 \/ 2<\/span>/);
    assert.match(html, /feat\/issues-github/);
    assert.match(html, /feat\/issues-sidebar/);
    assert.match(html, /Not synced yet/);
  });
});
