// Health panel test: seed a temp trajectory DB from schema.sql with a closed
// issue that still has a running task (a failing error contract), a suspect
// concept, a stale world-model index and embedded rows; start the built
// dashboard server and check GET /api/health returns schema, contracts (the
// same ids and pass/fail as the trajectory doctor's checkTrajectoryDbFile),
// freshness, concept trust and embedding counts, all populated. Then render
// the Health section from a seeded QueryClient and check its heading, a
// failing-contract row and the stale badge each carry a text label.
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
const NOW = '2026-11-08T00:00:00Z';
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const { checkTrajectoryDbFile } = await importServer('../../mcp/trajectory-server/src/tools/trajectory-doctor.ts');

function seed(path) {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  db.prepare("INSERT INTO repos (name, path, indexed_commit) VALUES ('plugin', '/tmp/plugin', ?)").run(SHA);
  db.prepare(
    `INSERT INTO wm_freshness (repo, target_ref, target_commit, reindex_state, updated_at) VALUES ('plugin', 'origin/dev', ?, 'idle', ?)`,
  ).run(OTHER, NOW);
  const dir = Number(
    db
      .prepare("INSERT INTO wm_directories (repo, path, parent_path, summary, summary_source, file_count) VALUES ('plugin', '', NULL, 'root', 'readme', 1)")
      .run().lastInsertRowid,
  );
  const file = Number(
    db.prepare("INSERT INTO wm_files (repo, path, dir, purpose, updated_at) VALUES ('plugin', 'a.ts', '', 'entry', ?)").run(NOW).lastInsertRowid,
  );
  db.prepare("INSERT INTO wm_files (repo, path, dir, purpose, updated_at) VALUES ('plugin', 'b.ts', '', 'helper', ?)").run(NOW);
  db.prepare("INSERT INTO wm_directories_embeddings (dir_id, embedding, model_id, embedded_at) VALUES (?, x'00', 'm', ?)").run(dir, NOW);
  db.prepare("INSERT INTO wm_files_embeddings (file_id, embedding, model_id, embedded_at) VALUES (?, x'00', 'm', ?)").run(file, NOW);
  const concept = db.prepare(`INSERT INTO wm_concepts (repo, kind, name, status, created_at, updated_at) VALUES ('plugin', 'flow', ?, ?, ?, ?)`);
  const verified = Number(concept.run('one', 'verified', NOW, NOW).lastInsertRowid);
  concept.run('two', 'suspect', NOW, NOW);
  db.prepare(
    `INSERT INTO wm_concept_steps (concept_id, ordinal, repo, path, description, hash_at_verify, trust) VALUES (?, 1, 'plugin', 'a.ts', 'd', 'h', 'verified')`,
  ).run(verified);
  db.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'x', 'closed', ?, ?)").run(NOW, NOW);
  db.prepare("INSERT INTO tasks (issue_id, branch_id, description, status, created_at, updated_at) VALUES (1, 'b', 'd', 'running', ?, ?)").run(NOW, NOW);
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

