// World-model freshness test: start the built dashboard server against two
// temp DBs seeded from schema.sql. On the plain schema every world-model
// endpoint carries `freshness: null` and /api/world-model/status has no
// history. With repos.indexed_commit and a wm_freshness table added, every
// endpoint carries the exact freshness block (stale on a moved target, a
// running reindex or no indexed commit), the graph's block tracks the DB on a
// cache hit, status lists wm_reindex audit rows newest first, and every
// endpoint answers while another connection holds BEGIN IMMEDIATE, without the
// dashboard writing anything.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DASH = new URL('..', import.meta.url).pathname;
const SCHEMA = join(DASH, '../mcp/trajectory-server/src/schema.sql');
const SERVER = join(DASH, 'dist/server.mjs');
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const NOW = '2026-11-08T00:00:00Z';

const WM_FRESHNESS = `CREATE TABLE wm_freshness (
  repo TEXT PRIMARY KEY, target_ref TEXT, target_commit TEXT, target_fetched_at TEXT,
  reindex_state TEXT NOT NULL DEFAULT 'idle', reindex_mode TEXT, reindex_trigger TEXT,
  reindex_started_at TEXT, reindex_finished_at TEXT, reindex_elapsed_ms INTEGER,
  reindex_outcome TEXT, updated_at TEXT)`;

function seedPlain(path) {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  db.exec('DROP TABLE wm_freshness');
  db.exec('ALTER TABLE repos DROP COLUMN indexed_commit');
  db.prepare("INSERT INTO repos (name, path) VALUES ('plugin', '/tmp/plugin')").run();
  db.prepare(
    "INSERT INTO wm_directories (repo, path, parent_path, summary, summary_source, file_count) VALUES ('plugin', '', NULL, 'root', 'readme', 1)",
  ).run();
  const symbol = db.prepare(`INSERT INTO wm_symbols (repo, path, kind, qualified_name, body_hash) VALUES ('plugin', ?, 'function', ?, ?)`);
  const a = Number(symbol.run('src/a.ts', 'a', 'h1').lastInsertRowid);
  const b = Number(symbol.run('src/b.ts', 'b', 'h2').lastInsertRowid);
  db.prepare(`INSERT INTO wm_edges (src_id, dst_id, dst_name, kind, resolution) VALUES (?, ?, 'b', 'calls', 'exact')`).run(a, b);
  return db;
}

function seedFresh(path) {
  const db = seedPlain(path);
  db.exec('ALTER TABLE repos ADD COLUMN indexed_commit TEXT');
  db.exec(WM_FRESHNESS);
  db.prepare('UPDATE repos SET indexed_commit = ? WHERE name = ?').run(SHA, 'plugin');
  db.prepare(
    `INSERT INTO wm_freshness (repo, target_ref, target_commit, target_fetched_at, reindex_state, reindex_mode, reindex_trigger,
       reindex_started_at, reindex_finished_at, reindex_elapsed_ms, reindex_outcome, updated_at)
     VALUES ('plugin', 'origin/dev', ?, ?, 'idle', 'incremental', 'post_merge', ?, ?, 1234, 'ok', ?)`,
  ).run(SHA, NOW, NOW, NOW, NOW);
  const concept = db.prepare(`INSERT INTO wm_concepts (repo, kind, name, status, created_at, updated_at) VALUES ('plugin', 'flow', ?, ?, ?, ?)`);
  concept.run('one', 'suspect', NOW, NOW);
  concept.run('two', 'verified', NOW, NOW);
  db.prepare("INSERT INTO issues (id, objective, created_at, updated_at) VALUES (1, 'x', ?, ?)").run(NOW, NOW);
  const audit = db.prepare(`INSERT INTO audit (issue_id, event_type, summary, content_json, repo, created_at) VALUES (1, ?, 's', ?, 'plugin', ?)`);
  audit.run('wm_reindex', JSON.stringify({ repo: 'plugin', mode: 'full', reason: 'r1', trigger: 'scan', from_commit: null, to_commit: OTHER, files_diffed: 0, files_parsed: 9, dirs_touched: 3, ms: 10 }), '2026-11-08T00:00:01Z');
  audit.run('task_closed', '{}', '2026-11-08T00:00:02Z');
  audit.run('wm_reindex', JSON.stringify({ repo: 'plugin', mode: 'incremental', reason: 'r2', trigger: 'post_merge', from_commit: OTHER, to_commit: SHA, files_diffed: 2, files_parsed: 2, dirs_touched: 1, ms: 5 }), '2026-11-08T00:00:03Z');
  audit.run('wm_reindex', 'not json', '2026-11-08T00:00:04Z');
  return db;
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

function fixture(name, seed) {
  const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `tmb-dashboard-${name}-`));
  const dbPath = join(tmp, 'trajectory.db');
  const db = seed(dbPath);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return { tmp, dbPath, db };
}

