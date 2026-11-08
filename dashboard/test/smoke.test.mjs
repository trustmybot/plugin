// Smoke test: seed a temp trajectory DB from schema.sql (with world-model rows),
// start the built dashboard server on a free port against it, check the page and
// the JSON API, and check the server left the DB file unchanged. Then repeat the
// world-model checks against a DB without the wm_* tables (below v42).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DASH = new URL('..', import.meta.url).pathname;
const SCHEMA = join(DASH, '../mcp/trajectory-server/src/schema.sql');
const SERVER = join(DASH, 'dist/server.mjs');
const TITLE = 'Dashboard smoke seeded issue';
const WM_TABLES = [
  'wm_directories_embeddings',
  'wm_files_embeddings',
  'wm_directories_fts',
  'wm_files_fts',
  'wm_directories',
  'wm_files',
];

assert.ok(existsSync(SERVER), `${SERVER} missing; run bun run build in dashboard/`);

function seed(path) {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  const now = new Date().toISOString();
  const issue = Number(
    db.prepare('INSERT INTO issues (objective, created_at, updated_at) VALUES (?, ?, ?)').run(TITLE, now, now).lastInsertRowid,
  );
  const task = Number(
    db
      .prepare(
        "INSERT INTO tasks (issue_id, branch_id, title, description, created_at, updated_at) VALUES (?, 'feat/smoke', 'Smoke task', 'd', ?, ?)",
      )
      .run(issue, now, now).lastInsertRowid,
  );
  db.prepare("INSERT INTO discussions (issue_id, author, body, created_at) VALUES (?, 'bro', 'Smoke discussion', ?)").run(issue, now);
  db.prepare("INSERT INTO audit (issue_id, event_type, summary, created_at) VALUES (?, 'smoke', 'Smoke audit row', ?)").run(issue, now);
  const dir = db.prepare(
    "INSERT INTO wm_directories (repo, path, parent_path, summary, summary_source, file_count) VALUES ('plugin', ?, ?, ?, 'readme', ?)",
  );
  dir.run('', null, 'Plugin root', 3);
  dir.run('dashboard', '', 'Smokemap dashboard module', 2);
  dir.run('dashboard/server', 'dashboard', 'HTTP server', 1);
  db.prepare(
    "INSERT INTO wm_files (repo, path, dir, purpose, updated_at) VALUES ('plugin', 'dashboard/server/main.ts', 'dashboard/server', 'Smokemap server entry', ?)",
  ).run(now);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return { issue, task };
}

function seedV41(path) {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  for (const table of WM_TABLES) db.exec(`DROP TABLE ${table}`);
  db.exec('UPDATE plugin_meta SET schema_version = 41');
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
    const stop = () =>
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise((done) => (child.once('exit', done), child.kill()));
    const timer = setTimeout(() => (child.kill(), reject(new Error(`server did not start: ${out}`))), 5000);
    const onData = (chunk) => {
      out += chunk;
      const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(out)?.[0];
      if (url) clearTimeout(timer), resolve({ url, stop });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => (clearTimeout(timer), reject(new Error(`server exited ${code}: ${out}`))));
  });
}

const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function check(server, path, expect) {
  test(`GET /${path}`, async () => {
    const res = await fetch(server().url + path, { signal: AbortSignal.timeout(5000) });
    const body = await res.text();
    assert.equal(res.status, 200, `GET /${path} → HTTP ${res.status}`);
    if (expect) assert.ok(body.includes(expect), `GET /${path}: body lacks ${JSON.stringify(expect)}\n${body.slice(0, 500)}`);
  });
}

const tmp = mkdtempSync(join(tmpdir(), 'tmb-dashboard-smoke-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe('seeded DB', () => {
  const db = join(tmp, 'trajectory.db');
  const { issue, task } = seed(db);
  const before_ = hash(db);
  let server;
  before(async () => (server = await startServer(db)));
  after(() => server?.stop());
  const get = () => server;

  check(get, '', '<div id="root">');
  check(get, 'api/summary', '"open":1');
  check(get, 'api/issues', TITLE);
  check(get, `api/issues/${issue}`, TITLE);
  check(get, 'api/version', '"data_version"');
  check(get, 'api/tasks', 'Smoke task');
  check(get, `api/tasks/${task}`, '"title":"Smoke task"');
  check(get, `tasks/${task}`, '<div id="root">');
  check(get, 'api/agent-runs', '');
  check(get, 'api/gates', '"verifications"');
  check(get, 'api/audit?limit=5', 'Smoke audit row');
  check(get, `issues/${issue}`, '<div id="root">');
  check(get, 'api/world-model', '"available":true');
  check(get, 'api/world-model', '"path":"dashboard/server"');
  check(get, 'api/world-model?depth=0', '"repos":["plugin"],"nodes":[{"repo":"plugin","path":"",');
  check(get, 'api/world-model?repo=plugin&path=dashboard&depth=1', '"summary":"HTTP server"');
  check(get, 'api/world-model/search?q=smokemap', '"path":"dashboard"');
  check(get, 'api/world-model/search?q=smokemap', '"path":"dashboard/server/main.ts"');
  check(get, 'api/world-model/search?q=foo%22(', '"available":true');
  check(get, 'api/world-model/search?q=%22%20OR%20*%20NEAR(', '"hits":[]');
  check(get, 'api/world-model/search?q=((', '"hits":[]');
  check(get, 'api/world-model/search?q=smokemap&limit=1', '"kind"');
  check(get, 'api/world-model?depth=99&path=nowhere', '"nodes":[]');
  check(get, 'api/world-model/graph', '"available":true,"repo":"plugin"');

  test('DB file unchanged after the server stops', async () => {
    await server.stop();
    assert.equal(hash(db), before_, 'the server changed the DB file');
  });
});

describe('without world-model tables (v41)', () => {
  const db = join(tmp, 'trajectory-v41.db');
  seedV41(db);
  let server;
  before(async () => (server = await startServer(db)));
  after(() => server?.stop());
  const get = () => server;

  check(get, 'api/world-model', '{"available":false,"repos":[],"nodes":[]}');
  check(get, 'api/world-model/search?q=smokemap', '{"available":false,"hits":[]}');
  check(get, 'api/world-model/graph', '{"available":false,"repo":null,"repos":[],"files":[],"edges":[]}');
  check(get, 'api/summary', '"open_runs"');
});
