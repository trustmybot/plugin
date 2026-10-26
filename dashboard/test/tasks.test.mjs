// Task page test: seed a temp trajectory DB from schema.sql with one task that
// has a spec, files, verification, a completion report (met and not_met
// criteria), two review attempts (fail then pass), an open and a fixed finding,
// a verification run with two commands (one output_tail carrying a <script>)
// and an agent run with tokens, plus a task whose JSON columns are bad. Start
// the built server and check /api/tasks/:id, its 404s and that the DB file is
// unchanged; then render the task page to static HTML from the API data and
// check its headings, the escaped output, the issue link and one <details> per
// verification run, and that the Runs & gates task cells link to the task page.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const DASH = new URL('..', import.meta.url).pathname;
const SCHEMA = join(DASH, '../mcp/trajectory-server/src/schema.sql');
const SERVER = join(DASH, 'dist/server.mjs');

const TITLE = 'Task page seeded task';
const ISSUE = 'Task page seeded issue';
const FILES = ['dashboard/server/', 'dashboard/web/'];
const VERIFICATION = ['bun run build', 'node --test dashboard/test/tasks.test.mjs'];
const REPORT = {
  criteria: [
    { id: 'SC1', status: 'met', evidence_cmd: 'curl /api/tasks/1' },
    { id: 'SC2', status: 'not_met', note: 'Header link missing' },
  ],
  extras: [{ path: 'README.md', reason: 'Document the endpoint' }],
  findings_fixed: ['F1-2'],
};
const XSS = '<script>alert(1)</script>';
const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const SECTIONS = ['Spec', 'Success criteria', 'Reviews', 'Verification runs', 'Agent runs'];