describe('GET /api/health', () => {
  const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tmb-dashboard-health-'));
  const dbPath = join(tmp, 'trajectory.db');
  let server;
  let body;
  before(async () => {
    seed(dbPath);
    server = await startServer(dbPath);
    const res = await fetch(`${server.url}api/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    body = await res.json();
  });
  after(async () => {
    await server?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('schema carries the DB version beside the target version', () => {
    assert.equal(typeof body.schema.version, 'number');
    assert.equal(typeof body.schema.target, 'number');
    assert.equal(body.schema.version, body.schema.target);
  });

  test('contracts match the trajectory doctor on the same DB, id for id', () => {
    const report = checkTrajectoryDbFile(dbPath);
    const failed = new Set(report.violations.map((v) => v.id));
    const skipped = new Set(report.skipped.map((s) => s.id));
    assert.ok(body.contracts.length > 0);
    for (const c of body.contracts) {
      assert.equal(c.ok, failed.has(c.id) ? false : skipped.has(c.id) ? null : true, c.id);
      assert.ok(c.severity === 'error' || c.severity === 'warn', c.id);
    }
    assert.deepEqual(new Set(body.contracts.filter((c) => c.ok === false).map((c) => c.id)), failed);
    assert.equal(body.healthy, report.healthy);
  });

  test('a closed issue with a running task fails its error contract', () => {
    const c = body.contracts.find((x) => x.id === 'issues_closed_no_live_tasks');
    assert.deepEqual([c.ok, c.severity, c.actual], [false, 'error', 1]);
    assert.equal(body.healthy, false);
    assert.equal(body.contracts.find((x) => x.id === 'concepts_trusted').ok, false);
  });

  test('freshness lists each world-model repo, stale on a moved target', () => {
    assert.equal(body.freshness.length, 1);
    const [{ repo, freshness }] = body.freshness;
    assert.equal(repo, 'plugin');
    assert.notEqual(freshness, null);
    assert.deepEqual([freshness.indexed_commit, freshness.target_commit, freshness.stale], [SHA, OTHER, true]);
  });

  test('concepts count each status and each step trust', () => {
    assert.deepEqual(body.concepts.by_status, { suspect: 1, verified: 1 });
    assert.deepEqual(body.concepts.steps_by_trust, { verified: 1 });
  });

  test('embeddings count rows and embedded rows per source', () => {
    const by = Object.fromEntries(body.embeddings.map((e) => [e.source, e]));
    assert.deepEqual(Object.keys(by).sort(), ['audit', 'discussions', 'wm_directories', 'wm_files']);
    assert.deepEqual(by.wm_files, { source: 'wm_files', rows: 2, embedded: 1 });
    assert.deepEqual(by.wm_directories, { source: 'wm_directories', rows: 1, embedded: 1 });
  });

  test('the DB is unchanged after the checks', () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit').get().n, 0);
    } finally {
      db.close();
    }
  });
});

describe('Health section', () => {
  let ui;
  before(async () => {
    const out = await build({
      stdin: {
        contents: `import { renderToStaticMarkup } from 'react-dom/server';
          import { createElement } from 'react';
          import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
          import { HealthSection } from './web/views/overview/Health.tsx';
          export function withData(seed) {
            const client = new QueryClient();
            for (const [key, data] of Object.entries(seed)) client.setQueryData([key], data);
            return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(HealthSection)));
          }`,
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

  const contract = (id, severity, ok, over = {}) => ({ id, severity, description: `${id} holds`, ok, skipped: null, actual: ok === false ? 3 : null, expected: { op: '=', value: 0 }, ...over });
  const HEALTH = {
    checked_at: NOW,
    healthy: false,
    schema: { version: 64, target: 64 },
    contracts: [
      contract('fk_check_empty', 'error', true),
      contract('issues_closed_no_live_tasks', 'error', false),
      contract('concepts_trusted', 'warn', false),
      contract('scan_fresh', 'warn', null, { skipped: 'schema v1 < v2' }),
    ],
    freshness: [
      {
        repo: 'plugin',
        freshness: {
          indexed_commit: SHA,
          target_ref: 'origin/dev',
          target_commit: OTHER,
          stale: true,
          reindex: { state: 'idle', mode: null, trigger: null, started_at: null, finished_at: null, elapsed_ms: null, outcome: null },
          needs_review_count: 0,
        },
      },
    ],
    concepts: { by_status: { verified: 2, suspect: 1 }, steps_by_trust: { verified: 4 } },
    embeddings: [{ source: 'wm_files', rows: 10, embedded: 7 }],
  };

  test('renders the Health heading and failing contracts with a text label', () => {
    const html = ui.withData({ health: HEALTH });
    assert.match(html, /<h2 id="health-heading"[^>]*>Health<\/h2>/);
    const row = html.match(/<li data-contract="issues_closed_no_live_tasks"[^>]*>(.*?)<\/li>/)[1];
    assert.match(row, /octicon-stop/);
    assert.match(row, />Critical</);
    assert.match(row, /got 3, expected = 0/);
    const warn = html.match(/<li data-contract="concepts_trusted"[^>]*>(.*?)<\/li>/)[1];
    assert.match(warn, />Warning</);
    assert.doesNotMatch(html, /data-contract="fk_check_empty"/);
    assert.match(html, /1 of 4 passing/);
    assert.match(html.match(/<li data-contract="scan_fresh"[^>]*>(.*?)<\/li>/)[1], />Skipped</);
  });

  test('a stale repo carries a Stale badge, a current one a Current label', () => {
    const stale = ui.withData({ health: HEALTH }).match(/<li data-repo="plugin"[^>]*>(.*?)<\/li>/)[1];
    assert.match(stale, />Stale</);
    const fresh = structuredClone(HEALTH);
    fresh.freshness[0].freshness = { ...fresh.freshness[0].freshness, target_commit: SHA, stale: false };
    assert.match(ui.withData({ health: fresh }).match(/<li data-repo="plugin"[^>]*>(.*?)<\/li>/)[1], />Current</);
  });

  test('concept counts and embeddings render', () => {
    const html = ui.withData({ health: HEALTH });
    assert.match(html, /7 of 10 rows embedded/);
    assert.match(html, /Concept Trust/);
  });
});
