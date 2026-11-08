// File graph cache test: seed a temp trajectory DB from schema.sql with
// symbols and edges in one repo, start the built dashboard server against it
// and check /api/world-model/graph serves a repeat GET from the cache, answers
// a matching If-None-Match with 304, drops the entry after an edge insert,
// a rowid-reusing delete+reinsert or an in-place UPDATE through a separate
// connection, and stamps the ETag with
// repos.indexed_commit when that column exists.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cachedGraph, etagMatches, graphRollups } from '../server/graph-cache.ts';
import { graph } from '../server/queries.ts';

const DASH = new URL('..', import.meta.url).pathname;
const SCHEMA = join(DASH, '../mcp/trajectory-server/src/schema.sql');
const SERVER = join(DASH, 'dist/server.mjs');

const SYMBOLS = [
  ['plugin', 'src/boot/start.ts', 'startServer'],
  ['plugin', 'src/db/open.ts', 'openDatabase'],
  ['plugin', 'lib/log.ts', 'writeLog'],
];
const EDGES = [
  ['startServer', 'openDatabase', 'calls'],
  ['openDatabase', 'writeLog', 'runs'],
];

function seed(path) {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  db.prepare(
    "INSERT INTO wm_directories (repo, path, parent_path, summary, summary_source, file_count) VALUES ('plugin', '', NULL, 'root', 'readme', 1)",
  ).run();
  db.prepare("INSERT INTO repos (name, path) VALUES ('plugin', '/tmp/plugin')").run();
  const ids = {};
  const symbol = db.prepare(
    `INSERT INTO wm_symbols (repo, path, kind, qualified_name, body_hash) VALUES (?, ?, 'function', ?, ?)`,
  );
  SYMBOLS.forEach(([repo, file, name], i) => {
    ids[name] = Number(symbol.run(repo, file, name, `h${i}`).lastInsertRowid);
  });
  const edge = db.prepare(`INSERT INTO wm_edges (src_id, dst_id, dst_name, kind, resolution) VALUES (?, ?, ?, ?, 'exact')`);
  for (const [src, dst, kind] of EDGES) edge.run(ids[src], ids[dst], dst, kind);
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

function fixture(name) {
  const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `tmb-dashboard-${name}-`));
  const dbPath = join(tmp, 'trajectory.db');
  const ids = seed(dbPath);
  return { tmp, dbPath, ids };
}

describe('dashboard file graph cache', () => {
  const { tmp, dbPath, ids } = fixture('graph-cache');
  let server;
  const get = (headers = {}) => fetch(`${server.url}api/world-model/graph?repo=plugin`, { headers });

  before(async () => {
    server = await startServer(dbPath);
  });
  after(async () => {
    await server?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('a repeat GET returns the same body from the cache', async () => {
    const first = await get();
    const second = await get();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.headers.get('x-tmb-graph-cache'), 'miss');
    assert.equal(second.headers.get('x-tmb-graph-cache'), 'hit');
    assert.equal(await first.text(), await second.text());
  });

  test('the cached body is byte-identical to the uncached graph, and the rollup runs once', () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const before = graphRollups();
      const a = cachedGraph(db, 'plugin');
      const b = cachedGraph(db, 'plugin');
      assert.equal(graphRollups() - before, 1);
      assert.equal(a.body, JSON.stringify(graph(db, 'plugin')));
      assert.equal(b.body, a.body);
      assert.equal(b.hit, true);
    } finally {
      db.close();
    }
  });

  test('200 carries an etag; If-None-Match with it gets an empty 304', async () => {
    const res = await get();
    const etag = res.headers.get('etag');
    assert.match(etag, /^"[^"]+"$/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    for (const inm of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const again = await get({ 'if-none-match': inm });
      assert.equal(again.status, 304, inm);
      assert.equal(again.headers.get('etag'), etag);
      assert.equal(await again.text(), '');
    }
    const miss = await get({ 'if-none-match': '"other"' });
    assert.equal(miss.status, 200);
    assert.equal(await miss.text(), await (await get()).text());
  });

  test('an edge written through another connection changes the etag and the body', async () => {
    const old = await get();
    const oldTag = old.headers.get('etag');
    const oldBody = await old.json();
    const writer = new DatabaseSync(dbPath);
    writer
      .prepare(`INSERT INTO wm_edges (src_id, dst_id, dst_name, kind, resolution) VALUES (?, ?, 'startServer', 'calls', 'exact')`)
      .run(ids.writeLog, ids.startServer);
    writer.close();
    const res = await get({ 'if-none-match': oldTag });
    assert.equal(res.status, 200);
    assert.notEqual(res.headers.get('etag'), oldTag);
    const body = await res.json();
    assert.equal(body.edges.length, oldBody.edges.length + 1);
    const i = body.files.findIndex((f) => f.path === 'lib/log.ts');
    const j = body.files.findIndex((f) => f.path === 'src/boot/start.ts');
    assert.ok(body.edges.some((e) => e.src === i && e.dst === j && e.kind === 'calls'));
  });

  const fresh = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return graph(db, 'plugin');
    } finally {
      db.close();
    }
  };
  const rewriteMisses = async (rewrite) => {
    const old = await get();
    const oldTag = old.headers.get('etag');
    const oldBody = await old.text();
    const writer = new DatabaseSync(dbPath);
    const shape = () => writer.prepare('SELECT MAX(rowid) AS m, COUNT(*) AS c FROM wm_edges').get();
    const before = shape();
    rewrite(writer);
    assert.deepEqual(shape(), before);
    writer.close();
    const res = await get({ 'if-none-match': oldTag });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-tmb-graph-cache'), 'miss');
    assert.notEqual(res.headers.get('etag'), oldTag);
    const body = await res.text();
    assert.notEqual(body, oldBody);
    assert.deepEqual(JSON.parse(body), { ...fresh(), freshness: null });
  };

  test('a delete+reinsert that reuses the top edge rowid misses the cache', async () => {
    await rewriteMisses((writer) => {
      const top = writer.prepare('SELECT rowid, src_id FROM wm_edges ORDER BY rowid DESC LIMIT 1').get();
      writer.prepare('DELETE FROM wm_edges WHERE rowid = ?').run(top.rowid);
      const dst = top.src_id === ids.openDatabase ? ids.startServer : ids.openDatabase;
      const rowid = writer
        .prepare(`INSERT INTO wm_edges (src_id, dst_id, dst_name, kind, resolution) VALUES (?, ?, 'x', 'imports', 'exact')`)
        .run(top.src_id, dst).lastInsertRowid;
      assert.equal(Number(rowid), Number(top.rowid));
    });
  });

  test('an in-place UPDATE of an edge target misses the cache', async () => {
    await rewriteMisses((writer) => {
      const top = writer.prepare('SELECT rowid, src_id, dst_id FROM wm_edges ORDER BY rowid DESC LIMIT 1').get();
      const dst = [ids.startServer, ids.openDatabase, ids.writeLog].find((id) => id !== top.src_id && id !== top.dst_id);
      writer.prepare('UPDATE wm_edges SET dst_id = ? WHERE rowid = ?').run(dst, top.rowid);
    });
  });
});