function seed(path) {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  const now = new Date().toISOString();
  const issue = Number(
    db.prepare('INSERT INTO issues (objective, created_at, updated_at) VALUES (?, ?, ?)').run(ISSUE, now, now).lastInsertRowid,
  );
  const insertTask = db.prepare(
    `INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, commit_sha, files, verification,
                        completion_report, effort, created_at, updated_at)
     VALUES (?, ?, ?, 'd', 'completed', ?, ?, ?, ?, ?, 'high', ?, ?)`,
  );
  const task = Number(
    insertTask.run(
      issue, 'feat/task-page', TITLE, '## Description\n\nBuild the **task page**.', SHA,
      JSON.stringify(FILES), JSON.stringify(VERIFICATION), JSON.stringify(REPORT), now, now,
    ).lastInsertRowid,
  );
  const broken = Number(
    insertTask.run(issue, 'feat/broken', 'Broken JSON task', '', null, 'not json', '[', '{bad', now, now).lastInsertRowid,
  );
  const attempt = db.prepare(
    'INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
  );
  attempt.run(task, 1, 'code-reviewer', 'fail', 'SC2 fails: no issue link.', now);
  attempt.run(task, 2, 'code-reviewer', 'pass', 'All criteria met.', now);
  const finding = db.prepare(
    `INSERT INTO review_findings (id, task_id, attempt_n, criterion_id, probe_cmd, expected, observed, status, created_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  );
  finding.run(`F${task}-1`, task, 'SC2', 'grep -c issues/ page.html', '1', '0', 'open', now);
  finding.run(`F${task}-2`, task, 'SC1', 'curl -s /api/tasks/x', '404', '500', 'fixed', now);
  const run = Number(
    db
      .prepare(
        `INSERT INTO verification_runs (id, task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out)
         VALUES (1, ?, ?, 'gate', ?, ?, 1, 600, 0)`,
      )
      .run(task, SHA, now, now).lastInsertRowid,
  );
  const cmd = db.prepare(
    'INSERT INTO verification_run_commands (run_id, ordinal, command, exit_code, elapsed_s, output_tail) VALUES (?, ?, ?, ?, ?, ?)',
  );
  cmd.run(run, 2, VERIFICATION[1], 1, 3.25, `not ok 1 ${XSS}`);
  cmd.run(run, 1, VERIFICATION[0], 0, 1.5, 'Done in 1s');
  db.prepare(
    `INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens,
                             duration_ms, started_at, completed_at, model, effort, exit_reason)
     VALUES (?, ?, 'swe', 1200, 3400, 56000, 7800, 90000, ?, ?, 'claude-opus', 'high', 'completed')`,
  ).run(task, issue, now, now);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return { issue, task, broken };
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
        import { TaskPage } from './web/views/tasks/TaskPage.tsx';
        import { TASK_ID_COLUMN, TASK_TITLE_COLUMN } from './web/shared/columns.tsx';
        const wrap = (el) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, el));
        export const page = (detail) => wrap(createElement(TaskPage, { detail }));
        export const cells = (row) => [TASK_ID_COLUMN, TASK_TITLE_COLUMN].map((c) => renderToStaticMarkup(c.cell(row)));`,
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

const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('dashboard task page', () => {
  const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tmb-dashboard-tasks-'));
  const dbPath = join(tmp, 'trajectory.db');
  const ids = seed(dbPath);
  const before_ = digest(dbPath);
  let server;
  let views;
  const fetchApi = (path) => fetch(`${server.url}api/${path}`);
  const get = async (path) => (await fetchApi(path)).json();

  before(async () => {
    [server, views] = await Promise.all([startServer(dbPath), loadViews()]);
  });
  after(async () => {
    await server?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('/api/tasks/:id returns the task, its issue, reviews, findings, verification runs and agent runs', async () => {
    const d = await get(`tasks/${ids.task}`);
    assert.deepEqual(Object.keys(d).sort(), ['agent_runs', 'findings', 'issue', 'task', 'validations', 'verifications']);
    const t = d.task;
    assert.equal(t.title, TITLE);
    assert.match(t.spec_body, /task page/);
    assert.deepEqual(t.files, FILES);
    assert.deepEqual(t.verification, VERIFICATION);
    assert.deepEqual(t.completion_report, REPORT);
    for (const key of ['status', 'effort', 'branch_id', 'repo', 'commit_sha', 'created_at', 'updated_at', 'completed_at']) {
      assert.ok(key in t, key);
    }
    assert.equal(t.effort, 'high');
    assert.deepEqual(d.issue, { id: ids.issue, objective: ISSUE });
    assert.deepEqual(d.validations.map((v) => [v.attempt_n, v.verdict]), [[1, 'fail'], [2, 'pass']]);
    assert.deepEqual(d.findings.map((f) => f.status), ['open', 'fixed']);
    assert.equal(d.verifications.length, 1);
    const cmds = d.verifications[0].commands;
    assert.deepEqual(cmds.map((c) => c.ordinal), [1, 2]);
    assert.deepEqual(Object.keys(cmds[0]).sort(), ['command', 'elapsed_s', 'exit_code', 'ordinal', 'output_tail']);
    assert.ok(cmds[1].output_tail.includes(XSS));
    const run = d.agent_runs[0];
    for (const key of ['tokens_in', 'tokens_out', 'cache_read_tokens', 'cache_creation_tokens', 'model', 'effort', 'exit_reason', 'duration_ms']) {
      assert.ok(run[key] !== undefined && run[key] !== null, key);
    }
    assert.equal(run.tokens_out, 3400);
  });

  test('bad JSON columns come back as null with the raw text under *_raw', async () => {
    const { task } = await get(`tasks/${ids.broken}`);
    assert.equal(task.files, null);
    assert.equal(task.files_raw, 'not json');
    assert.equal(task.verification, null);
    assert.equal(task.verification_raw, '[');
    assert.equal(task.completion_report, null);
    assert.equal(task.completion_report_raw, '{bad');
  });

  test('an unknown id is 404 task not found and a non-numeric id is unknown endpoint', async () => {
    const missing = await fetchApi('tasks/999999');
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'task not found' });
    const bad = await fetchApi('tasks/abc');
    assert.equal(bad.status, 404);
    assert.deepEqual(await bad.json(), { error: 'unknown endpoint' });
  });

  test('the task page renders its title, sections, escaped output, issue link and one <details> per run', async () => {
    const d = await get(`tasks/${ids.task}`);
    const html = views.page(d);
    assert.match(html, new RegExp(`<h2 [^>]*>${TITLE} <span[^>]*>#${ids.task}</span></h2>`));
    for (const s of SECTIONS) assert.match(html, new RegExp(`<h3 [^>]*>${s}</h3>`), s);
    assert.ok(!html.includes(XSS), 'raw <script> rendered');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.match(html, new RegExp(`<a href="#/issues/${ids.issue}"`));
    assert.equal((html.match(/<details/g) ?? []).length, d.verifications.length);
    assert.match(html, /<details open=""/);
    assert.match(html, /<strong>task page<\/strong>/);
    assert.match(html, />not met</);
    assert.match(html, /Header link missing/);
    assert.match(html, />F\d+-2</);
    assert.match(html, />abcdef1</);
    assert.match(html, /<pre tabindex="0" aria-label="Output of command 2"/);
  });

  test('empty sections show a muted line', async () => {
    const html = views.page(await get(`tasks/${ids.broken}`));
    for (const msg of ['No review verdicts yet.', 'No verification runs yet.', 'No agent runs recorded.']) assert.ok(html.includes(msg), msg);
    assert.ok(html.includes('Completion report (unparsed)'));
  });

  test('Runs & gates task id and title cells link to the task page', () => {
    for (const cell of views.cells({ task_id: ids.task, task_title: TITLE })) {
      assert.match(cell, new RegExp(`^<a href="#/tasks/${ids.task}"`));
    }
  });

  test('the server left the DB file unchanged', async () => {
    await server.stop();
    server = undefined;
    assert.equal(digest(dbPath), before_);
  });
});
