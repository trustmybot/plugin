import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { TrajectoryDB } from '../db.js';

const V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_issue_id INTEGER REFERENCES issues(id),
  objective TEXT NOT NULL,
  goals_md TEXT NOT NULL DEFAULT '',
  goals_md_hash TEXT NOT NULL DEFAULT '',
  pre_commit_hash TEXT NOT NULL DEFAULT '',
  post_commit_hash TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  current_task_id INTEGER REFERENCES tasks(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  branch_id TEXT NOT NULL,
  parent_branch_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  tools_required TEXT NOT NULL DEFAULT '[]',
  skills_required TEXT NOT NULL DEFAULT '[]',
  success_criteria TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  execution_plan_md TEXT NOT NULL DEFAULT '',
  qa_results TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_issue_branch ON tasks(issue_id, branch_id);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  branch_id TEXT,
  from_node TEXT NOT NULL,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '{}',
  is_truncated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  branch_id TEXT,
  from_node TEXT NOT NULL DEFAULT 'executor',
  round INTEGER NOT NULL DEFAULT 0,
  tool_name TEXT NOT NULL,
  tool_args TEXT NOT NULL DEFAULT '{}',
  output TEXT NOT NULL DEFAULT '',
  output_chars INTEGER NOT NULL DEFAULT 0,
  is_truncated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS validation_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  attempt_n INTEGER NOT NULL,
  agent TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL,
  feedback_md TEXT NOT NULL DEFAULT '',
  reviewer_verdict TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, attempt_n)
);
CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  file_path TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL DEFAULT 'system',
  trust_tier TEXT NOT NULL DEFAULT 'curated',
  status TEXT NOT NULL DEFAULT 'active',
  when_to_use TEXT NOT NULL DEFAULT '',
  when_not_to_use TEXT NOT NULL DEFAULT '',
  uses INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  effectiveness REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS roundtables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  topic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  outcome TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS roundtable_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  roundtable_id INTEGER NOT NULL REFERENCES roundtables(id),
  agent TEXT NOT NULL,
  vote TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_version INTEGER NOT NULL,
  plugin_version TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO plugin_meta (schema_version, plugin_version) VALUES (2, '0.2.0');
`;

function makeV2DB(path: string): void {
  const raw = new Database(path);
  raw.exec(V2_SCHEMA);
  raw.close();
}

function makeSyntheticDB(path: string, version: number): void {
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE plugin_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schema_version INTEGER NOT NULL,
      plugin_version TEXT NOT NULL
    );
    INSERT INTO plugin_meta (schema_version, plugin_version) VALUES (${version}, '0.x.0');
  `);
  raw.close();
}

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-migration-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  tmpDirs = [];
});

