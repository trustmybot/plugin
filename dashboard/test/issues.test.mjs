// Issues view test: seed a temp trajectory DB from schema.sql with a labelled
// open issue (two tasks, one done, and two discussions) plus an unlabelled one,
// start the built dashboard server against it and check /api/issues returns
// labels and discussion_count; then render the issue list and issue page to
// static HTML from the API data and check the GitHub-style row, the StateLabel,
// a comment card per discussion and the sidebar Tasks progress. Labelled open
// and closed issues (closed_at set) back the label= filter and its Label stats
// panel: the open/closed donut, the co-label BarList and the close-time tiles.
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
const AREA = 'Area: Dashboard';
const TAGS = Array.from({ length: 8 }, (_, i) => `Tag ${i + 1}`);
// [objective, labels, hours from open to close or null while open]
const LABELLED = [
  ['Open dashboard bug', [AREA, 'Bug'], null],
  ['Open dashboard tags', [AREA, ...TAGS], null],
  ['Closed dashboard bug', [AREA, 'Bug'], 10],
  ['Closed dashboard feature', [AREA, 'Feature'], 20],
  ['Closed dashboard improvement', [AREA, 'Improvement'], 60],
  ['Closed workflow issue', ['Area: Workflow'], 5],
];
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
  const labelled = db.prepare('INSERT INTO issues (objective, labels, status, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, ?, ?)');
  const opened = Date.parse('2026-01-01T00:00:00Z');
  const at = (hours) => new Date(opened + hours * 3_600_000).toISOString();
  for (const [objective, labels, closeAfter] of LABELLED) {
    labelled.run(objective, JSON.stringify(labels), closeAfter === null ? 'open' : 'closed', at(0), at(closeAfter ?? 0), closeAfter === null ? null : at(closeAfter));
  }
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
        import { prerenderToNodeStream } from 'react-dom/static';
        import { IssuePage } from './web/views/issues/IssuePage.tsx';
        import { statusTable } from './web/views/issues/LabelStats.tsx';
        import { DataTableView } from './web/views/insights/ChartCard.tsx';
        const provide = (el) => createElement(QueryClientProvider, { client: new QueryClient() }, el);
        const wrap = (el) => renderToStaticMarkup(provide(el));
        export const list = (rows, state) => wrap(createElement(IssueList, { rows, state }));
        export async function labelList(rows, state, label) {
          const { prelude } = await prerenderToNodeStream(provide(createElement(IssueList, { rows, state, label })));
          let html = '';
          for await (const chunk of prelude) html += chunk;
          return html.replaceAll('<!-- -->', '');
        }
        export const statusTableHtml = (counts) => wrap(createElement(DataTableView, { caption: 'Open vs Closed', table: statusTable(counts) }));
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
    assert.match(html, />4 Open</);
    assert.ok(!html.includes('octicon-issue-closed'));
    assert.match(html, /<a href="#\/issues" aria-current="page"/);
    assert.match(html, /<a href="#\/issues\?state=closed"/);
    assert.match(html, /<ul role="list"><li /);
    assert.match(html, /aria-live="polite">4 open issues</);
    assert.ok(!html.includes('<table'));
    assert.ok(!html.includes('data-label-stats'), 'no label stats panel without a label');
    assert.match(html, /aria-haspopup="menu"[^>]*>.*?Label<\/span>/);
    assert.match(html, /role="menuitemradio" aria-checked="true"[^>]*>.*?All labels/);
  });

  test('a label whose issues are all open shows the closed Blankslate', async () => {
    const html = await views.labelList(await get('issues'), 'closed', 'Tag 1');
    assert.match(html, /No Closed Issues/);
  });

  test('label= filters the list to that exact label and renders the Label stats panel', async () => {
    const rows = await get('issues');
    const html = await views.labelList(rows, 'open', AREA);
    assert.match(html, /<details open=""[^>]*data-label-stats=""/);
    assert.match(html, />3 Open</);
    assert.match(html, />3 Closed</);
    assert.ok(!html.includes('Unlabelled issue'));
    assert.match(html, /aria-label="Remove label filter"/);
    assert.match(html, /Label: Area: Dashboard/);
    const closed = await views.labelList(rows, 'closed', AREA);
    assert.ok(closed.includes('Closed dashboard bug'));
    assert.ok(!closed.includes('Closed workflow issue'), 'a different Area: label does not match');
    const partial = await views.labelList(rows, 'open', 'Area');
    assert.match(partial, /No Open Issues/, 'matching is exact, not a substring');
  });

  test('the donut shows open, closed and total counts with an aria-label, and its table lists status, count and %', async () => {
    const html = await views.labelList(await get('issues'), 'open', AREA);
    assert.match(html, /<svg [^>]*aria-label="Area: Dashboard: 3 open, 3 closed"[^>]*data-donut=""/);
    assert.match(html, /data-segment-label="">Open 3 \(50%\)</);
    assert.match(html, /data-segment-label="">Closed 3 \(50%\)</);
    assert.match(html, /data-donut-total="">6</);
    assert.match(html, /fill="var\(--fgColor-open\)"/);
    assert.match(html, /fill="var\(--fgColor-done\)"/);
    const table = views.statusTableHtml({ open: 3, closed: 1 });
    assert.match(table, /<th scope="col"[^>]*>Status<\/th><th scope="col"[^>]*>Count<\/th><th scope="col"[^>]*>%<\/th>/);
    assert.match(table, /<td[^>]*>Open<\/td><td[^>]*>3<\/td><td[^>]*>75<\/td>/);
    assert.match(table, /<td[^>]*>Closed<\/td><td[^>]*>1<\/td><td[^>]*>25<\/td>/);
  });

  test('the close-time tiles show median, mean and closed count, and — under 3 closed', async () => {
    const rows = await get('issues');
    const tiles = (html) => [...html.matchAll(/<dt[^>]*>(Median|Mean|Closed)<\/dt><dd[^>]*>([^<]*)<\/dd>/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(tiles(await views.labelList(rows, 'open', AREA)), [['Median', '20 h'], ['Mean', '30 h'], ['Closed', '3']]);
    const few = await views.labelList(rows, 'open', 'Bug');
    assert.deepEqual(tiles(few), [['Median', '—'], ['Mean', '—'], ['Closed', '1']]);
    assert.match(few, /fewer than 3 closed/);
  });

  test('the co-label BarList lists the top 8 other labels plus Other, each with an open/closed note', async () => {
    const html = await views.labelList(await get('issues'), 'open', AREA);
    const svg = /<svg [^>]*aria-label="Co-labels of Area: Dashboard: ([^"]*)"/.exec(html)?.[1];
    assert.ok(svg, 'co-label BarList rendered');
    const rows = svg.split('; ');
    assert.deepEqual(rows, [
      'Bug: 1 open · 1 closed',
      'Feature: 1 open · 1 closed',
      'Improvement: 0 open · 1 closed',
      'Tag 1: 1 open · 0 closed',
      'Tag 2: 1 open · 0 closed',
      'Tag 3: 1 open · 0 closed',
      'Tag 4: 1 open · 0 closed',
      'Tag 5: 1 open · 0 closed',
      'Other: 3 open · 0 closed',
    ]);
    assert.ok(!svg.includes(AREA + ':'), 'the selected label is not its own co-label');
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
