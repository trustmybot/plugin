// File graph endpoint test: seed a temp trajectory DB from schema.sql with
// symbols in four files of one repo plus one in another repo, edges of several
// kinds (one file pair linked by both calls and imports, a same-file edge, a
// cross-repo edge and a reads_table edge), start the built dashboard server
// against it and check /api/world-model/graph merges parallel kinds into one
// weighted edge per ordered file pair and drops the rest; then unit-test that
// summaryLine skips a leading horizontal rule.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { summaryLine } from '../server/queries.ts';

const DASH = new URL('..', import.meta.url).pathname;
const SCHEMA = join(DASH, '../mcp/trajectory-server/src/schema.sql');
const SERVER = join(DASH, 'dist/server.mjs');

const SYMBOLS = [
  ['plugin', 'src/boot/start.ts', 'startServer'],
  ['plugin', 'src/boot/start.ts', 'loadConfig'],
  ['plugin', 'src/db/open.ts', 'openDatabase'],
  ['plugin', 'src/db/open.ts', 'DbHandle'],
  ['plugin', 'lib/log.ts', 'writeLog'],
  ['plugin', 'lib/unused.ts', 'readTable'],
  ['other', 'vendor/ext.ts', 'external'],
];
const EDGES = [
  ['startServer', 'openDatabase', 'calls'],
  ['loadConfig', 'openDatabase', 'calls'],
  ['startServer', 'DbHandle', 'imports'],
  ['startServer', 'loadConfig', 'calls'],
  ['openDatabase', 'writeLog', 'runs'],
  ['openDatabase', 'external', 'calls'],
  ['writeLog', 'readTable', 'reads_table'],
];

function seed(path) {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  const dir = db.prepare(
    "INSERT INTO wm_directories (repo, path, parent_path, summary, summary_source, file_count) VALUES (?, '', NULL, 'root', 'readme', 1)",
  );
  dir.run('plugin');
  dir.run('other');
  db.prepare(
    "INSERT INTO wm_files (repo, path, dir, purpose, updated_at) VALUES ('plugin', 'src/boot/start.ts', 'src/boot', ?, ?)",
  ).run('---\n## Boots the server\n\nmore', new Date().toISOString());
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

describe('dashboard file graph API', () => {
  const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tmb-dashboard-graph-'));
  const dbPath = join(tmp, 'trajectory.db');
  seed(dbPath);
  let server;
  let graph;
  const edge = (src, dst) => {
    const i = graph.files.findIndex((f) => f.path === src);
    const j = graph.files.findIndex((f) => f.path === dst);
    return graph.edges.find((e) => e.src === i && e.dst === j);
  };

  before(async () => {
    server = await startServer(dbPath);
    graph = await (await fetch(`${server.url}api/world-model/graph`)).json();
  });
  after(async () => {
    await server?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('defaults to the first repo and returns files and edges', () => {
    assert.equal(graph.available, true);
    assert.equal(graph.repo, 'other');
    assert.deepEqual(graph.repos, ['other', 'plugin']);
    assert.deepEqual(graph.files, []);
  });

  test('parallel kinds merge into one weighted edge per ordered pair', async () => {
    graph = await (await fetch(`${server.url}api/world-model/graph?repo=plugin`)).json();
    assert.equal(graph.repo, 'plugin');
    assert.ok(graph.files.length > 0);
    assert.ok(graph.edges.length > 0);
    assert.deepEqual(edge('src/boot/start.ts', 'src/db/open.ts'), {
      src: graph.files.findIndex((f) => f.path === 'src/boot/start.ts'),
      dst: graph.files.findIndex((f) => f.path === 'src/db/open.ts'),
      kind: 'calls',
      weight: 3,
    });
    assert.equal(edge('src/db/open.ts', 'lib/log.ts').kind, 'runs');
    assert.equal(graph.edges.length, 2);
  });

  test('no self edges, no cross-repo edges, no excluded kinds', () => {
    assert.ok(graph.edges.every((e) => e.src !== e.dst));
    assert.ok(graph.edges.every((e) => graph.files[e.src] && graph.files[e.dst]));
    const paths = graph.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ['lib/log.ts', 'src/boot/start.ts', 'src/db/open.ts']);
  });

  test('purpose is one plain line, empty when the file has none', () => {
    assert.equal(graph.files.find((f) => f.path === 'src/boot/start.ts').purpose, 'Boots the server');
    assert.equal(graph.files.find((f) => f.path === 'lib/log.ts').purpose, '');
  });
});

describe('summaryLine horizontal rules', () => {
  test('a leading ---, *** or ___ is skipped', () => {
    assert.equal(summaryLine('---\nTitle line'), 'Title line');
    assert.equal(summaryLine('***\n\n# Heading'), 'Heading');
    assert.equal(summaryLine(' _ _ _\nText'), 'Text');
    assert.equal(summaryLine('--- not a rule'), '--- not a rule');
  });
});