describe('dashboard file graph cache with repos.indexed_commit', () => {
  const { tmp, dbPath } = fixture('graph-commit');
  let server;
  const etag = async () => (await fetch(`${server.url}api/world-model/graph?repo=plugin`)).headers.get('etag');
  const setCommit = (sha) => {
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE repos SET indexed_commit = ? WHERE name = 'plugin'").run(sha);
    db.close();
  };

  before(async () => {
    const db = new DatabaseSync(dbPath);
    db.exec('ALTER TABLE repos ADD COLUMN indexed_commit TEXT');
    db.close();
    server = await startServer(dbPath);
  });
  after(async () => {
    await server?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('the etag carries the indexed commit and follows it', async () => {
    const unset = await etag();
    assert.match(unset, /^"plugin@e/);
    setCommit('1111111aaaaaaa');
    const first = await etag();
    assert.ok(first.includes('1111111aaaaaaa'), first);
    setCommit('2222222bbbbbbb');
    const second = await etag();
    assert.ok(second.includes('2222222bbbbbbb'), second);
    assert.notEqual(first, second);
  });
});

describe('graph etag across server processes', () => {
  const { tmp, dbPath } = fixture('graph-restart');
  after(() => rmSync(tmp, { recursive: true, force: true }));

  test('a restarted server on an unchanged DB gives a new etag, so an old tag gets 200, not 304', async () => {
    const url = (s) => `${s.url}api/world-model/graph?repo=plugin`;
    const first = await startServer(dbPath);
    let oldTag;
    try {
      oldTag = (await fetch(url(first))).headers.get('etag');
    } finally {
      await first.stop();
    }
    const second = await startServer(dbPath);
    try {
      const res = await fetch(url(second), { headers: { 'if-none-match': oldTag } });
      assert.equal(res.status, 200);
      assert.notEqual(res.headers.get('etag'), oldTag);
      assert.ok((await res.text()).length > 0);
    } finally {
      await second.stop();
    }
  });
});

describe('graph cache without the symbol graph', () => {
  test('no etag and the plain body', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const res = cachedGraph(db, null);
      assert.equal(res.etag, null);
      assert.equal(res.body, JSON.stringify(graph(db, null)));
    } finally {
      db.close();
    }
  });
});

describe('etagMatches', () => {
  test('matches *, the tag, its weak form and a list; nothing else', () => {
    assert.equal(etagMatches(undefined, '"a"'), false);
    assert.equal(etagMatches('*', '"a"'), true);
    assert.equal(etagMatches('"a"', '"a"'), true);
    assert.equal(etagMatches('W/"a"', '"a"'), true);
    assert.equal(etagMatches('"b" , "a"', '"a"'), true);
    assert.equal(etagMatches('"b"', '"a"'), false);
  });
});
