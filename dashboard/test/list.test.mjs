// Tasks list test: seed a temp trajectory DB from schema.sql with a task that
// has a fail then a pass verdict and one open finding plus a task with neither,
// start the built dashboard server and check /api/tasks carries last_verdict
// and open_findings; then bundle the Tasks list with esbuild, render it to
// static HTML under a stubbed window.location.hash and check the hash filters
// (state, branch, chips, tab counts), the <ul role="list"> rows, the aria-live
// count and one distinct octicon per task status.
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

function seed(path) {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  const now = new Date().toISOString();
  const issue = Number(db.prepare('INSERT INTO issues (objective, created_at, updated_at) VALUES (?, ?, ?)').run('List issue', now, now).lastInsertRowid);
  const insert = db.prepare("INSERT INTO tasks (issue_id, branch_id, title, description, status, created_at, updated_at) VALUES (?, ?, ?, 'd', ?, ?, ?)");
  const reviewed = Number(insert.run(issue, 'feat/reviewed', 'Reviewed task', 'needs_validation', now, now).lastInsertRowid);
  const bare = Number(insert.run(issue, 'feat/bare', 'Bare task', 'pending', now, now).lastInsertRowid);
  const attempt = db.prepare(
    'INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
  );
  attempt.run(reviewed, 1, 'pr-reviewer', 'fail', 'SC1 fails.', now);
  attempt.run(reviewed, 2, 'code-reviewer', 'pass', 'All met.', now);
  const finding = db.prepare(
    `INSERT INTO review_findings (id, task_id, attempt_n, criterion_id, probe_cmd, expected, observed, status, created_at)
     VALUES (?, ?, 1, 'SC1', 'true', '0', '1', ?, ?)`,
  );
  finding.run(`F${reviewed}-1`, reviewed, 'open', now);
  finding.run(`F${reviewed}-2`, reviewed, 'fixed', now);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return { reviewed, bare };
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

let ui;
before(async () => {
  const out = await build({
    stdin: {
      contents: `import { renderToStaticMarkup } from 'react-dom/server';
        import { createElement } from 'react';
        import { TaskList, TaskRow } from './web/views/TasksView.tsx';
        import { hrefWith } from './web/shared/route.ts';
        import { hrefFor } from './web/shared/columns.tsx';
        import { TASK_STATUSES } from './web/shared/taskState.ts';
        export const list = (rows, hash) => {
          globalThis.window = { location: { hash }, history: { replaceState() {} }, addEventListener() {}, removeEventListener() {} };
          try {
            return renderToStaticMarkup(createElement(TaskList, { rows, params: new URLSearchParams(hash.split('?')[1] ?? '') }));
          } finally {
            delete globalThis.window;
          }
        };
        export const row = (task) => renderToStaticMarkup(createElement('ul', null, createElement(TaskRow, { task })));
        export const withHash = (hash, params, path) => {
          globalThis.window = { location: { hash } };
          try { return hrefWith(params, path); } finally { delete globalThis.window; }
        };
        export { hrefFor, TASK_STATUSES };`,
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

describe('/api/tasks', () => {
  const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tmb-dashboard-list-'));
  const dbPath = join(tmp, 'trajectory.db');
  const ids = seed(dbPath);
  let server;
  before(async () => {
    server = await startServer(dbPath);
  });
  after(async () => {
    await server?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('rows carry last_verdict (newest attempt, any reviewer) and open_findings', async () => {
    const rows = await (await fetch(`${server.url}api/tasks`)).json();
    const reviewed = rows.find((r) => r.id === ids.reviewed);
    assert.equal(reviewed.last_verdict, 'pass');
    assert.equal(reviewed.open_findings, 1);
    const bare = rows.find((r) => r.id === ids.bare);
    assert.equal(bare.last_verdict, null);
    assert.equal(bare.open_findings, 0);
  });
});

const ROWS = [
  { id: 1, issue_id: 9, issue_objective: 'Issue nine', branch_id: 'feat/x', title: 'X open', status: 'running', updated_at: null },
  { id: 2, issue_id: 9, issue_objective: 'Issue nine', branch_id: 'feat/x', title: 'X closed', status: 'closed', updated_at: null, last_verdict: 'pass' },
  { id: 3, issue_id: 8, issue_objective: 'Issue eight', branch_id: 'feat/y', title: 'Y closed', status: 'closed', updated_at: null },
  { id: 4, issue_id: 8, issue_objective: 'Issue eight', branch_id: 'feat/y', title: 'Y open', status: 'pending', updated_at: null },
];

describe('Tasks list', () => {
  test('branch=X&state=closed shows only closed tasks on branch X, with a removable chip and branch-scoped counts', () => {
    const html = ui.list(ROWS, '#/tasks?branch=feat%2Fx&state=closed');
    assert.match(html, />X closed</);
    for (const other of ['X open', 'Y closed', 'Y open']) assert.ok(!html.includes(`>${other}<`), other);
    assert.match(html, />Branch: feat\/x</);
    assert.match(html, /<a href="#\/tasks\?state=closed" aria-label="Remove branch filter"/);
    assert.match(html, /<a href="#\/tasks\?branch=feat%2Fx"[^>]*>.*?1 Open<\/a>/);
    assert.match(html, /<a href="#\/tasks\?branch=feat%2Fx&amp;state=closed" aria-current="page"[^>]*>.*?1 Closed<\/a>/);
    assert.match(html, /<p class="sr-only" aria-live="polite">1 closed task<\/p>/);
  });

  test('open tab is the default, open means status other than closed, and rows are a list', () => {
    const html = ui.list(ROWS, '#/tasks');
    assert.match(html, />2 Open</);
    assert.match(html, />2 Closed</);
    assert.match(html, /aria-live="polite">2 open tasks</);
    assert.match(html, /<ul role="list"><li /);
    assert.equal((html.match(/<li class="flex gap-2\.5/g) ?? []).length, 2);
    assert.ok(!html.includes('aria-label="Filters"'), 'no chips without filters');
  });

  test('status and issue filters apply, and the issue chip clears only issue', () => {
    const html = ui.list(ROWS, '#/tasks?issue=8&status=pending');
    assert.match(html, />Y open</);
    assert.ok(!html.includes('>X open<'));
    assert.match(html, />Issue: #8</);
    assert.match(html, /<a href="#\/tasks\?status=pending" aria-label="Remove issue filter"/);
    assert.match(html, /<option value="pending" selected="">pending<\/option>/);
  });

  test('q seeds the search box', () => {
    const html = ui.list(ROWS, '#/tasks?q=y');
    assert.match(html, /<input type="search"[^>]*value="y"/);
    assert.match(html, />Y open</);
    assert.ok(!html.includes('>X open<'));
  });

  test('a row links its title, branch and issue, with no row onClick', () => {
    const html = ui.row({ ...ROWS[0], last_verdict: 'fail', open_findings: 2, effort: 'medium', repo: 'plugin' });
    assert.match(html, /<a href="#\/tasks\/1" class="[^"]*text-base font-semibold[^"]*">X open<\/a>/);
    assert.match(html, /<a href="#\/tasks\?branch=feat%2Fx" title="feat\/x"/);
    assert.match(html, /<a href="#\/issues\/9"[^>]*><svg[^>]*octicon-issue-opened/);
    assert.match(html, /Last review: fail/);
    assert.match(html, /octicon-report/);
    assert.ok(!/onclick/i.test(html));
  });

  test('each of the 7 task statuses has its own octicon and its status text', () => {
    assert.equal(ui.TASK_STATUSES.length, 7);
    const icons = new Set();
    for (const status of ui.TASK_STATUSES) {
      const html = ui.row({ id: 5, issue_id: 1, title: 't', status, updated_at: null });
      const icon = /<svg [^>]*aria-hidden="true"[^>]*class="([^"]*octicon-[a-z-]+)/.exec(html) ?? /<svg [^>]*class="[^"]*(octicon-[a-z-]+)[^"]*"[^>]*aria-hidden="true"/.exec(html);
      assert.ok(icon, status);
      icons.add(/octicon-[a-z-]+/.exec(icon[1])[0]);
      assert.ok(html.includes(`#5 ${status.replace(/_/g, ' ')}`), status);
    }
    assert.equal(icons.size, 7);
  });

  test('hrefWith keeps current params, overrides and drops; hrefFor maps each kind', () => {
    assert.equal(ui.withHash('#/tasks?state=closed&branch=a', { branch: null }), '#/tasks?state=closed');
    assert.equal(ui.withHash('#/tasks?state=closed', { status: 'running' }), '#/tasks?state=closed&status=running');
    assert.equal(ui.withHash('', { state: 'closed' }, 'issues'), '#/issues?state=closed');
    assert.equal(ui.hrefFor('task', 3), '#/tasks/3');
    assert.equal(ui.hrefFor('issue', 4), '#/issues/4');
    assert.equal(ui.hrefFor('branch', 'feat/z'), '#/tasks?branch=feat%2Fz');
  });
});