const ENDPOINTS = ['world-model?repo=plugin', 'world-model/search?q=root', 'world-model/graph?repo=plugin'];
const EXISTING = { 'world-model?repo=plugin': ['available', 'repos', 'nodes'], 'world-model/search?q=root': ['available', 'hits'], 'world-model/graph?repo=plugin': ['available', 'repo', 'repos', 'files', 'edges'] };

async function getJson(server, path) {
  const res = await fetch(`${server.url}api/${path}`);
  assert.equal(res.status, 200, path);
  return { res, body: await res.json() };
}

describe('world-model freshness on the plain schema', () => {
  const { tmp, dbPath, db } = fixture('fresh-plain', seedPlain);
  let server;
  before(async () => {
    db.close();
    server = await startServer(dbPath);
  });
  after(async () => {
    await server?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('every world-model endpoint keeps its fields and adds freshness: null', async () => {
    for (const path of ENDPOINTS) {
      const { body } = await getJson(server, path);
      assert.deepEqual(Object.keys(body), [...EXISTING[path], 'freshness'], path);
      assert.equal(body.freshness, null, path);
      assert.equal(body.available, true, path);
    }
  });

  test('status lists each repo with freshness: null and no history', async () => {
    const { res, body } = await getJson(server, 'world-model/status');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(body, { repos: [{ repo: 'plugin', freshness: null }], history: [] });
  });
});

describe('world-model freshness with wm_freshness', () => {
  const { tmp, dbPath, db } = fixture('fresh-full', seedFresh);
  let server;
  const block = (over = {}) => ({
    indexed_commit: SHA,
    target_ref: 'origin/dev',
    target_commit: SHA,
    stale: false,
    reindex: { state: 'idle', mode: 'incremental', trigger: 'post_merge', started_at: NOW, finished_at: NOW, elapsed_ms: 1234, outcome: 'ok' },
    needs_review_count: 1,
    ...over,
  });
  const all = async () => {
    const out = [];
    for (const path of [...ENDPOINTS, 'world-model/search?q=root&repo=plugin', 'world-model']) out.push([path, (await getJson(server, path)).body.freshness]);
    const status = (await getJson(server, 'world-model/status')).body;
    out.push(['status', status.repos.find((r) => r.repo === 'plugin').freshness]);
    return out;
  };
  const reset = () => {
    db.prepare(`UPDATE wm_freshness SET target_commit = ?, reindex_state = 'idle' WHERE repo = 'plugin'`).run(SHA);
    db.prepare(`UPDATE repos SET indexed_commit = ? WHERE name = 'plugin'`).run(SHA);
  };

  before(async () => {
    server = await startServer(dbPath);
  });
  after(async () => {
    await server?.stop();
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('every endpoint carries the exact block, fresh, with one concept to review', async () => {
    for (const [path, f] of await all()) assert.deepEqual(f, block(), path);
  });

  test('a README pending review adds to needs_review_count', async () => {
    try {
      db.prepare(`UPDATE wm_directories SET readme_review_pending = 1 WHERE repo = 'plugin' AND path = ''`).run();
      for (const [path, f] of await all()) assert.deepEqual(f, block({ needs_review_count: 2 }), path);
    } finally {
      db.prepare(`UPDATE wm_directories SET readme_review_pending = 0 WHERE repo = 'plugin'`).run();
    }
  });

  test('a moved target, a running reindex or no indexed commit is stale', async () => {
    try {
      db.prepare(`UPDATE wm_freshness SET target_commit = ? WHERE repo = 'plugin'`).run(OTHER);
      for (const [path, f] of await all()) assert.deepEqual(f, block({ target_commit: OTHER, stale: true }), path);
      reset();
      db.prepare(`UPDATE wm_freshness SET reindex_state = 'running' WHERE repo = 'plugin'`).run();
      for (const [path, f] of await all()) assert.deepEqual(f, block({ stale: true, reindex: { ...block().reindex, state: 'running' } }), path);
      reset();
      db.prepare(`UPDATE repos SET indexed_commit = NULL WHERE name = 'plugin'`).run();
      for (const [path, f] of await all()) assert.deepEqual(f, block({ indexed_commit: null, stale: true }), path);
    } finally {
      reset();
    }
  });

  test('the graph adds freshness outside its cache; a 304 stays empty', async () => {
    const first = await fetch(`${server.url}api/world-model/graph?repo=plugin`);
    const etag = first.headers.get('etag');
    await first.json();
    try {
      db.prepare(`UPDATE wm_freshness SET reindex_state = 'running' WHERE repo = 'plugin'`).run();
      const hit = await fetch(`${server.url}api/world-model/graph?repo=plugin`);
      assert.equal(hit.headers.get('x-tmb-graph-cache'), 'hit');
      assert.equal(hit.headers.get('etag'), etag);
      assert.equal((await hit.json()).freshness.reindex.state, 'running');
      const notModified = await fetch(`${server.url}api/world-model/graph?repo=plugin`, { headers: { 'if-none-match': etag } });
      assert.equal(notModified.status, 304);
      assert.equal(await notModified.text(), '');
    } finally {
      reset();
    }
  });

  test('status returns wm_reindex rows newest first, flattened, and honours limit', async () => {
    const { body } = await getJson(server, 'world-model/status');
    assert.deepEqual(
      body.history.map((h) => [h.created_at, h.reason ?? null]),
      [['2026-11-08T00:00:04Z', null], ['2026-11-08T00:00:03Z', 'r2'], ['2026-11-08T00:00:01Z', 'r1']],
    );
    assert.deepEqual(Object.keys(body.history[2]), ['id', 'created_at', 'repo', 'mode', 'reason', 'trigger', 'from_commit', 'to_commit', 'files_diffed', 'files_parsed', 'dirs_touched', 'ms']);
    assert.deepEqual(body.history[1], {
      id: body.history[1].id, created_at: '2026-11-08T00:00:03Z', repo: 'plugin', mode: 'incremental', reason: 'r2', trigger: 'post_merge',
      from_commit: OTHER, to_commit: SHA, files_diffed: 2, files_parsed: 2, dirs_touched: 1, ms: 5,
    });
    assert.deepEqual(Object.keys(body.history[0]), ['id', 'created_at', 'repo']);
    assert.ok(body.history[0].id > body.history[1].id);
    const one = (await getJson(server, 'world-model/status?limit=1')).body.history;
    assert.deepEqual(one.map((h) => h.created_at), ['2026-11-08T00:00:04Z']);
    assert.equal((await getJson(server, 'world-model/status?limit=0')).body.history.length, 1);
    assert.equal((await getJson(server, 'world-model/status?limit=500')).body.history.length, 3);
  });

  test('every endpoint answers while another connection holds BEGIN IMMEDIATE, and nothing is written', async () => {
    const dump = () =>
      Object.fromEntries(
        ['repos', 'wm_freshness', 'wm_concepts', 'wm_directories', 'wm_files', 'wm_symbols', 'wm_edges', 'audit'].map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]),
      );
    const before = dump();
    const lock = new DatabaseSync(dbPath);
    lock.exec('PRAGMA busy_timeout = 0');
    lock.exec('BEGIN IMMEDIATE');
    try {
      for (const path of [...ENDPOINTS, 'world-model/status']) {
        const { body } = await getJson(server, path);
        if (path !== 'world-model/status') assert.deepEqual(body.freshness, block(), path);
      }
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
    }
    assert.deepEqual(dump(), before);
  });
});

describe('world-model freshness on a v63 DB without readme_review_pending', () => {
  const { tmp, dbPath, db } = fixture('fresh-v63', (path) => {
    const seeded = seedFresh(path);
    seeded.exec('ALTER TABLE wm_directories DROP COLUMN readme_review_pending');
    return seeded;
  });
  let server;
  before(async () => {
    db.close();
    server = await startServer(dbPath);
  });
  after(async () => {
    await server?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('every endpoint still carries the block, counting concepts only', async () => {
    for (const path of [...ENDPOINTS, 'world-model/status']) {
      const { body } = await getJson(server, path);
      const f = path === 'world-model/status' ? body.repos.find((r) => r.repo === 'plugin').freshness : body.freshness;
      assert.equal(f?.needs_review_count, 1, path);
      assert.equal(f.indexed_commit, SHA, path);
    }
  });
});