describe('migration runner', () => {
  it('a. fresh DB at non-existent path: no backup, schema_version=5, no error', () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, 'fresh.db');

    assert.ok(!existsSync(dbPath), 'file must not exist before open');

    const db = new TrajectoryDB(dbPath);
    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    db.close();

    assert.ok(meta !== undefined);
    assert.equal(meta.schema_version, TrajectoryDB.TARGET_VERSION);

    const backups = readdirSync(dir).filter((f) => f.includes('.bak.'));
    assert.equal(backups.length, 0, 'no backup should be created for fresh DB');
  });

  it('b. existing v2 DB: backup created, fresh schema_version=5 at original path, backup has v2 data', () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, 'v2.db');
    makeV2DB(dbPath);

    assert.ok(existsSync(dbPath));

    const db = new TrajectoryDB(dbPath);
    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    db.close();

    assert.ok(meta !== undefined);
    assert.equal(meta.schema_version, TrajectoryDB.TARGET_VERSION);

    const allFiles = readdirSync(dir);
    const backupFiles = allFiles.filter((f) => f.match(/v2\.db\.v2\.bak\.\d+$/));
    assert.equal(backupFiles.length, 1, 'exactly one backup file expected');

    const backupPath = join(dir, backupFiles[0]);
    const backupDb = new Database(backupPath, { readonly: true });
    const backupMeta = backupDb
      .prepare('SELECT schema_version FROM plugin_meta LIMIT 1')
      .get() as { schema_version: number } | undefined;
    backupDb.close();

    assert.ok(backupMeta !== undefined);
    assert.equal(backupMeta.schema_version, 2, 'backup should contain original v2 data');
  });

  it('c. existing v5 DB: no backup on re-open', () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, 'current.db');

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const beforeFiles = readdirSync(dir);

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const afterFiles = readdirSync(dir);
    const backups = afterFiles.filter((f) => f.includes('.bak.'));
    assert.equal(backups.length, 0, 'no backup on re-open of already-initialized DB');
    assert.equal(beforeFiles.length, afterFiles.length, 'no new files created on re-open');
  });

  it('d. DB with schema_version > 5 (v=99): constructor throws with clear error', () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, 'future.db');
    makeSyntheticDB(dbPath, 99);

    assert.throws(
      () => new TrajectoryDB(dbPath),
      (err: Error) => {
        assert.ok(
          err.message.includes('schema_version=99'),
          `message should mention schema_version=99: ${err.message}`,
        );
        assert.ok(
          err.message.includes('supports up to 5'),
          `message should mention 'supports up to 5': ${err.message}`,
        );
        return true;
      },
    );
  });

  it('e. in-memory DB: no fs side effects, schema_version=5', () => {
    const db = new TrajectoryDB(':memory:');
    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    db.close();

    assert.ok(meta !== undefined);
    assert.equal(meta.schema_version, TrajectoryDB.TARGET_VERSION);
  });

  it('g. v3-to-v5 in-place migration: task_spec_path and spec_body_md columns added, discussions table created, no backup', () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, 'v3.db');

    const raw = new Database(dbPath);
    raw.pragma('journal_mode = WAL');
    raw.pragma('foreign_keys = ON');
    raw.prepare(
      `CREATE TABLE plugin_meta (id INTEGER PRIMARY KEY AUTOINCREMENT, schema_version INTEGER NOT NULL, plugin_version TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    ).run();
    raw.prepare(
      `CREATE TABLE issues (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_issue_id INTEGER REFERENCES issues(id), objective TEXT NOT NULL, goals_md TEXT NOT NULL DEFAULT '', goals_md_hash TEXT NOT NULL DEFAULT '', pre_commit_hash TEXT NOT NULL DEFAULT '', post_commit_hash TEXT, status TEXT NOT NULL DEFAULT 'open', current_task_id INTEGER REFERENCES tasks(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT)`,
    ).run();
    raw.prepare(
      `CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL REFERENCES issues(id), branch_id TEXT NOT NULL, parent_branch_id TEXT, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL, tools_required TEXT NOT NULL DEFAULT '[]', skills_required TEXT NOT NULL DEFAULT '[]', success_criteria TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, execution_plan_md TEXT NOT NULL DEFAULT '', qa_results TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT)`,
    ).run();
    raw.prepare(
      `INSERT INTO plugin_meta (schema_version, plugin_version) VALUES (3, '0.3.0-alpha')`,
    ).run();
    raw.close();

    const db = new TrajectoryDB(dbPath);
    const meta = db.get<{ schema_version: number }>('SELECT schema_version FROM plugin_meta LIMIT 1');
    assert.ok(meta !== undefined);
    assert.equal(meta.schema_version, 5, 'should be upgraded to v5 in-place');

    const taskCols = db.all<{ name: string }>('PRAGMA table_info(tasks)');
    assert.ok(taskCols.some((c) => c.name === 'task_spec_path'), 'task_spec_path must exist after migration');
    assert.ok(taskCols.some((c) => c.name === 'spec_body_md'), 'spec_body_md must exist after migration');

    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='discussions'");
    assert.equal(tables.length, 1, 'discussions table must exist');
    db.close();

    const backups = readdirSync(dir).filter((f) => f.includes('.bak.'));
    assert.equal(backups.length, 0, 'v3 → v5 in-place migration must not create backup');
  });

  it('h. v4-to-v5 in-place migration: spec_body_md column added, no backup', () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, 'v4.db');

    const raw = new Database(dbPath);
    raw.pragma('journal_mode = WAL');
    raw.pragma('foreign_keys = ON');
    raw.prepare(
      `CREATE TABLE plugin_meta (id INTEGER PRIMARY KEY AUTOINCREMENT, schema_version INTEGER NOT NULL, plugin_version TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    ).run();
    raw.prepare(
      `CREATE TABLE issues (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_issue_id INTEGER REFERENCES issues(id), objective TEXT NOT NULL, goals_md TEXT NOT NULL DEFAULT '', goals_md_hash TEXT NOT NULL DEFAULT '', pre_commit_hash TEXT NOT NULL DEFAULT '', post_commit_hash TEXT, status TEXT NOT NULL DEFAULT 'open', current_task_id INTEGER REFERENCES tasks(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT)`,
    ).run();
    raw.prepare(
      `CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL REFERENCES issues(id), branch_id TEXT NOT NULL, parent_branch_id TEXT, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL, tools_required TEXT NOT NULL DEFAULT '[]', skills_required TEXT NOT NULL DEFAULT '[]', success_criteria TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, execution_plan_md TEXT NOT NULL DEFAULT '', qa_results TEXT NOT NULL DEFAULT '', task_spec_path TEXT NOT NULL DEFAULT '', commit_sha TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT)`,
    ).run();
    raw.prepare(
      `CREATE TABLE discussions (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL REFERENCES issues(id), author TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'note', body_md TEXT NOT NULL, created_at TEXT NOT NULL)`,
    ).run();
    raw.prepare(
      `INSERT INTO plugin_meta (schema_version, plugin_version) VALUES (4, '0.3.0-alpha')`,
    ).run();
    raw.prepare(
      `INSERT INTO issues (id, objective, created_at, updated_at) VALUES (1, 'test issue', datetime('now'), datetime('now'))`,
    ).run();
    raw.prepare(
      `INSERT INTO tasks (id, issue_id, branch_id, description, success_criteria, created_at, updated_at) VALUES (1, 1, 'feat/test', 'desc', 'criteria', datetime('now'), datetime('now'))`,
    ).run();
    raw.close();

    const db = new TrajectoryDB(dbPath);
    const meta = db.get<{ schema_version: number }>('SELECT schema_version FROM plugin_meta LIMIT 1');
    assert.ok(meta !== undefined);
    assert.equal(meta.schema_version, 5, 'should be upgraded to v5 in-place');

    const taskCols = db.all<{ name: string }>('PRAGMA table_info(tasks)');
    assert.ok(taskCols.some((c) => c.name === 'spec_body_md'), 'spec_body_md must exist after v4→v5 migration');

    const tasks = db.all<{ id: number; task_spec_path: string; spec_body_md: string }>('SELECT id, task_spec_path, spec_body_md FROM tasks');
    assert.equal(tasks.length, 1, 'existing rows must be preserved');
    assert.equal(tasks[0].spec_body_md, '', 'existing rows get default empty string for spec_body_md');
    db.close();

    const backups = readdirSync(dir).filter((f) => f.includes('.bak.'));
    assert.equal(backups.length, 0, 'v4 → v5 in-place migration must not create backup');
  });

  it('i. v3-to-v5 migration is idempotent: second open does not throw', () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, 'v3-idem.db');

    const raw = new Database(dbPath);
    raw.pragma('journal_mode = WAL');
    raw.pragma('foreign_keys = ON');
    raw.prepare(
      `CREATE TABLE plugin_meta (id INTEGER PRIMARY KEY AUTOINCREMENT, schema_version INTEGER NOT NULL, plugin_version TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    ).run();
    raw.prepare(
      `CREATE TABLE issues (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_issue_id INTEGER REFERENCES issues(id), objective TEXT NOT NULL, goals_md TEXT NOT NULL DEFAULT '', goals_md_hash TEXT NOT NULL DEFAULT '', pre_commit_hash TEXT NOT NULL DEFAULT '', post_commit_hash TEXT, status TEXT NOT NULL DEFAULT 'open', current_task_id INTEGER REFERENCES tasks(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT)`,
    ).run();
    raw.prepare(
      `CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL REFERENCES issues(id), branch_id TEXT NOT NULL, parent_branch_id TEXT, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL, tools_required TEXT NOT NULL DEFAULT '[]', skills_required TEXT NOT NULL DEFAULT '[]', success_criteria TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, execution_plan_md TEXT NOT NULL DEFAULT '', qa_results TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT)`,
    ).run();
    raw.prepare(
      `INSERT INTO plugin_meta (schema_version, plugin_version) VALUES (3, '0.3.0-alpha')`,
    ).run();
    raw.close();

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    assert.doesNotThrow(
      () => {
        const db2 = new TrajectoryDB(dbPath);
        db2.close();
      },
      'second open of migrated v4 DB must not throw',
    );
  });

  it('f. WAL + SHM sidecars: renamed alongside backup when v2 DB is backed up', () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, 'wal.db');
    makeV2DB(dbPath);

    writeFileSync(`${dbPath}-wal`, 'fake-wal-content');
    writeFileSync(`${dbPath}-shm`, 'fake-shm-content');

    assert.ok(existsSync(`${dbPath}-wal`));
    assert.ok(existsSync(`${dbPath}-shm`));

    const db = new TrajectoryDB(dbPath);
    db.close();

    const allFiles = readdirSync(dir);
    const backupBase = allFiles.find(
      (f) => f.match(/wal\.db\.v2\.bak\.\d+$/) && !f.includes('-wal') && !f.includes('-shm'),
    );
    assert.ok(backupBase !== undefined, 'main backup file should exist');

    assert.ok(
      !existsSync(`${dbPath}-wal`),
      'original -wal sidecar should no longer exist at original path',
    );
    assert.ok(
      !existsSync(`${dbPath}-shm`),
      'original -shm sidecar should no longer exist at original path',
    );

    const walBackup = allFiles.find((f) => f.match(/wal\.db\.v2\.bak\.\d+-wal$/));
    const shmBackup = allFiles.find((f) => f.match(/wal\.db\.v2\.bak\.\d+-shm$/));
    assert.ok(walBackup !== undefined, '-wal backup should exist alongside main backup');
    assert.ok(shmBackup !== undefined, '-shm backup should exist alongside main backup');
  });
});
