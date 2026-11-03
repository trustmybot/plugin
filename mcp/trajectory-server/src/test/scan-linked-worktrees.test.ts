// scan_run discovery skips linked git worktrees (GH 2283). A temp session
// holds a main repo r, its linked worktree r-wt (`git worktree add`) and a
// plain nested repo. Only r and the nested repo get repos rows, r-wt gets one
// scan_skipped audit row with reason linked_worktree (none on a re-scan), and a
// previously indexed r-wt row and its world-model rows are retired unless a
// task references it.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrajectoryDB } from '../db.js';
import { scanTools } from '../tools/scan.js';
import { pinScanEnv, type ScanEnvPin } from './helpers.js';

function mkRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'f.ts'), 'export function f(): number {\n  return 1;\n}\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
}

function tempDB(): TrajectoryDB {
  return new TrajectoryDB(join(mkdtempSync(join(tmpdir(), 'tmb-scan-linked-wt-db-')), 'trajectory.db'));
}

function mkSession(): string {
  const ws = mkdtempSync(join(tmpdir(), 'tmb-scan-linked-wt-'));
  mkRepo(join(ws, 'r'));
  execFileSync('git', ['-C', join(ws, 'r'), 'worktree', 'add', '-q', '../r-wt', '-b', 'wt']);
  mkRepo(join(ws, 'nested'));
  return ws;
}

type Result = { isError?: boolean; content: Array<{ text: string }> };

const scan = async (db: TrajectoryDB, ws: string): Promise<Result> =>
  (await scanTools(db, null).handlers['scan_run']!({ agent: 'bro', session_dir: ws })) as Result;

const count = (db: TrajectoryDB, sql: string, params: unknown[] = []): number =>
  db.get<{ n: number }>(sql, params as never)!.n;

function seedIndexedWorktree(db: TrajectoryDB, ws: string): void {
  const now = new Date().toISOString();
  db.run(`INSERT INTO repos (name, path, file_count, last_scanned_at) VALUES ('r-wt', ?, 1, ?)`, [join(ws, 'r-wt'), now]);
  db.run(
    `INSERT INTO wm_files (repo, path, dir, content_md5, size_bytes, last_commit_sha, updated_at)
     VALUES ('r-wt', 'f.ts', '.', 'x', 1, '', ?)`,
    [now],
  );
  db.run(
    `INSERT INTO wm_symbols (repo, path, kind, qualified_name, body_hash) VALUES ('r-wt', 'f.ts', 'function', 'f', 'h')`,
  );
}

describe('scan_run discovery skips linked git worktrees (GH 2283)', () => {
  let pin: ScanEnvPin;
  let ws = '';
  let db: TrajectoryDB;

  before(() => {
    pin = pinScanEnv();
    ws = mkSession();
    db = tempDB();
  });

  after(() => {
    db.close();
    pin.restore();
    rmSync(ws, { recursive: true, force: true });
  });

  const skipped = (): string[] =>
    db.all<{ line: string }>(
      `SELECT json_extract(content_json, '$.reason') || ' ' || json_extract(content_json, '$.path') AS line
         FROM audit WHERE event_type = 'scan_skipped' AND from_node = 'hook:scan' AND issue_id = -1
        ORDER BY 1`,
    ).map((r) => r.line);

  it('indexes the main repo and a plain nested repo, not the worktree', async () => {
    const r = await scan(db, ws);
    assert.ok(!r.isError, r.content[0]?.text);
    const names = db.all<{ name: string }>('SELECT name FROM repos ORDER BY name').map((row) => row.name);
    assert.deepEqual(names, ['nested', 'r']);
  });

  it('writes one scan_skipped row with reason linked_worktree for the worktree', () => {
    assert.deepEqual(skipped(), [`linked_worktree ${ws}/r-wt`]);
  });

  it('a re-scan writes no second scan_skipped row', async () => {
    const r = await scan(db, ws);
    assert.ok(!r.isError, r.content[0]?.text);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM audit WHERE event_type = 'scan_skipped'"), 1);
  });
});

describe('scan_run retires a previously indexed linked worktree (GH 2283)', () => {
  let pin: ScanEnvPin;
  let ws = '';

  before(() => {
    pin = pinScanEnv();
    ws = mkSession();
  });

  after(() => {
    pin.restore();
    rmSync(ws, { recursive: true, force: true });
  });

  it('drops its repos, wm_files and wm_symbols rows when no task references it', async () => {
    const db = tempDB();
    try {
      seedIndexedWorktree(db, ws);
      const r = await scan(db, ws);
      assert.ok(!r.isError, r.content[0]?.text);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM repos WHERE name = 'r-wt'"), 0);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM wm_files WHERE repo = 'r-wt'"), 0);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM wm_symbols WHERE repo = 'r-wt'"), 0);
    } finally {
      db.close();
    }
  });

  it('keeps its repos row in repos_stale_kept when a task references it', async () => {
    const db = tempDB();
    try {
      seedIndexedWorktree(db, ws);
      const now = new Date().toISOString();
      db.run(`INSERT INTO issues (objective, status, created_at, updated_at) VALUES ('wt', 'open', ?, ?)`, [now, now]);
      const issueId = db.get<{ id: number }>('SELECT MAX(id) AS id FROM issues')!.id;
      db.run(
        `INSERT INTO tasks (issue_id, branch_id, description, status, repo, created_at, updated_at)
         VALUES (?, 'wt', 'd', 'running', 'r-wt', ?, ?)`,
        [issueId, now, now],
      );
      const r = await scan(db, ws);
      assert.ok(!r.isError, r.content[0]?.text);
      const d = JSON.parse(r.content[0]!.text) as { repos_stale_kept: unknown };
      assert.deepEqual(d.repos_stale_kept, [{ name: 'r-wt', path: join(ws, 'r-wt'), reason: 'task_referenced' }]);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM repos WHERE name = 'r-wt'"), 1);
    } finally {
      db.close();
    }
  });
});
