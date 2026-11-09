// Push-gate board test: seed a temp trajectory DB from schema.sql with four
// live branches (ready, blocked by a failed verification, blocked by an open
// blocking finding, pending with no verification) and one closed branch idle
// for 30 days. Check gateBoard(db) states, order and task fields, that
// GET /api/gate-board returns the same body, and that the Runs tab renders the
// Push Gate section above Agent Runs with task links.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { importServer } from './server-module.mjs';

const DASH = new URL('..', import.meta.url).pathname;
const SCHEMA = join(DASH, '../mcp/trajectory-server/src/schema.sql');
const SERVER = join(DASH, 'dist/server.mjs');
const SHA = (c) => c.repeat(40);
const DAY_MS = 86_400_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

function seed(path) {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  const now = ago(0);
  const task = (branch, title, status, sha, updated) => {
    const issue = db
      .prepare('INSERT INTO issues (objective, created_at, updated_at) VALUES (?, ?, ?)')
      .run(`Issue for ${title}`, now, now).lastInsertRowid;
    return Number(
      db
        .prepare(
          `INSERT INTO tasks (issue_id, branch_id, title, description, status, commit_sha, created_at, updated_at)
           VALUES (?, ?, ?, 'd', ?, ?, ?, ?)`,
        )
        .run(issue, branch, title, status, sha, updated, updated).lastInsertRowid,
    );
  };
  const verify = (taskId, sha, exit, timedOut = 0) =>
    db
      .prepare(
        `INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out)
         VALUES (?, ?, 'gate', ?, ?, ?, 600, ?)`,
      )
      .run(taskId, sha, now, now, exit, timedOut);
  const verdict = (taskId, n, v) =>
    db
      .prepare('INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run(taskId, n, 'code-reviewer', v, 'f', now);
  const finding = (id, taskId, status, severity) =>
    db
      .prepare(
        `INSERT INTO review_findings (id, task_id, attempt_n, probe_cmd, expected, observed, status, severity, created_at)
         VALUES (?, ?, 1, 'true', '0', '1', ?, ?, ?)`,
      )
      .run(id, taskId, status, severity, now);

  const ids = {};
  ids.closedOld = task('chore/old', 'Old closed task', 'closed', SHA('0'), ago(30 * DAY_MS));

  ids.pending = task('chore/pending', 'Pending task', 'running', null, ago(4000));

  ids.finding = task('fix/finding', 'Finding task', 'completed', SHA('c'), ago(3000));
  verify(ids.finding, SHA('c'), 0);
  verdict(ids.finding, 1, 'pass');
  finding(`F${ids.finding}-1`, ids.finding, 'open', 'blocking');

  ids.failed = task('fix/failed-verify', 'Failed verify task', 'completed', SHA('b'), ago(2000));
  verify(ids.failed, SHA('b'), 0);
  verify(ids.failed, SHA('b'), 1);
  verdict(ids.failed, 1, 'pass');

  ids.readyClosed = task('feat/ready', 'Ready closed task', 'closed', null, ago(1500));
  ids.ready = task('feat/ready', 'Ready task', 'completed', SHA('a'), ago(1000));
  verify(ids.ready, SHA('9'), 1);
  verify(ids.ready, SHA('a'), 0);
  verdict(ids.ready, 1, 'fail');
  verdict(ids.ready, 2, 'pass');
  finding(`F${ids.ready}-1`, ids.ready, 'open', 'nit');
  finding(`F${ids.ready}-2`, ids.ready, 'fixed', 'blocking');

  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return ids;
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

async function loadView() {
  const out = await build({
    stdin: {
      contents: `import { renderToStaticMarkup } from 'react-dom/server';
        import { createElement } from 'react';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { RunsView } from './web/views/RunsView.tsx';
        export const runs = (board) => {
          const client = new QueryClient();
          client.setQueryData(['gate-board'], board);
          client.setQueryData(['agent-runs'], []);
          client.setQueryData(['gates'], { validations: [], verifications: [] });
          return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(RunsView)));
        };`,
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

describe('dashboard push-gate board', () => {
  const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tmb-dashboard-gate-board-'));
  const dbPath = join(tmp, 'trajectory.db');
  const ids = seed(dbPath);
  let server;
  let board;
  let view;

  before(async () => {
    const [srv, q, v] = await Promise.all([startServer(dbPath), importServer('queries.ts'), loadView()]);
    server = srv;
    view = v;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    board = q.gateBoard(db);
    db.close();
  });
  after(async () => {
    await server?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('one entry per live branch, newest first, with its derived state', () => {
    assert.deepEqual(
      board.map((b) => [b.branch_id, b.state]),
      [
        ['feat/ready', 'ready'],
        ['fix/failed-verify', 'blocked'],
        ['fix/finding', 'blocked'],
        ['chore/pending', 'pending'],
      ],
    );
    for (const b of board) assert.deepEqual(Object.keys(b).sort(), ['branch_id', 'state', 'tasks', 'updated_at']);
  });

  test('each task carries its newest verification, newest verdict and open blocking findings', () => {
    const tasks = Object.fromEntries(board.flatMap((b) => b.tasks).map((t) => [t.id, t]));
    const ready = tasks[ids.ready];
    assert.equal(ready.title, 'Ready task');
    assert.equal(ready.status, 'completed');
    assert.equal(ready.commit_sha, SHA('a'));
    assert.ok(ready.verification.id > 0);
    assert.deepEqual({ ...ready.verification, id: 0 }, { id: 0, exit_code: 0, timed_out: false, commit_sha: SHA('a'), matches_commit: true });
    assert.ok(ready.verdict.id > 0);
    assert.equal(ready.verdict.verdict, 'pass');
    assert.equal(ready.verdict.attempt_n, 2);
    assert.equal(ready.open_findings, 0);
    assert.equal(tasks[ids.readyClosed].verification, null);

    assert.equal(tasks[ids.failed].verification.exit_code, 1);
    assert.equal(tasks[ids.failed].verdict.verdict, 'pass');
    assert.equal(tasks[ids.finding].open_findings, 1);
    assert.equal(tasks[ids.finding].verification.matches_commit, true);
    assert.equal(tasks[ids.pending].verification, null);
    assert.equal(tasks[ids.pending].verdict, null);
    assert.equal(tasks[ids.closedOld], undefined);
  });

  test('GET /api/gate-board returns the same body with status 200', async () => {
    const res = await fetch(`${server.url}api/gate-board`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), board);
  });

  test('the Runs tab renders Push Gate above Agent Runs with branch states and task links', () => {
    const html = view.runs(board);
    const order = ['Push Gate', 'Agent Runs', 'Review Verdicts', 'Verification Runs'].map((h) => html.indexOf(`>${h}</h2>`));
    assert.ok(order.every((i) => i >= 0), String(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    for (const state of ['ready', 'blocked', 'pending']) assert.ok(html.includes(`>${state}<`), state);
    for (const id of [ids.ready, ids.failed, ids.finding, ids.pending]) assert.ok(html.includes(`href="#/tasks/${id}"`), String(id));
  });
});
