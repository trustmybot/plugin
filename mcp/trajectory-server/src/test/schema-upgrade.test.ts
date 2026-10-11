import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { TrajectoryDB } from '../db.js';
import { SCHEMA_V28_SQL } from './fixtures/schema-v28.js';
import { SCHEMA_V29_SQL } from './fixtures/schema-v29.js';
import { assertV29Shape, indexNames } from './fixtures/v29-shape.js';
import { assertTimestampsIso } from './fixtures/v30-shape.js';
import { assertV32Shape } from './fixtures/v32-shape.js';
import { SCHEMA_V30_SQL } from './fixtures/schema-v30.js';
import { SCHEMA_V31_SQL } from './fixtures/schema-v31.js';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-schema-upgrade-'));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seedLegacyV1Db(dbPath: string, kind: 'pre-2886' | 'rc-current'): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  if (kind === 'pre-2886') {
    db.exec(`
      CREATE TABLE identity (
          id INTEGER PRIMARY KEY,
          name TEXT
      );
      CREATE TABLE regen_state (
          id INTEGER PRIMARY KEY,
          state_json TEXT
      );
      CREATE TABLE issues (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          objective   TEXT    NOT NULL,
          description TEXT    NOT NULL DEFAULT '',
          status      TEXT    NOT NULL DEFAULT 'open',
          created_at  TEXT    NOT NULL,
          updated_at  TEXT    NOT NULL,
          closed_at   TEXT,
          remote_iid  INTEGER,
          remote_kind TEXT
      );
      CREATE TABLE tasks (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id          INTEGER NOT NULL REFERENCES issues(id),
          branch_id         TEXT    NOT NULL,
          parent_branch_id  TEXT,
          title             TEXT    NOT NULL DEFAULT '',
          description       TEXT    NOT NULL,
          status            TEXT    NOT NULL DEFAULT 'pending',
          attempts          INTEGER NOT NULL DEFAULT 0,
          spec_body         TEXT    NOT NULL DEFAULT '',
          success_criteria  TEXT    NOT NULL DEFAULT '',
          commit_sha        TEXT,
          repo              TEXT,
          created_at        TEXT    NOT NULL,
          updated_at        TEXT    NOT NULL,
          completed_at      TEXT
      );
      CREATE UNIQUE INDEX idx_tasks_issue_branch ON tasks(issue_id, branch_id);
      CREATE TABLE audit (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id     INTEGER NOT NULL REFERENCES issues(id),
          branch_id    TEXT,
          from_node    TEXT    NOT NULL DEFAULT 'executor',
          event_type   TEXT    NOT NULL,
          summary      TEXT    NOT NULL,
          content_json TEXT    NOT NULL DEFAULT '{}',
          created_at   TEXT    NOT NULL
      );
      CREATE TABLE validation_attempts (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id             INTEGER NOT NULL REFERENCES tasks(id),
          attempt_n           INTEGER NOT NULL,
          agent               TEXT    NOT NULL DEFAULT '',
          verdict             TEXT    NOT NULL,
          feedback            TEXT    NOT NULL DEFAULT '',
          subagent_session_id TEXT,
          created_at          TEXT    NOT NULL,
          UNIQUE(task_id, attempt_n)
      );
      CREATE TABLE skills (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          name          TEXT    NOT NULL UNIQUE,
          description   TEXT    NOT NULL,
          file_path     TEXT    NOT NULL,
          trust_tier    TEXT    NOT NULL DEFAULT 'curated',
          status        TEXT    NOT NULL DEFAULT 'active',
          uses          INTEGER NOT NULL DEFAULT 0,
          successes     INTEGER NOT NULL DEFAULT 0,
          effectiveness REAL,
          created_at    TEXT    NOT NULL,
          updated_at    TEXT    NOT NULL
      );
      CREATE TABLE agents (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT    NOT NULL UNIQUE,
          kind       TEXT    NOT NULL,
          scope      TEXT    NOT NULL,
          file_path  TEXT    NOT NULL,
          status     TEXT    NOT NULL DEFAULT 'active',
          created_at TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE roundtables (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id   INTEGER NOT NULL REFERENCES issues(id),
          topic      TEXT    NOT NULL,
          outcome    TEXT    NOT NULL DEFAULT '',
          agent      TEXT,
          status     TEXT    NOT NULL DEFAULT 'open',
          created_at TEXT    NOT NULL,
          closed_at  TEXT
      );
      CREATE TABLE roundtable_votes (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          roundtable_id INTEGER NOT NULL REFERENCES roundtables(id),
          agent         TEXT    NOT NULL,
          vote          TEXT    NOT NULL,
          rationale     TEXT    NOT NULL DEFAULT '',
          created_at    TEXT    NOT NULL
      );
      CREATE TABLE discussions (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id   INTEGER NOT NULL REFERENCES issues(id),
          author     TEXT    NOT NULL,
          kind       TEXT    NOT NULL DEFAULT 'note',
          body       TEXT    NOT NULL,
          created_at TEXT    NOT NULL
      );
      CREATE TABLE plugin_meta (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          schema_version INTEGER NOT NULL,
          plugin_version TEXT    NOT NULL
      );
      CREATE TABLE plugin_config (
          key        TEXT PRIMARY KEY,
          value_json TEXT NOT NULL
      );
      CREATE TABLE agent_runs (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id      INTEGER REFERENCES tasks(id),
          issue_id     INTEGER REFERENCES issues(id),
          agent_type   TEXT    NOT NULL,
          tokens_in    INTEGER NOT NULL DEFAULT 0,
          tokens_out   INTEGER NOT NULL DEFAULT 0,
          tokens_total INTEGER NOT NULL DEFAULT 0,
          tool_uses    INTEGER NOT NULL DEFAULT 0,
          duration_ms  INTEGER NOT NULL DEFAULT 0,
          completed_at TEXT    NOT NULL DEFAULT ''
      );
      CREATE TABLE repos (
          name            TEXT PRIMARY KEY,
          path            TEXT NOT NULL,
          file_count      INTEGER NOT NULL DEFAULT 0,
          last_scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE pr_review_runs (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          pr_number       INTEGER NOT NULL,
          repo            TEXT    NOT NULL,
          last_fetched_at DATETIME NOT NULL,
          last_comment_id TEXT
      );
      CREATE TABLE file_registry (
          repo               TEXT NOT NULL DEFAULT '',
          path               TEXT NOT NULL,
          type               TEXT NOT NULL DEFAULT 'unknown',
          size_bytes         INTEGER,
          content_md5        TEXT,
          last_commit_sha    TEXT,
          language           TEXT,
          summary            TEXT,
          summary_updated_at TEXT,
          PRIMARY KEY (repo, path)
      );
      INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 1, '0.5.0');
    `);
  } else {
    db.exec(`
      CREATE TABLE issues (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          objective   TEXT    NOT NULL,
          description TEXT    NOT NULL DEFAULT '',
          status      TEXT    NOT NULL DEFAULT 'open',
          created_at  TEXT    NOT NULL,
          updated_at  TEXT    NOT NULL,
          closed_at   TEXT,
          remote_iid  INTEGER,
          remote_kind TEXT
      );
      CREATE TABLE tasks (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id          INTEGER NOT NULL REFERENCES issues(id),
          branch_id         TEXT    NOT NULL,
          parent_branch_id  TEXT,
          title             TEXT    NOT NULL DEFAULT '',
          description       TEXT    NOT NULL,
          status            TEXT    NOT NULL DEFAULT 'pending',
          attempts          INTEGER NOT NULL DEFAULT 0,
          spec_body         TEXT    NOT NULL DEFAULT '',
          commit_sha        TEXT,
          repo              TEXT,
          created_at        TEXT    NOT NULL,
          updated_at        TEXT    NOT NULL,
          completed_at      TEXT
      );
      CREATE UNIQUE INDEX idx_tasks_issue_branch ON tasks(issue_id, branch_id);
      CREATE TABLE audit (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id     INTEGER NOT NULL REFERENCES issues(id),
          branch_id    TEXT,
          from_node    TEXT    NOT NULL DEFAULT 'executor',
          event_type   TEXT    NOT NULL,
          summary      TEXT    NOT NULL,
          content_json TEXT    NOT NULL DEFAULT '{}',
          created_at   TEXT    NOT NULL
      );
      CREATE TABLE validation_attempts (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id             INTEGER NOT NULL REFERENCES tasks(id),
          attempt_n           INTEGER NOT NULL,
          agent               TEXT    NOT NULL DEFAULT '',
          verdict             TEXT    NOT NULL,
          feedback            TEXT    NOT NULL DEFAULT '',
          subagent_session_id TEXT,
          created_at          TEXT    NOT NULL,
          UNIQUE(task_id, attempt_n)
      );
      CREATE TABLE skills (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          name          TEXT    NOT NULL UNIQUE,
          description   TEXT    NOT NULL,
          file_path     TEXT    NOT NULL,
          scope         TEXT    NOT NULL DEFAULT 'global',
          trust_tier    TEXT    NOT NULL DEFAULT 'curated',
          status        TEXT    NOT NULL DEFAULT 'active',
          uses          INTEGER NOT NULL DEFAULT 0,
          successes     INTEGER NOT NULL DEFAULT 0,
          effectiveness REAL,
          created_at    TEXT    NOT NULL,
          updated_at    TEXT    NOT NULL
      );
      CREATE TABLE agents (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT    NOT NULL UNIQUE,
          kind       TEXT    NOT NULL,
          scope      TEXT    NOT NULL,
          file_path  TEXT    NOT NULL,
          status     TEXT    NOT NULL DEFAULT 'active',
          created_at TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE roundtables (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id              INTEGER NOT NULL REFERENCES issues(id),
          topic                 TEXT    NOT NULL,
          outcome               TEXT    NOT NULL DEFAULT '',
          created_at            TEXT    NOT NULL,
          closed_at             TEXT,
          state                 TEXT    NOT NULL DEFAULT 'collecting',
          expected_participants INTEGER
      );
      CREATE TABLE roundtable_votes (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          roundtable_id INTEGER NOT NULL REFERENCES roundtables(id),
          participant   TEXT    NOT NULL,
          vote          TEXT    NOT NULL,
          rationale     TEXT    NOT NULL DEFAULT '',
          created_at    TEXT    NOT NULL
      );
      CREATE TABLE discussions (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id   INTEGER NOT NULL REFERENCES issues(id),
          author     TEXT    NOT NULL,
          kind       TEXT    NOT NULL DEFAULT 'note',
          body       TEXT    NOT NULL,
          created_at TEXT    NOT NULL
      );
      CREATE TABLE plugin_meta (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          schema_version INTEGER NOT NULL,
          plugin_version TEXT    NOT NULL
      );
      CREATE TABLE plugin_config (
          key        TEXT PRIMARY KEY,
          value_json TEXT NOT NULL
      );
      CREATE TABLE agent_runs (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id      INTEGER REFERENCES tasks(id),
          issue_id     INTEGER REFERENCES issues(id),
          agent_type   TEXT    NOT NULL,
          tokens_in    INTEGER NOT NULL DEFAULT 0,
          tokens_out   INTEGER NOT NULL DEFAULT 0,
          tokens_total INTEGER NOT NULL DEFAULT 0,
          tool_uses    INTEGER NOT NULL DEFAULT 0,
          duration_ms  INTEGER NOT NULL DEFAULT 0,
          started_at   TEXT,
          completed_at TEXT
      );
      CREATE TABLE repos (
          name            TEXT PRIMARY KEY,
          path            TEXT NOT NULL,
          file_count      INTEGER NOT NULL DEFAULT 0,
          last_scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE pr_review_runs (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          pr_number       INTEGER NOT NULL,
          repo            TEXT    NOT NULL,
          last_fetched_at DATETIME NOT NULL,
          last_comment_id TEXT
      );
      CREATE TABLE file_registry (
          repo               TEXT NOT NULL DEFAULT '',
          path               TEXT NOT NULL,
          type               TEXT NOT NULL DEFAULT 'unknown',
          content_md5        TEXT,
          summary            TEXT,
          summary_updated_at TEXT,
          PRIMARY KEY (repo, path)
      );
      INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 1, '0.6.0-rc.1');
    `);
  }

  db.close();
}

function seedV2Db(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE issues (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        objective   TEXT    NOT NULL,
        description TEXT    NOT NULL DEFAULT '',
        status      TEXT    NOT NULL DEFAULT 'open',
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL,
        closed_at   TEXT,
        remote_iid  INTEGER,
        remote_kind TEXT
    );
    CREATE TABLE tasks (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id          INTEGER NOT NULL REFERENCES issues(id),
        branch_id         TEXT    NOT NULL,
        parent_branch_id  TEXT,
        title             TEXT    NOT NULL DEFAULT '',
        description       TEXT    NOT NULL,
        status            TEXT    NOT NULL DEFAULT 'pending',
        attempts          INTEGER NOT NULL DEFAULT 0,
        spec_body         TEXT    NOT NULL DEFAULT '',
        commit_sha        TEXT,
        repo              TEXT,
        created_at        TEXT    NOT NULL,
        updated_at        TEXT    NOT NULL,
        completed_at      TEXT
    );
    CREATE UNIQUE INDEX idx_tasks_issue_branch ON tasks(issue_id, branch_id);
    CREATE TABLE audit (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id     INTEGER NOT NULL REFERENCES issues(id),
        branch_id    TEXT,
        from_node    TEXT    NOT NULL DEFAULT 'executor',
        event_type   TEXT    NOT NULL,
        summary      TEXT    NOT NULL,
        content_json TEXT    NOT NULL DEFAULT '{}',
        created_at   TEXT    NOT NULL
    );
    CREATE TABLE validation_attempts (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id             INTEGER NOT NULL REFERENCES tasks(id),
        attempt_n           INTEGER NOT NULL,
        agent               TEXT    NOT NULL DEFAULT '',
        verdict             TEXT    NOT NULL,
        feedback            TEXT    NOT NULL DEFAULT '',
        subagent_session_id TEXT,
        created_at          TEXT    NOT NULL,
        UNIQUE(task_id, attempt_n)
    );
    CREATE TABLE skills (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT    NOT NULL UNIQUE,
        description   TEXT    NOT NULL,
        file_path     TEXT    NOT NULL,
        scope         TEXT    NOT NULL DEFAULT 'global',
        trust_tier    TEXT    NOT NULL DEFAULT 'curated',
        status        TEXT    NOT NULL DEFAULT 'active',
        uses          INTEGER NOT NULL DEFAULT 0,
        successes     INTEGER NOT NULL DEFAULT 0,
        effectiveness REAL,
        created_at    TEXT    NOT NULL,
        updated_at    TEXT    NOT NULL
    );
    CREATE TABLE agents (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL UNIQUE,
        kind       TEXT    NOT NULL,
        scope      TEXT    NOT NULL,
        file_path  TEXT    NOT NULL,
        status     TEXT    NOT NULL DEFAULT 'active',
        created_at TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE roundtables (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id              INTEGER NOT NULL REFERENCES issues(id),
        topic                 TEXT    NOT NULL,
        outcome               TEXT    NOT NULL DEFAULT '',
        created_at            TEXT    NOT NULL,
        closed_at             TEXT,
        state                 TEXT    NOT NULL DEFAULT 'collecting',
        expected_participants INTEGER
    );
    CREATE TABLE roundtable_votes (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        roundtable_id INTEGER NOT NULL REFERENCES roundtables(id),
        participant   TEXT    NOT NULL,
        vote          TEXT    NOT NULL,
        rationale     TEXT    NOT NULL DEFAULT '',
        created_at    TEXT    NOT NULL
    );
    CREATE TABLE discussions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id   INTEGER NOT NULL REFERENCES issues(id),
        author     TEXT    NOT NULL,
        kind       TEXT    NOT NULL DEFAULT 'note',
        body       TEXT    NOT NULL,
        created_at TEXT    NOT NULL
    );
    CREATE TABLE plugin_meta (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        plugin_version TEXT    NOT NULL
    );
    CREATE TABLE plugin_config (
        key        TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    );
    CREATE TABLE agent_runs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id      INTEGER REFERENCES tasks(id),
        issue_id     INTEGER REFERENCES issues(id),
        agent_type   TEXT    NOT NULL,
        tokens_in    INTEGER NOT NULL DEFAULT 0,
        tokens_out   INTEGER NOT NULL DEFAULT 0,
        tokens_total INTEGER NOT NULL DEFAULT 0,
        tool_uses    INTEGER NOT NULL DEFAULT 0,
        duration_ms  INTEGER NOT NULL DEFAULT 0,
        started_at   TEXT,
        completed_at TEXT
    );
    CREATE TABLE repos (
        name            TEXT PRIMARY KEY,
        path            TEXT NOT NULL,
        file_count      INTEGER NOT NULL DEFAULT 0,
        last_scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE pr_review_runs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_number       INTEGER NOT NULL,
        repo            TEXT    NOT NULL,
        last_fetched_at DATETIME NOT NULL,
        last_comment_id TEXT
    );
    CREATE TABLE file_registry (
        repo               TEXT NOT NULL DEFAULT '',
        path               TEXT NOT NULL,
        type               TEXT NOT NULL DEFAULT 'unknown',
        content_md5        TEXT,
        summary            TEXT,
        summary_updated_at TEXT,
        PRIMARY KEY (repo, path)
    );
    CREATE TABLE rules (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL UNIQUE,
        description TEXT    NOT NULL,
        file_path   TEXT    NOT NULL,
        scope       TEXT    NOT NULL DEFAULT 'project-local',
        severity    TEXT    NOT NULL DEFAULT 'advisory',
        status      TEXT    NOT NULL DEFAULT 'active',
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL
    );
    CREATE TABLE commands (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT    NOT NULL UNIQUE,
        description  TEXT    NOT NULL,
        file_path    TEXT    NOT NULL,
        scope        TEXT    NOT NULL DEFAULT 'global',
        args_schema  TEXT    NOT NULL DEFAULT '{}',
        status       TEXT    NOT NULL DEFAULT 'active',
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL
    );
    CREATE TABLE skill_invocations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_name    TEXT    NOT NULL REFERENCES skills(name),
        agent_name    TEXT    NOT NULL,
        agent_run_id  INTEGER REFERENCES agent_runs(id),
        task_id       INTEGER REFERENCES tasks(id),
        invoked_at    TEXT    NOT NULL,
        outcome       TEXT    NOT NULL DEFAULT 'completed'
    );
    CREATE TABLE rule_invocations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_name     TEXT    NOT NULL REFERENCES rules(name),
        agent_name    TEXT    NOT NULL,
        agent_run_id  INTEGER REFERENCES agent_runs(id),
        task_id       INTEGER REFERENCES tasks(id),
        applied_at    TEXT    NOT NULL,
        outcome       TEXT    NOT NULL DEFAULT 'applied'
    );
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (-1, 'system', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 2, '0.6.0');
  `);
  db.close();
}

describe('schema upgrade — v1 -> v2 migration framework', () => {
  it('legacy pre-#2886 DB upgrades to v2', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedLegacyV1Db(dbPath, 'pre-2886');

    const seed = new DatabaseSync(dbPath);
    seed.exec(
      `INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'legacy issue', '', 'open', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    seed.exec(
      `INSERT INTO tasks (id, issue_id, branch_id, title, description, status, attempts, spec_body, success_criteria, created_at, updated_at) VALUES (1, 1, 'feat/legacy', '', 'legacy desc', 'pending', 0, '', 'done', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    // Pre-#2876 onboarded marker — must be translated to plugin_config('onboarded': true)
    // by the migration. Without translation, post-upgrade first_run=true re-fires
    // the onboarding ceremony on a user who was already onboarded.
    seed.exec(`INSERT INTO identity (id) VALUES (1)`);
    seed.close();

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta, 'plugin_meta row required');
    assert.equal(meta.schema_version, 32);

    const identity = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='identity'",
    );
    assert.equal(identity, undefined, 'identity table must be dropped');

    const regen = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='regen_state'",
    );
    assert.equal(regen, undefined, 'regen_state table must be dropped');

    const taskCols = db
      .all<{ name: string }>('PRAGMA table_info(tasks)')
      .map((c) => c.name);
    assert.ok(
      !taskCols.includes('success_criteria'),
      'tasks.success_criteria must be removed',
    );

    // The skills table is folded into cheatcodes by the v18->v19 migration
    // (#101), so the chained upgrade must leave skills gone and the bundled
    // skills present as origin='builtin' rows in cheatcodes.
    const skillsTable = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='skills'",
    );
    assert.equal(skillsTable, undefined, 'skills table must be dropped by the v18->v19 unification');
    const cheatcodeCols = db
      .all<{ name: string }>('PRAGMA table_info(cheatcodes)')
      .map((c) => c.name);
    for (const kept of ['origin', 'file_path', 'description', 'scope']) {
      assert.ok(cheatcodeCols.includes(kept), `cheatcodes.${kept} must exist after unification`);
    }

    const fileRegCols = db
      .all<{ name: string }>('PRAGMA table_info(file_registry)')
      .map((c) => c.name);
    assert.ok(
      !fileRegCols.includes('size_bytes'),
      'file_registry.size_bytes must be removed',
    );
    assert.ok(
      !fileRegCols.includes('last_commit_sha'),
      'file_registry.last_commit_sha must be removed',
    );
    assert.ok(
      !fileRegCols.includes('language'),
      'file_registry.language must be removed',
    );

    // The rules + rule_invocations registry is dropped by the v15->v16
    // migration, the commands catalog by the v16->v17 migration (#97
    // schema audit), and skill_invocations by the v20->v21 migration (#118),
    // so the chained upgrade must leave them all gone.
    for (const t of ['rules', 'rule_invocations', 'commands', 'skill_invocations']) {
      const row = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [t],
      );
      assert.equal(row, undefined, `${t} table must be dropped by schema-audit migration`);
    }

    const survivingTask = db.get<{ id: number }>(
      'SELECT id FROM tasks WHERE id = 1',
    );
    assert.ok(survivingTask, 'seeded task row must survive migration');

    const onboardedRow = db.get<{ value_json: string }>(
      `SELECT value_json FROM plugin_config WHERE key = 'onboarded'`,
    );
    assert.ok(onboardedRow, 'onboarded marker must be translated from legacy identity row');
    assert.equal(onboardedRow.value_json, 'true');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one backup file must exist');

    db.run(
      `INSERT INTO tasks (issue_id, branch_id, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [1, 'feat/test-round-trip', 'desc', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
    );

    db.close();
  });

  it('rc-current DB upgrades cleanly (no rebuilds needed, just version bump)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedLegacyV1Db(dbPath, 'rc-current');

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta);
    assert.equal(meta.schema_version, 32);

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'backup must exist for rc-current upgrade');

    db.run(
      `INSERT INTO issues (objective, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ['post-upgrade', '', 'open', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
    );

    db.close();
  });

  it('idempotent — re-opening at v4 does NOT create a second backup', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedLegacyV1Db(dbPath, 'pre-2886');

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const firstCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(secondCount, 1, 'reopening at v4 must not create another backup');
  });

  it('backup captures uncheckpointed WAL state (pending writes survive migration)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedLegacyV1Db(dbPath, 'pre-2886');

    // Open the legacy DB in WAL mode and write a row, leaving an
    // uncheckpointed WAL. We DO NOT close — that would auto-checkpoint
    // and defeat the test. The TrajectoryDB constructor below opens its
    // own connection; its `backupDbBeforeMigration` must call
    // `PRAGMA wal_checkpoint(FULL)` so the .bak captures this write.
    const seedDb = new DatabaseSync(dbPath);
    seedDb.exec('PRAGMA journal_mode = WAL');
    seedDb.exec(
      `INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (42, 'wal-pending', '', 'open', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    // Hold the connection open so the WAL doesn't drain on close.
    // The TrajectoryDB opens a separate connection — SQLite's WAL
    // arbitration plus busy_timeout handle the overlap.

    const db = new TrajectoryDB(dbPath);

    const backupFile = readdirSync(dirname(dbPath)).find(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    );
    assert.ok(backupFile, 'backup file must exist');

    // Open the .bak as a standalone DB (no WAL companion) and verify the
    // pending-WAL row was captured by the checkpoint+copy sequence.
    const bak = new DatabaseSync(join(dirname(dbPath), backupFile));
    const row = bak
      .prepare("SELECT objective FROM issues WHERE id = 42")
      .get() as { objective: string } | undefined;
    bak.close();

    assert.ok(
      row && row.objective === 'wal-pending',
      'pending WAL write must be visible in .bak — wal_checkpoint(FULL) failed to flush before copyFile',
    );

    seedDb.close();
    db.close();
  });

  it('rejects DB with schema_version > TARGET (downgrade protection)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedLegacyV1Db(dbPath, 'rc-current');

    const raw = new DatabaseSync(dbPath);
    raw.exec('UPDATE plugin_meta SET schema_version = 99 WHERE id = 1');
    raw.close();

    assert.throws(
      () => new TrajectoryDB(dbPath),
      /newer than code's max/,
      'must reject schema_version > TARGET',
    );

    assert.ok(existsSync(dbPath), 'DB file should remain after rejected open');
  });
});

describe('schema upgrade — v2 -> v3 migration (FTS5 infrastructure)', () => {
  it('v2 DB upgrades to v3 with FTS5 tables created', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV2Db(dbPath);

    const seed = new DatabaseSync(dbPath);
    seed.exec(
      `INSERT INTO discussions (issue_id, author, kind, body, created_at)
       VALUES (-1, 'bro', 'note', 'pre-migration discussion body', '2026-01-01T00:00:00Z')`,
    );
    seed.exec(
      `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
       VALUES (-1, 'bro', 'test_event', 'pre-migration audit summary', '{}', '2026-01-01T00:00:00Z')`,
    );
    seed.close();

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta, 'plugin_meta row required');
    assert.equal(meta.schema_version, 32, 'schema_version must be 32 after migration');

    // file_registry FTS was retired in v7; discussions_fts and audit_fts remain.
    for (const ftsTable of ['discussions_fts', 'audit_fts']) {
      const row = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [ftsTable],
      );
      assert.ok(row !== undefined, `${ftsTable} virtual table must exist post-migration`);
    }

    const discFtsCount = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM discussions_fts',
    );
    assert.ok((discFtsCount?.n ?? 0) >= 1, 'discussions_fts must be backfilled with existing rows');

    const auditFtsCount = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM audit_fts',
    );
    assert.ok((auditFtsCount?.n ?? 0) >= 1, 'audit_fts must be backfilled');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one pre-v32 backup must exist');

    db.close();
  });

  it('INSERT trigger keeps discussions_fts in sync', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV2Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    db.run(
      `INSERT INTO discussions (issue_id, author, kind, body, created_at)
       VALUES (-1, 'swe', 'note', 'trigger test uniquetoken7823', '2026-05-01T00:00:00Z')`,
    );

    const ftsRow = db.get<{ body: string }>(
      "SELECT body FROM discussions_fts WHERE discussions_fts MATCH 'uniquetoken7823'",
    );
    assert.ok(ftsRow, 'INSERT trigger must add new discussion to discussions_fts');

    db.close();
  });

  it('UPDATE trigger keeps discussions_fts in sync', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV2Db(dbPath);

    const seed = new DatabaseSync(dbPath);
    seed.exec(
      `INSERT INTO discussions (issue_id, author, kind, body, created_at)
       VALUES (-1, 'bro', 'note', 'original content before update', '2026-01-01T00:00:00Z')`,
    );
    const idRow = seed.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };
    seed.close();

    const db = new TrajectoryDB(dbPath);

    db.run(`UPDATE discussions SET body = 'updated content after change' WHERE id = ?`, [
      idRow.id,
    ]);

    const oldSearch = db.get<{ body: string }>(
      "SELECT body FROM discussions_fts WHERE discussions_fts MATCH 'original'",
    );
    assert.equal(oldSearch, undefined, 'old content must be removed from FTS after UPDATE');

    const newSearch = db.get<{ body: string }>(
      "SELECT body FROM discussions_fts WHERE discussions_fts MATCH 'updated'",
    );
    assert.ok(newSearch, 'new content must be searchable after UPDATE trigger fires');

    db.close();
  });

  it('DELETE trigger removes from discussions_fts', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV2Db(dbPath);

    const seed = new DatabaseSync(dbPath);
    seed.exec(
      `INSERT INTO discussions (issue_id, author, kind, body, created_at)
       VALUES (-1, 'bro', 'note', 'content to be deleted uniquetoken9901', '2026-01-01T00:00:00Z')`,
    );
    const idRow = seed.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };
    seed.close();

    const db = new TrajectoryDB(dbPath);

    const before = db.get<{ body: string }>(
      "SELECT body FROM discussions_fts WHERE discussions_fts MATCH 'uniquetoken9901'",
    );
    assert.ok(before, 'row must be findable before delete');

    db.run(`DELETE FROM discussions WHERE id = ?`, [idRow.id]);

    const after = db.get<{ body: string }>(
      "SELECT body FROM discussions_fts WHERE discussions_fts MATCH 'uniquetoken9901'",
    );
    assert.equal(after, undefined, 'DELETE trigger must remove row from discussions_fts');

    db.close();
  });

  it('v2->v3 migration is idempotent — re-opening at v3 does not create a second backup', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV2Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const firstCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v4 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(secondCount, 1, 'reopening at v4 must not create another backup');
  });

});

function seedV3Db(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE issues (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        objective   TEXT    NOT NULL,
        description TEXT    NOT NULL DEFAULT '',
        status      TEXT    NOT NULL DEFAULT 'open',
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL,
        closed_at   TEXT,
        remote_iid  INTEGER,
        remote_kind TEXT
    );
    CREATE TABLE audit (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id     INTEGER NOT NULL REFERENCES issues(id),
        branch_id    TEXT,
        from_node    TEXT    NOT NULL DEFAULT 'executor',
        event_type   TEXT    NOT NULL,
        summary      TEXT    NOT NULL,
        content_json TEXT    NOT NULL DEFAULT '{}',
        created_at   TEXT    NOT NULL
    );
    CREATE TABLE discussions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id   INTEGER NOT NULL REFERENCES issues(id),
        author     TEXT    NOT NULL,
        kind       TEXT    NOT NULL DEFAULT 'note',
        body       TEXT    NOT NULL,
        created_at TEXT    NOT NULL
    );
    CREATE TABLE file_registry (
        repo               TEXT NOT NULL DEFAULT '',
        path               TEXT NOT NULL,
        type               TEXT NOT NULL DEFAULT 'unknown',
        content_md5        TEXT,
        summary            TEXT,
        summary_updated_at TEXT,
        PRIMARY KEY (repo, path)
    );
    CREATE VIRTUAL TABLE discussions_fts USING fts5(
      body, content='discussions', content_rowid='id', tokenize='porter unicode61'
    );
    CREATE VIRTUAL TABLE audit_fts USING fts5(
      summary, content_json, content='audit', content_rowid='id', tokenize='porter unicode61'
    );
    CREATE VIRTUAL TABLE file_registry_fts USING fts5(
      summary, path, content='file_registry', tokenize='porter unicode61'
    );
    CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL REFERENCES issues(id),
        branch_id TEXT NOT NULL,
        parent_branch_id TEXT,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        spec_body TEXT NOT NULL DEFAULT '',
        commit_sha TEXT,
        repo TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
    );
    CREATE TABLE plugin_meta (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        plugin_version TEXT    NOT NULL
    );
    CREATE TABLE plugin_config (
        key        TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    );
    CREATE TABLE skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        file_path TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'global',
        trust_tier TEXT NOT NULL DEFAULT 'curated',
        status TEXT NOT NULL DEFAULT 'active',
        uses INTEGER NOT NULL DEFAULT 0,
        successes INTEGER NOT NULL DEFAULT 0,
        effectiveness REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        file_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE roundtables (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL REFERENCES issues(id),
        topic TEXT NOT NULL,
        outcome TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        closed_at TEXT,
        state TEXT NOT NULL DEFAULT 'collecting',
        expected_participants INTEGER
    );
    CREATE TABLE roundtable_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        roundtable_id INTEGER NOT NULL REFERENCES roundtables(id),
        participant TEXT NOT NULL,
        vote TEXT NOT NULL,
        rationale TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
    );
    CREATE TABLE validation_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        attempt_n INTEGER NOT NULL,
        agent TEXT NOT NULL DEFAULT '',
        verdict TEXT NOT NULL,
        feedback TEXT NOT NULL DEFAULT '',
        subagent_session_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, attempt_n)
    );
    CREATE TABLE repos (
        name TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        file_count INTEGER NOT NULL DEFAULT 0,
        last_scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE pr_review_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_number INTEGER NOT NULL,
        repo TEXT NOT NULL,
        last_fetched_at DATETIME NOT NULL,
        last_comment_id TEXT
    );
    CREATE TABLE rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        file_path TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'project-local',
        severity TEXT NOT NULL DEFAULT 'advisory',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        file_path TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'global',
        args_schema TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE skill_invocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_name TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        agent_run_id INTEGER,
        task_id INTEGER,
        invoked_at TEXT NOT NULL,
        outcome TEXT NOT NULL DEFAULT 'completed'
    );
    CREATE TABLE rule_invocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_name TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        agent_run_id INTEGER,
        task_id INTEGER,
        applied_at TEXT NOT NULL,
        outcome TEXT NOT NULL DEFAULT 'applied'
    );
    CREATE TABLE agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        issue_id INTEGER,
        agent_type TEXT NOT NULL,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        tokens_total INTEGER NOT NULL DEFAULT 0,
        tool_uses INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        completed_at TEXT
    );
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (-1, 'system', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 3, '0.6.0');
  `);
  db.close();
}

function seedV4Db(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE issues (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        objective   TEXT    NOT NULL,
        description TEXT    NOT NULL DEFAULT '',
        status      TEXT    NOT NULL DEFAULT 'open',
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL,
        closed_at   TEXT,
        remote_iid  INTEGER,
        remote_kind TEXT CHECK(remote_kind IN ('github','gitlab'))
    );
    CREATE TABLE plugin_meta (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        plugin_version TEXT    NOT NULL
    );
    CREATE TABLE plugin_config (
        key        TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    );
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (-1, 'system', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO issues (id, objective, description, status, created_at, updated_at, remote_iid, remote_kind)
    VALUES (1, 'gh issue', '', 'open', datetime('now'), datetime('now'), 42, 'github');
    INSERT INTO issues (id, objective, description, status, created_at, updated_at, remote_iid, remote_kind)
    VALUES (2, 'gl issue', '', 'open', datetime('now'), datetime('now'), 99, 'gitlab');
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (3, 'no remote issue', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 4, '0.8.0');
  `);
  db.close();
}

describe('schema upgrade — v4 -> v5 migration (gh_iid + gl_iid columns)', () => {
  it('v4 DB upgrades to v5 with gh_iid + gl_iid columns added', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV4Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta, 'plugin_meta row required');
    assert.equal(meta.schema_version, 32, 'schema_version must be 32 after v4->v5 migration');

    const cols = db.all<{ name: string }>('PRAGMA table_info(issues)').map((c) => c.name);
    assert.ok(cols.includes('gh_iid'), 'gh_iid column must exist after migration');
    assert.ok(cols.includes('gl_iid'), 'gl_iid column must exist after migration');
    assert.ok(!cols.includes('remote_iid'), 'remote_iid is dropped by the v29 step of the chain');
    assert.ok(cols.includes('remote_kind'), 'remote_kind must still exist (back-compat)');

    db.close();
  });

  it('v4->v5 backfill: github remote_iid → gh_iid', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV4Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const ghRow = db.get<{ gh_iid: number | null; gl_iid: number | null }>(
      'SELECT gh_iid, gl_iid FROM issues WHERE id = 1',
    );
    assert.equal(ghRow?.gh_iid, 42, 'github remote_iid must be backfilled into gh_iid');
    assert.equal(ghRow?.gl_iid, null, 'gl_iid must be null for github-only row');

    db.close();
  });

  it('v4->v5 backfill: gitlab remote_iid → gl_iid', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV4Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const glRow = db.get<{ gh_iid: number | null; gl_iid: number | null }>(
      'SELECT gh_iid, gl_iid FROM issues WHERE id = 2',
    );
    assert.equal(glRow?.gl_iid, 99, 'gitlab remote_iid must be backfilled into gl_iid');
    assert.equal(glRow?.gh_iid, null, 'gh_iid must be null for gitlab-only row');

    db.close();
  });

  it('v4->v5 backfill: row with no remote_iid stays null in both iid columns', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV4Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const noRemoteRow = db.get<{ gh_iid: number | null; gl_iid: number | null }>(
      'SELECT gh_iid, gl_iid FROM issues WHERE id = 3',
    );
    assert.equal(noRemoteRow?.gh_iid, null, 'gh_iid must be null for row with no remote');
    assert.equal(noRemoteRow?.gl_iid, null, 'gl_iid must be null for row with no remote');

    db.close();
  });

  it('v4->v5 migration is idempotent — re-opening at v5 does not create a second backup', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV4Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const firstCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v5 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(secondCount, 1, 'reopening at v5 must not create another backup');
  });

  it('fresh v5 DB has gh_iid + gl_iid columns in issues', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.equal(meta?.schema_version, 32, 'fresh DB schema_version must be 32');

    const cols = db.all<{ name: string }>('PRAGMA table_info(issues)').map((c) => c.name);
    assert.ok(cols.includes('gh_iid'), 'gh_iid must exist in fresh DB');
    assert.ok(cols.includes('gl_iid'), 'gl_iid must exist in fresh DB');

    db.close();
  });
});

describe('schema upgrade — v3 -> v4 migration (embedding tables)', () => {
  it('v3 DB upgrades to v4 with embedding tables created', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV3Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta, 'plugin_meta row required');
    assert.equal(meta.schema_version, 32, 'schema_version must be 32 after migration');

    for (const t of ['discussions_embeddings', 'audit_embeddings', 'audit_embeddings']) {
      const row = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [t],
      );
      assert.ok(row !== undefined, `${t} table must exist after migration chain`);
    }

    for (const idx of [
      'idx_discussions_embeddings_model',
      'idx_audit_embeddings_model',
      'idx_audit_embeddings_model',
    ]) {
      const row = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name=?",
        [idx],
      );
      assert.ok(row !== undefined, `index ${idx} must exist after migration chain`);
    }

    const embCount = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM discussions_embeddings',
    );
    assert.equal(embCount?.n, 0, 'embedding tables must be empty after migration (no backfill)');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one pre-v32 backup must exist');

    db.close();
  });

  it('v2 -> v3 -> v4 path works end-to-end', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV2Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta);
    assert.equal(meta.schema_version, 32, 'v2 DB must reach v32 via chained migrations');

    for (const t of ['discussions_fts', 'audit_fts']) {
      const row = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [t],
      );
      assert.ok(row !== undefined, `${t} must exist after migration chain`);
    }

    for (const t of ['discussions_embeddings', 'audit_embeddings', 'audit_embeddings']) {
      const row = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [t],
      );
      assert.ok(row !== undefined, `${t} must exist after migration chain`);
    }

    // file_registry tables were dropped at v7 (ADR 0001); verify they're gone.
    for (const t of ['file_registry', 'file_registry_fts', 'file_registry_embeddings']) {
      const row = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE name=?",
        [t],
      );
      assert.equal(row, undefined, `${t} must be absent after v7 drop`);
    }

    db.close();
  });

  it('v3 -> v4 migration is idempotent — re-opening at v4 does not create a second backup', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV3Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const firstCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v4 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(secondCount, 1, 'reopening at v4 must not create another backup');
  });

  it('FK CASCADE — deleting a discussion removes its embedding', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV3Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    db.run(
      `INSERT INTO discussions (id, issue_id, author, kind, body, created_at)
       VALUES (1, -1, 'bro', 'note', 'cascade test', '2026-01-01T00:00:00Z')`,
    );
    const fakeBuf = Buffer.alloc(384 * 4, 0);
    db.run(
      'INSERT INTO discussions_embeddings (discussion_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)',
      [1, fakeBuf, 'test-model', new Date().toISOString()],
    );

    const before = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM discussions_embeddings WHERE discussion_id = 1',
    );
    assert.equal(before?.n, 1, 'embedding must exist before delete');

    db.run('DELETE FROM discussions WHERE id = 1');

    const after = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM discussions_embeddings WHERE discussion_id = 1',
    );
    assert.equal(after?.n, 0, 'embedding must be cascade-deleted');

    db.close();
  });
});

function seedV8Db(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE issues (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        objective   TEXT    NOT NULL,
        description TEXT    NOT NULL DEFAULT '',
        status      TEXT    NOT NULL DEFAULT 'open',
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL,
        closed_at   TEXT,
        remote_iid  INTEGER,
        remote_kind TEXT CHECK(remote_kind IN ('github','gitlab')),
        gh_iid      INTEGER,
        gl_iid      INTEGER
    );
    CREATE TABLE tasks (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id          INTEGER NOT NULL REFERENCES issues(id),
        branch_id         TEXT    NOT NULL,
        parent_branch_id  TEXT,
        title             TEXT    NOT NULL DEFAULT '',
        description       TEXT    NOT NULL,
        status            TEXT    NOT NULL DEFAULT 'pending',
        attempts          INTEGER NOT NULL DEFAULT 0,
        spec_body         TEXT    NOT NULL DEFAULT '',
        commit_sha        TEXT,
        repo              TEXT,
        created_at        TEXT    NOT NULL,
        updated_at        TEXT    NOT NULL,
        completed_at      TEXT
    );
    CREATE TABLE agent_runs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id      INTEGER REFERENCES tasks(id),
        issue_id     INTEGER REFERENCES issues(id),
        agent_type   TEXT    NOT NULL,
        tokens_in    INTEGER NOT NULL DEFAULT 0,
        tokens_out   INTEGER NOT NULL DEFAULT 0,
        tokens_total INTEGER NOT NULL DEFAULT 0,
        tool_uses    INTEGER NOT NULL DEFAULT 0,
        duration_ms  INTEGER NOT NULL DEFAULT 0,
        started_at   TEXT,
        completed_at TEXT
    );
    CREATE TABLE pr_review_runs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_number       INTEGER NOT NULL,
        repo            TEXT    NOT NULL,
        last_fetched_at DATETIME NOT NULL,
        last_comment_id TEXT
    );
    CREATE TABLE plugin_meta (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        plugin_version TEXT    NOT NULL
    );
    CREATE TABLE plugin_config (
        key        TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    );
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (-1, 'system', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (1, 'test issue', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at)
    VALUES (1, 1, 'feat/v8-task', 'v8 task', 'pending', datetime('now'), datetime('now'));
    INSERT INTO pr_review_runs (pr_number, repo, last_fetched_at)
    VALUES (42, 'owner/repo', datetime('now'));
    INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 8, '0.7.0');
  `);
  db.close();
}

describe('schema upgrade — v8 -> v9 migration (cache-class token columns + pr_review_runs audit)', () => {
  it('v8 DB upgrades to v9 with cache token columns added to agent_runs', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV8Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta, 'plugin_meta row required');
    assert.equal(meta.schema_version, 32, 'schema_version must be 32 after migration');

    const cols = db.all<{ name: string }>('PRAGMA table_info(agent_runs)').map((c) => c.name);
    assert.ok(cols.includes('cache_read_tokens'), 'cache_read_tokens must exist after v9 migration');
    assert.ok(cols.includes('cache_creation_tokens'), 'cache_creation_tokens must exist after v9 migration');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one pre-v32 backup must exist');

    db.close();
  });

  it('v8 DB upgrades through v9 to the cursor-only pr_review_runs shape', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV8Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const cols = db.all<{ name: string }>('PRAGMA table_info(pr_review_runs)').map((c) => c.name);
    assert.ok(cols.includes('task_id'), 'task_id must exist in pr_review_runs after v9 migration');
    assert.ok(!cols.includes('verdict'), 'verdict is dropped by the v29 step of the chain');
    assert.ok(!cols.includes('attempt_n'), 'attempt_n is dropped by the v29 step of the chain');

    const auditIdx = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pr_review_runs_audit'",
    );
    assert.equal(auditIdx, undefined, 'idx_pr_review_runs_audit is gone once the chain reaches v29');

    const existingRow = db.get<{ pr_number: number }>(
      'SELECT pr_number FROM pr_review_runs WHERE pr_number = 42',
    );
    assert.ok(existingRow, 'pre-migration monitoring rows must survive v9 migration');

    db.close();
  });

  it('v8->v9 migration is idempotent', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV8Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const firstCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v9 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(secondCount, 1, 'reopening at v9 must not create another backup');
  });

  it('fresh DB leaves unwritten cache token columns NULL (unmeasured since v30)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');

    const db = new TrajectoryDB(dbPath);

    db.run(
      `INSERT INTO issues (objective, description, status, created_at, updated_at) VALUES ('test', '', 'open', datetime('now'), datetime('now'))`,
    );
    const issueId = (db.get<{ id: number }>('SELECT last_insert_rowid() AS id') as { id: number }).id;

    db.run(
      `INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out) VALUES (NULL, ?, 'swe', 100, 50)`,
      [issueId],
    );
    const run = db.get<{ cache_read_tokens: number | null; cache_creation_tokens: number | null }>(
      'SELECT cache_read_tokens, cache_creation_tokens FROM agent_runs WHERE issue_id = ?',
      [issueId],
    );
    assert.ok(run, 'agent_run row must exist');
    assert.equal(run.cache_read_tokens, null, 'an unwritten cache_read_tokens is NULL (unmeasured)');
    assert.equal(run.cache_creation_tokens, null, 'an unwritten cache_creation_tokens is NULL (unmeasured)');

    db.close();
  });
});

function seedV9Db(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // Minimal v9 schema: tasks table WITHOUT prompt_bearing column.
  db.exec(`
    CREATE TABLE issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        objective TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL REFERENCES issues(id),
        branch_id TEXT NOT NULL,
        parent_branch_id TEXT,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        spec_body TEXT NOT NULL DEFAULT '',
        commit_sha TEXT,
        repo TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
    );
    CREATE TABLE audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL REFERENCES issues(id),
        branch_id TEXT,
        from_node TEXT NOT NULL DEFAULT 'executor',
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        content_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
    );
    CREATE TABLE plugin_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        plugin_version TEXT NOT NULL
    );
    CREATE TABLE plugin_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    );
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (-1, 'system', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (1, 'test issue', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO tasks (id, issue_id, branch_id, title, description, status, attempts, spec_body, created_at, updated_at)
    VALUES (1, 1, 'feat/old-task', '', 'desc', 'pending', 0, '', datetime('now'), datetime('now'));
    INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 9, '0.7.0');
  `);
  db.close();
}

describe('schema upgrade — v9 -> v10 migration (prompt_bearing column)', () => {
  it('v9 DB gains prompt_bearing column on tasks after migration', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV9Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta, 'plugin_meta row required');
    assert.equal(meta.schema_version, 32, 'schema_version must be 32 after v9->v10 migration');

    const cols = db.all<{ name: string }>('PRAGMA table_info(tasks)').map((c) => c.name);
    assert.ok(cols.includes('prompt_bearing'), 'tasks.prompt_bearing must exist after migration');

    db.close();
  });

  it('v9->v10: existing task row gets prompt_bearing=0 default', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV9Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const task = db.get<{ prompt_bearing: number }>('SELECT prompt_bearing FROM tasks WHERE id = 1');
    assert.ok(task, 'seeded task must survive migration');
    assert.equal(task.prompt_bearing, 0, 'existing task must have prompt_bearing=0 after migration');

    db.close();
  });

  it('v9->v10: new task can set prompt_bearing=1', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV9Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    db.run(
      `INSERT INTO tasks (issue_id, branch_id, description, status, spec_body, prompt_bearing, created_at, updated_at)
       VALUES (1, 'feat/prompt-task', 'desc', 'pending', '', 1, datetime('now'), datetime('now'))`,
    );
    const task = db.get<{ prompt_bearing: number }>(
      'SELECT prompt_bearing FROM tasks WHERE branch_id = ?',
      ['feat/prompt-task'],
    );
    assert.ok(task, 'new task must be insertable with prompt_bearing=1');
    assert.equal(task.prompt_bearing, 1, 'prompt_bearing=1 must be stored correctly');

    db.close();
  });

  it('v9->v10 migration is idempotent', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV9Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const firstCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v10 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(secondCount, 1, 'reopening at v10 must not create another backup');
  });

  it('fresh v10 DB has prompt_bearing column with default 0', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.equal(meta?.schema_version, 32, 'fresh DB schema_version must be 32');

    const cols = db.all<{ name: string }>('PRAGMA table_info(tasks)').map((c) => c.name);
    assert.ok(cols.includes('prompt_bearing'), 'prompt_bearing must exist in fresh DB');

    db.close();
  });
});

function seedV10Db(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        objective TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL REFERENCES issues(id),
        branch_id TEXT NOT NULL,
        parent_branch_id TEXT,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        spec_body TEXT NOT NULL DEFAULT '',
        commit_sha TEXT,
        repo TEXT,
        prompt_bearing INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
    );
    CREATE TABLE repos (
        name TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        file_count INTEGER NOT NULL DEFAULT 0,
        last_scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE plugin_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        plugin_version TEXT NOT NULL
    );
    CREATE TABLE plugin_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    );
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (-1, 'system', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (1, 'test issue', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO tasks (id, issue_id, branch_id, description, status, attempts, spec_body, created_at, updated_at)
    VALUES (1, 1, 'feat/v10-task', 'desc', 'pending', 0, '', datetime('now'), datetime('now'));
    INSERT INTO repos (name, path, file_count) VALUES ('myrepo', '/home/user/myrepo', 42);
    INSERT INTO plugin_config (key, value_json) VALUES ('pr_target', '"dev"');
    INSERT INTO plugin_config (key, value_json) VALUES ('branching_model', '"github-flow"');
    INSERT INTO plugin_config (key, value_json) VALUES ('protected_branches', '["dev","main"]');
    INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 10, '0.8.0');
  `);
  db.close();
}

describe('schema upgrade — v10 -> v11 migration (per-repo target_branch columns)', () => {
  it('v10 DB gains target_branch/branching_model/protected_branches on repos', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV10Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta, 'plugin_meta row required');
    assert.equal(meta.schema_version, 32, 'schema_version must be 32 after v10->v11 migration');

    const cols = db.all<{ name: string }>('PRAGMA table_info(repos)').map((c) => c.name);
    assert.ok(cols.includes('target_branch'), 'repos.target_branch must exist after migration');
    assert.ok(cols.includes('branching_model'), 'repos.branching_model must exist after migration');
    assert.ok(cols.includes('protected_branches'), 'repos.protected_branches must exist after migration');

    db.close();
  });

  it('v10->v11 backfill: existing repos row gets values from global plugin_config', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV10Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const row = db.get<{
      target_branch: string | null;
      branching_model: string | null;
      protected_branches: string | null;
    }>('SELECT target_branch, branching_model, protected_branches FROM repos WHERE name = ?', ['myrepo']);

    assert.ok(row, 'repos row must survive migration');
    assert.equal(row.target_branch, 'dev', 'target_branch must be backfilled from global pr_target');
    assert.equal(row.branching_model, 'github-flow', 'branching_model must be backfilled from global config');
    assert.equal(row.protected_branches, '["dev","main"]', 'protected_branches must be backfilled from global config');

    db.close();
  });

  it('v10->v11: repos with no global config get NULL columns', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');

    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec(`
      CREATE TABLE repos (
          name TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          file_count INTEGER NOT NULL DEFAULT 0,
          last_scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE plugin_meta (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          schema_version INTEGER NOT NULL,
          plugin_version TEXT NOT NULL
      );
      CREATE TABLE plugin_config (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL
      );
      INSERT INTO repos (name, path) VALUES ('bare-repo', '/tmp/bare');
      INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 10, '0.8.0');
    `);
    raw.close();

    const db = new TrajectoryDB(dbPath);

    const row = db.get<{ target_branch: string | null }>(
      'SELECT target_branch FROM repos WHERE name = ?', ['bare-repo'],
    );
    assert.ok(row, 'repos row must survive migration');
    assert.equal(row.target_branch, null, 'target_branch must be NULL when no global config exists');

    db.close();
  });

  it('v10->v11 migration is idempotent', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV10Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const firstCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v11 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(secondCount, 1, 'reopening at v11 must not create another backup');
  });

  it('fresh DB has repos columns and schema_version=15', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.equal(meta?.schema_version, 32, 'fresh DB schema_version must be 32');

    const cols = db.all<{ name: string }>('PRAGMA table_info(repos)').map((c) => c.name);
    assert.ok(cols.includes('target_branch'), 'target_branch must exist in fresh DB repos table');
    assert.ok(cols.includes('branching_model'), 'branching_model must exist in fresh DB repos table');
    assert.ok(cols.includes('protected_branches'), 'protected_branches must exist in fresh DB repos table');

    db.close();
  });
});

function seedV11Db(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        objective TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL REFERENCES issues(id),
        branch_id TEXT NOT NULL,
        parent_branch_id TEXT,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        spec_body TEXT NOT NULL DEFAULT '',
        commit_sha TEXT,
        repo TEXT,
        prompt_bearing INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
    );
    CREATE TABLE repos (
        name TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        file_count INTEGER NOT NULL DEFAULT 0,
        last_scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
        target_branch TEXT,
        branching_model TEXT,
        protected_branches TEXT
    );
    CREATE TABLE agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER REFERENCES tasks(id),
        issue_id INTEGER REFERENCES issues(id),
        agent_type TEXT NOT NULL,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        tokens_total INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        tool_uses INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        completed_at TEXT
    );
    CREATE TABLE plugin_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        plugin_version TEXT NOT NULL
    );
    CREATE TABLE plugin_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    );
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (-1, 'system', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (1, 'test issue', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO tasks (id, issue_id, branch_id, description, status, attempts, spec_body, created_at, updated_at)
    VALUES (1, 1, 'feat/v11-task', 'desc', 'pending', 0, '', datetime('now'), datetime('now'));
    INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, tokens_total, started_at)
    VALUES (1, 1, 'bro', 100, 50, 150, datetime('now'));
    INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 11, '0.8.0');
  `);
  db.close();
}

describe('schema upgrade — v11 -> v12 migration (usage_baseline_json column)', () => {
  it('v11 DB upgrades through v12 to v32; usage_baseline_json is dropped again at v31', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV11Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta, 'plugin_meta row required');
    assert.equal(meta.schema_version, 32, 'schema_version must be 32 after v11->v12 migration');

    const cols = db.all<{ name: string }>('PRAGMA table_info(agent_runs)').map((c) => c.name);
    assert.ok(!cols.includes('usage_baseline_json'), 'usage_baseline_json is dropped by the v31 step of the chain');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v32 backup must be written on upgrade');

    db.close();
  });

  it('v11->v12: an existing agent_run row survives the chain', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV11Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const run = db.get<{ id: number }>('SELECT id FROM agent_runs WHERE id = 1');
    assert.ok(run, 'seeded agent_run must survive migration');

    db.close();
  });

  it('v11->v12 migration is idempotent (chained to v13)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV11Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const firstCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v12 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(secondCount, 1, 'reopening at v12 must not create another backup');
  });

  it('fresh DB has no usage_baseline_json column (dropped at v31)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.equal(meta?.schema_version, 32, 'fresh DB schema_version must be 32');

    const cols = db.all<{ name: string }>('PRAGMA table_info(agent_runs)').map((c) => c.name);
    assert.ok(!cols.includes('usage_baseline_json'), 'usage_baseline_json must not exist in a fresh DB');

    db.close();
  });
});

function seedV12Db(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        objective TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL REFERENCES issues(id),
        branch_id TEXT NOT NULL,
        parent_branch_id TEXT,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        spec_body TEXT NOT NULL DEFAULT '',
        commit_sha TEXT,
        repo TEXT,
        prompt_bearing INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
    );
    CREATE TABLE plugin_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        plugin_version TEXT NOT NULL
    );
    CREATE TABLE plugin_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    );
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (-1, 'system', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (1, 'test issue', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO tasks (id, issue_id, branch_id, description, status, attempts, spec_body, created_at, updated_at)
    VALUES (1, 1, 'feat/v12-task', 'desc', 'pending', 0, '## Success Criteria\n- it works', datetime('now'), datetime('now'));
    INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 12, '0.9.0');
  `);
  db.close();
}

describe('schema upgrade — v12 -> v13 migration (typed files/verification columns, #673)', () => {
  it('v12 DB gains files + verification columns on tasks after migration', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV12Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta, 'plugin_meta row required');
    assert.equal(meta.schema_version, 32, 'schema_version must be 32 after v12->v13 migration');

    const cols = db.all<{ name: string }>('PRAGMA table_info(tasks)').map((c) => c.name);
    assert.ok(cols.includes('files'), 'tasks.files must exist after migration');
    assert.ok(cols.includes('verification'), 'tasks.verification must exist after migration');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v32 backup must be written on upgrade');

    db.close();
  });

  it('v12->v13: existing task row gets files/verification = empty JSON array (clean break, no backfill)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV12Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const row = db.get<{ id: number; files: string; verification: string }>(
      'SELECT id, files, verification FROM tasks WHERE id = 1',
    );
    assert.ok(row, 'seeded task must survive migration');
    assert.equal(row.files, '[]', 'existing rows must default files to an empty JSON array');
    assert.equal(
      row.verification,
      '[]',
      'existing rows must default verification to an empty JSON array',
    );

    db.close();
  });

  it('v12->v13 migration is idempotent (no second backup on re-open)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV12Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const firstCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v13 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(secondCount, 1, 'reopening at v13 must not create another backup');
  });

  it('fresh v13 DB has files + verification columns defaulting to empty arrays', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.equal(meta?.schema_version, 32, 'fresh DB schema_version must be 32');

    const cols = db.all<{ name: string }>('PRAGMA table_info(tasks)').map((c) => c.name);
    assert.ok(cols.includes('files'), 'files must exist in fresh DB tasks');
    assert.ok(cols.includes('verification'), 'verification must exist in fresh DB tasks');

    db.run(
      `INSERT INTO tasks (issue_id, branch_id, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [-1, 'feat/fresh-typed', 'desc', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
    );
    const row = db.get<{ files: string; verification: string }>(
      `SELECT files, verification FROM tasks WHERE branch_id = 'feat/fresh-typed'`,
    );
    assert.equal(row?.files, '[]', 'fresh insert defaults files to empty array');
    assert.equal(row?.verification, '[]', 'fresh insert defaults verification to empty array');

    db.close();
  });
});

function seedV13Db(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        objective TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE plugin_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        plugin_version TEXT NOT NULL
    );
    CREATE TABLE plugin_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    );
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (-1, 'system', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 13, '0.10.0-alpha');
  `);
  db.close();
}

describe('schema upgrade — v13 -> v14 migration (cheatcode install stage, #659)', () => {
  it('v13 DB gains cheatcodes + cheatcode_attachments tables after migration', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV13Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta, 'plugin_meta row required');
    assert.equal(meta.schema_version, 32, 'schema_version must be 32 after v13->v14 migration');

    for (const t of ['cheatcodes', 'cheatcode_attachments']) {
      const row = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [t],
      );
      assert.ok(row !== undefined, `${t} table must exist after migration`);
    }

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v32 backup must be written on upgrade');

    db.close();
  });

  it('v13->v14 migration is idempotent (no second backup on re-open)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV13Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const firstCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v18 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(secondCount, 1, 'reopening at v18 must not create another backup');
  });

  it('v13->v14: cheatcode_attachments FKs cheatcodes with cascade delete', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV13Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const cc = db.run(
      `INSERT INTO cheatcodes (name, kind, source_url, version, trust_tier, status, installed_at)
       VALUES (?, ?, ?, ?, ?, 'installed', ?)`,
      ['pdf', 'plugin', 'https://github.com/x/pdf', '1.0.0', 'trusted', '2026-01-01T00:00:00.000Z'],
    );
    const id = Number(cc.lastInsertRowid);
    db.run(
      `INSERT INTO cheatcode_attachments (cheatcode_id, target, artifact, created_at)
       VALUES (?, ?, ?, ?)`,
      [id, 'plugin', 'marketplace-plugin:https://github.com/x/pdf', '2026-01-01T00:00:00.000Z'],
    );

    db.run('DELETE FROM cheatcodes WHERE id = ?', [id]);
    const orphan = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM cheatcode_attachments WHERE cheatcode_id = ?',
      [id],
    );
    assert.equal(orphan?.n, 0, 'attachment rows cascade-delete with their cheatcode');

    db.close();
  });
});

function seedV14Db(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        objective TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE plugin_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        plugin_version TEXT NOT NULL
    );
    CREATE TABLE plugin_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    );
    CREATE TABLE cheatcodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
        source_url TEXT NOT NULL,
        version TEXT,
        trust_tier TEXT,
        status TEXT NOT NULL DEFAULT 'installed',
        installed_at TEXT NOT NULL,
        UNIQUE(name, source_url)
    );
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (-1, 'system', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO cheatcodes (name, kind, source_url, version, trust_tier, status, installed_at)
    VALUES ('pdf', 'plugin', 'https://github.com/x/pdf', '1.0.0', 'trusted', 'installed', '2026-01-01T00:00:00.000Z');
    INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 14, '0.10.0-beta');
  `);
  db.close();
}

describe('schema upgrade — v14 -> v15 migration (cheatcode install scope, #659)', () => {
  it('v14 DB gains the cheatcodes.scope column after migration', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV14Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta, 'plugin_meta row required');
    assert.equal(meta.schema_version, 32, 'schema_version must be 32 after v14->v15 migration');

    const cols = db.all<{ name: string }>('PRAGMA table_info(cheatcodes)').map((c) => c.name);
    assert.ok(cols.includes('scope'), 'cheatcodes.scope must exist after migration');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v32 backup must be written on upgrade');

    db.close();
  });

  it('v14->v15 default-local scope maps to project-local after the v18->v19 unification (#101)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV14Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const row = db.get<{ name: string; scope: string; origin: string }>(
      `SELECT name, scope, origin FROM cheatcodes WHERE name = 'pdf'`,
    );
    assert.ok(row, 'seeded cheatcode must survive the chained migration');
    assert.equal(row.scope, 'project-local', 'the v14 default-local scope maps to project-local');
    assert.equal(row.origin, 'external', 'a pre-v20 raw repo-URL cheatcode backfills to origin=external (#152)');

    db.close();
  });

  it('v14->v15 migration is idempotent (no second backup on re-open)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV14Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const firstCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v18 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(secondCount, 1, 'reopening at v18 must not create another backup');
  });
});

function seedV15Db(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        objective TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        issue_id INTEGER,
        agent_type TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
    );
    CREATE TABLE rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        file_path TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'project-local',
        severity TEXT NOT NULL DEFAULT 'advisory',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE rule_invocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_name TEXT NOT NULL REFERENCES rules(name),
        agent_name TEXT NOT NULL,
        agent_run_id INTEGER REFERENCES agent_runs(id),
        task_id INTEGER,
        applied_at TEXT NOT NULL,
        outcome TEXT NOT NULL DEFAULT 'applied'
    );
    CREATE TABLE plugin_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        plugin_version TEXT NOT NULL
    );
    CREATE TABLE plugin_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    );
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (-1, 'system', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO rules (name, description, file_path, created_at, updated_at)
    VALUES ('legacy-rule', 'd', '.claude/rules/legacy.md', datetime('now'), datetime('now'));
    INSERT INTO rule_invocations (rule_name, agent_name, applied_at)
    VALUES ('legacy-rule', 'bro', datetime('now'));
    INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 15, '0.10.0-beta');
  `);
  db.close();
}

describe('schema upgrade — v15 -> v16 migration (drop dead rules + rule_invocations registry, #97)', () => {
  it('v15 DB drops the rules + rule_invocations tables after migration (child first)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV15Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta, 'plugin_meta row required');
    assert.equal(meta.schema_version, 32, 'schema_version must be 32 after v15->v16 migration');

    for (const t of ['rules', 'rule_invocations']) {
      const row = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [t],
      );
      assert.equal(row, undefined, `${t} table must be dropped after migration`);
    }

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v32 backup must be written on upgrade');

    db.close();
  });

  it('v15->v16 migration is idempotent (no second backup on re-open)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV15Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const firstCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v18 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(secondCount, 1, 'reopening at v18 must not create another backup');
  });
});

function seedV16Db(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        objective TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE commands (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT    NOT NULL UNIQUE,
        description  TEXT    NOT NULL,
        file_path    TEXT    NOT NULL,
        scope        TEXT    NOT NULL DEFAULT 'global',
        args_schema  TEXT    NOT NULL DEFAULT '{}',
        status       TEXT    NOT NULL DEFAULT 'active',
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL
    );
    CREATE TABLE plugin_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        plugin_version TEXT NOT NULL
    );
    CREATE TABLE plugin_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    );
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (-1, 'system', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO commands (name, description, file_path, created_at, updated_at)
    VALUES ('scan', 'd', 'commands/scan.md', datetime('now'), datetime('now'));
    INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 16, '0.10.0-beta');
  `);
  db.close();
}

describe('schema upgrade — v16 -> v17 migration (drop dead commands catalog, #97)', () => {
  it('v16 DB drops the commands table after migration', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV16Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta, 'plugin_meta row required');
    assert.equal(meta.schema_version, 32, 'schema_version must be 32 after chained v16->v18 migration');

    const row = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='commands'",
    );
    assert.equal(row, undefined, 'commands table must be dropped after migration');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v32 backup must be written on upgrade');

    db.close();
  });

  it('v16->v17 migration is idempotent (no second backup on re-open)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV16Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const firstCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v18 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(secondCount, 1, 'reopening at v18 must not create another backup');
  });
});

function seedV17Db(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        objective TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE skills (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT    NOT NULL UNIQUE,
        description     TEXT    NOT NULL,
        file_path       TEXT    NOT NULL,
        scope           TEXT    NOT NULL DEFAULT 'global',
        trust_tier      TEXT    NOT NULL DEFAULT 'curated',
        status          TEXT    NOT NULL DEFAULT 'active',
        uses            INTEGER NOT NULL DEFAULT 0,
        successes       INTEGER NOT NULL DEFAULT 0,
        effectiveness   REAL,
        created_at      TEXT    NOT NULL,
        updated_at      TEXT    NOT NULL
    );
    CREATE TABLE skill_invocations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_name    TEXT    NOT NULL REFERENCES skills(name),
        agent_name    TEXT    NOT NULL,
        agent_run_id  INTEGER,
        task_id       INTEGER,
        invoked_at    TEXT    NOT NULL,
        outcome       TEXT    NOT NULL DEFAULT 'completed'
    );
    CREATE TABLE plugin_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        plugin_version TEXT NOT NULL
    );
    CREATE TABLE plugin_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    );
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (-1, 'system', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO skills (name, description, file_path, uses, successes, effectiveness, created_at, updated_at)
    VALUES ('tmb_planning', 'd', 'skills/tmb_planning/SKILL.md', 3, 2, 0.66, datetime('now'), datetime('now'));
    INSERT INTO skill_invocations (skill_name, agent_name, invoked_at, outcome)
    VALUES ('tmb_planning', 'bro', datetime('now'), 'completed');
    INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 17, '0.10.0-beta');
  `);
  db.close();
}

describe('schema upgrade — v17 -> v19 chain (drop dead skill stats #97, then unify skills→cheatcodes #101)', () => {
  it('v17 DB folds skills into cheatcodes and repoints skill_invocations after the chained migration', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV17Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta, 'plugin_meta row required');
    assert.equal(meta.schema_version, 32, 'schema_version must be 32 after the v17->v19 chain');

    // skills is gone; cheatcodes is the unified registry.
    const skillsTable = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='skills'",
    );
    assert.equal(skillsTable, undefined, 'skills table must be dropped by v18->v19');

    const cols = db
      .all<{ name: string }>('PRAGMA table_info(cheatcodes)')
      .map((c) => c.name);
    for (const kept of ['name', 'kind', 'origin', 'description', 'file_path', 'scope', 'trust_tier', 'status']) {
      assert.ok(cols.includes(kept), `cheatcodes.${kept} must exist`);
    }

    // The seeded skill row migrated in as origin='builtin'.
    const migrated = db.get<{ origin: string; kind: string; file_path: string }>(
      "SELECT origin, kind, file_path FROM cheatcodes WHERE name = 'tmb_planning'",
    );
    assert.ok(migrated, 'the seeded skill row must survive as a cheatcodes row');
    assert.equal(migrated!.origin, 'builtin', 'migrated skill rows carry origin=builtin');
    assert.equal(migrated!.kind, 'skill');
    assert.equal(migrated!.file_path, 'skills/tmb_planning/SKILL.md');

    // skill_invocations is retired by the v20->v21 migration (#118) — the
    // junction is dropped outright at the end of the chain.
    const invocationsTable = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='skill_invocations'",
    );
    assert.equal(invocationsTable, undefined, 'skill_invocations must be dropped by v20->v21');

    const violations = db.all('PRAGMA foreign_key_check');
    assert.equal(violations.length, 0, 'no dangling FKs after the unification');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v32 backup must be written on upgrade');

    db.close();
  });

  it('v17->v19 migration is idempotent (no second backup on re-open)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV17Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const firstCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v18 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(secondCount, 1, 'reopening at v18 must not create another backup');
  });
});

// A v18-shape DB: the post-#97 skills table (no dead stat columns) + the
// pre-#101 cheatcodes table (local|global scope, no origin/file_path), with
// rows on each side so the unification's row migration + scope mapping + FK
// repoint are all exercised.
function seedV18Db(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        objective TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE skills (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT    NOT NULL UNIQUE,
        description     TEXT    NOT NULL,
        file_path       TEXT    NOT NULL,
        scope           TEXT    NOT NULL DEFAULT 'global'
                          CHECK (scope IN ('global','template','project-local')),
        trust_tier      TEXT    NOT NULL DEFAULT 'curated',
        status          TEXT    NOT NULL DEFAULT 'active',
        created_at      TEXT    NOT NULL,
        updated_at      TEXT    NOT NULL
    );
    CREATE TABLE skill_invocations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_name    TEXT    NOT NULL REFERENCES skills(name),
        agent_name    TEXT    NOT NULL,
        agent_run_id  INTEGER,
        task_id       INTEGER,
        invoked_at    TEXT    NOT NULL,
        outcome       TEXT    NOT NULL DEFAULT 'completed'
    );
    CREATE TABLE cheatcodes (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT    NOT NULL,
        kind         TEXT    NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
        source_url   TEXT    NOT NULL,
        version      TEXT,
        trust_tier   TEXT,
        scope        TEXT    NOT NULL DEFAULT 'local' CHECK (scope IN ('local','global')),
        status       TEXT    NOT NULL DEFAULT 'installed',
        installed_at TEXT    NOT NULL,
        UNIQUE(name, source_url)
    );
    CREATE TABLE cheatcode_attachments (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        cheatcode_id INTEGER NOT NULL REFERENCES cheatcodes(id) ON DELETE CASCADE,
        target       TEXT    NOT NULL,
        artifact     TEXT    NOT NULL,
        created_at   TEXT    NOT NULL
    );
    CREATE TABLE plugin_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        plugin_version TEXT NOT NULL
    );
    CREATE TABLE plugin_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    );
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (-1, 'system', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO skills (name, description, file_path, scope, trust_tier, status, created_at, updated_at)
    VALUES ('tmb_planning', 'd', 'skills/tmb_planning/SKILL.md', 'global', 'curated', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO skill_invocations (skill_name, agent_name, invoked_at, outcome)
    VALUES ('tmb_planning', 'bro', datetime('now'), 'completed');
    INSERT INTO cheatcodes (name, kind, source_url, version, trust_tier, scope, status, installed_at)
    VALUES ('pdf-plugin', 'plugin', 'https://github.com/x/pdf', '1.0.0', 'trusted', 'local', 'installed', '2026-02-02T00:00:00.000Z'),
           ('global-mcp', 'mcp', 'https://github.com/x/mcp', NULL, 'caution', 'global', 'installed', '2026-02-03T00:00:00.000Z');
    INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 18, '0.10.0-beta');
  `);
  db.close();
}

describe('schema upgrade — v18 -> v19 migration (unify skills into cheatcodes, #101)', () => {
  it('migrates installed rows (scope mapped) + skills (origin=builtin) into one cheatcodes table', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV18Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.equal(meta!.schema_version, 32, 'schema_version must be 32 after the v18->v19->v20 chain');

    assert.equal(
      db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='skills'"),
      undefined,
      'skills table must be dropped',
    );

    const pdf = db.get<{ origin: string; scope: string; source_url: string }>(
      "SELECT origin, scope, source_url FROM cheatcodes WHERE name = 'pdf-plugin'",
    );
    assert.equal(pdf!.origin, 'external', 'a raw repo-URL row backfills to origin=external by v24 (#152)');
    assert.equal(pdf!.scope, 'project-local', 'local install scope maps to project-local');
    assert.equal(pdf!.source_url, 'https://github.com/x/pdf');

    const mcp = db.get<{ scope: string }>("SELECT scope FROM cheatcodes WHERE name = 'global-mcp'");
    assert.equal(mcp!.scope, 'global', 'global install scope stays global');

    const skill = db.get<{ origin: string; kind: string; file_path: string; source_url: string | null }>(
      "SELECT origin, kind, file_path, source_url FROM cheatcodes WHERE name = 'tmb_planning'",
    );
    assert.equal(skill!.origin, 'builtin');
    assert.equal(skill!.kind, 'skill');
    assert.equal(skill!.file_path, 'skills/tmb_planning/SKILL.md');
    assert.equal(skill!.source_url, null, 'builtin rows carry NULL source_url');

    const invocationsTable = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='skill_invocations'",
    );
    assert.equal(invocationsTable, undefined, 'skill_invocations must be dropped by v20->v21');
    const violations = db.all('PRAGMA foreign_key_check');
    assert.equal(violations.length, 0, 'no dangling FKs after the unification');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v32 backup written');

    db.close();
  });

  it('v18->v19 migration is idempotent (no second backup, stable rows on re-open)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV18Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    const firstCount = db1.get<{ n: number }>('SELECT COUNT(*) AS n FROM cheatcodes')!.n;
    db1.close();

    const db2 = new TrajectoryDB(dbPath);
    const secondCount = db2.get<{ n: number }>('SELECT COUNT(*) AS n FROM cheatcodes')!.n;
    db2.close();

    assert.equal(firstCount, secondCount, 'row count is stable across re-opens');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(backups, 1, 'reopening at v19 must not create another backup');
  });
});

// A v19 DB: the unified cheatcodes table seeded with the DRIFTED builtin-skill
// list the #101 unification carried forward — it includes the dead
// `tmb_agent-creator` (dir deleted at v0.7.0) and omits the shipped
// `tmb_cheatcode`. This is the exact pre-#102 prod state v19->v20 must correct.
function seedV19Db(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        objective TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE cheatcodes (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT    NOT NULL UNIQUE,
        kind         TEXT    NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
        origin       TEXT    NOT NULL DEFAULT 'installed' CHECK (origin IN ('builtin','installed')),
        description  TEXT    NOT NULL DEFAULT '',
        source_url   TEXT,
        file_path    TEXT,
        version      TEXT,
        trust_tier   TEXT,
        scope        TEXT    NOT NULL DEFAULT 'project-local'
                       CHECK (scope IN ('global','template','project-local')),
        status       TEXT    NOT NULL DEFAULT 'installed',
        installed_at TEXT    NOT NULL,
        created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        CHECK (kind != 'skill' OR file_path IS NOT NULL),
        CHECK (origin != 'installed' OR source_url IS NOT NULL),
        CHECK (origin != 'builtin' OR source_url IS NULL)
    );
    CREATE TABLE skill_invocations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_name    TEXT    NOT NULL REFERENCES cheatcodes(name),
        agent_name    TEXT    NOT NULL,
        agent_run_id  INTEGER,
        task_id       INTEGER,
        invoked_at    TEXT    NOT NULL,
        outcome       TEXT    NOT NULL DEFAULT 'completed'
                        CHECK (outcome IN ('completed','failed','partial'))
    );
    CREATE TABLE plugin_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        plugin_version TEXT NOT NULL
    );
    CREATE TABLE plugin_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    );
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (-1, 'system', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO cheatcodes (name, kind, origin, description, source_url, file_path, scope, trust_tier, status, installed_at)
    VALUES
      ('tmb_planning',      'skill', 'builtin', 'd', NULL, 'skills/tmb_planning/SKILL.md',      'global', 'curated', 'active', '2026-01-01T00:00:00.000Z'),
      ('tmb_agent-creator', 'skill', 'builtin', 'd', NULL, 'skills/tmb_agent-creator/SKILL.md', 'global', 'curated', 'active', '2026-01-01T00:00:00.000Z');
    INSERT INTO skill_invocations (skill_name, agent_name, invoked_at, outcome)
    VALUES ('tmb_planning', 'bro', datetime('now'), 'completed');
    INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 19, '0.10.0-beta');
  `);
  db.close();
}

describe('schema upgrade — v19 -> v20 migration (correct builtin-skill seed drift, #102)', () => {
  it('removes the dangling tmb_agent-creator builtin row and adds tmb_cheatcode', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV19Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.equal(meta!.schema_version, 32, 'schema_version must be 32 after v19->v20');

    const dead = db.get<{ name: string }>(
      "SELECT name FROM cheatcodes WHERE name = 'tmb_agent-creator'",
    );
    assert.equal(dead, undefined, 'dangling tmb_agent-creator builtin row must be deleted');

    const added = db.get<{ origin: string; kind: string; file_path: string; source_url: string | null }>(
      "SELECT origin, kind, file_path, source_url FROM cheatcodes WHERE name = 'tmb_cheatcode'",
    );
    assert.ok(added, 'tmb_cheatcode builtin row must be inserted');
    assert.equal(added!.origin, 'builtin');
    assert.equal(added!.kind, 'skill');
    assert.equal(added!.file_path, 'skills/tmb_cheatcode/SKILL.md');
    assert.equal(added!.source_url, null, 'builtin rows carry NULL source_url');

    // The surviving rows are untouched and no FKs dangle.
    const planning = db.get<{ name: string }>(
      "SELECT name FROM cheatcodes WHERE name = 'tmb_planning'",
    );
    assert.ok(planning, 'unrelated builtin rows survive the correction');
    const violations = db.all('PRAGMA foreign_key_check');
    assert.equal(violations.length, 0, 'no dangling FKs after the seed correction');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v32 backup written');

    db.close();
  });

  it('v19->v20 migration is idempotent (no second backup, stable rows on re-open)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV19Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    const firstCount = db1.get<{ n: number }>('SELECT COUNT(*) AS n FROM cheatcodes')!.n;
    db1.close();

    const db2 = new TrajectoryDB(dbPath);
    const secondCount = db2.get<{ n: number }>('SELECT COUNT(*) AS n FROM cheatcodes')!.n;
    const stillGone = db2.get<{ name: string }>(
      "SELECT name FROM cheatcodes WHERE name = 'tmb_agent-creator'",
    );
    const stillPresent = db2.get<{ name: string }>(
      "SELECT name FROM cheatcodes WHERE name = 'tmb_cheatcode'",
    );
    db2.close();

    assert.equal(firstCount, secondCount, 'row count is stable across re-opens');
    assert.equal(stillGone, undefined, 'tmb_agent-creator stays deleted on re-open');
    assert.ok(stillPresent, 'tmb_cheatcode stays present on re-open');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(backups, 1, 'reopening at v21 must not create another backup');
  });
});

// A v20 DB: the unified cheatcodes registry plus the skill_invocations junction
// the v20->v21 migration (#118) retires. Seeded with rows on both sides so the
// drop is proven not to touch unrelated tables.
function seedV20Db(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        objective TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE cheatcodes (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT    NOT NULL UNIQUE,
        kind         TEXT    NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
        origin       TEXT    NOT NULL DEFAULT 'installed' CHECK (origin IN ('builtin','installed')),
        description  TEXT    NOT NULL DEFAULT '',
        source_url   TEXT,
        file_path    TEXT,
        version      TEXT,
        trust_tier   TEXT,
        scope        TEXT    NOT NULL DEFAULT 'project-local'
                       CHECK (scope IN ('global','template','project-local')),
        status       TEXT    NOT NULL DEFAULT 'installed',
        installed_at TEXT    NOT NULL,
        created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        CHECK (kind != 'skill' OR file_path IS NOT NULL),
        CHECK (origin != 'installed' OR source_url IS NOT NULL),
        CHECK (origin != 'builtin' OR source_url IS NULL)
    );
    CREATE TABLE skill_invocations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_name    TEXT    NOT NULL REFERENCES cheatcodes(name),
        agent_name    TEXT    NOT NULL,
        agent_run_id  INTEGER,
        task_id       INTEGER,
        invoked_at    TEXT    NOT NULL,
        outcome       TEXT    NOT NULL DEFAULT 'completed'
                        CHECK (outcome IN ('completed','failed','partial'))
    );
    CREATE TABLE plugin_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        plugin_version TEXT NOT NULL
    );
    CREATE TABLE plugin_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    );
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (-1, 'system', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO cheatcodes (name, kind, origin, description, source_url, file_path, scope, trust_tier, status, installed_at)
    VALUES ('tmb_planning', 'skill', 'builtin', 'd', NULL, 'skills/tmb_planning/SKILL.md', 'global', 'curated', 'active', '2026-01-01T00:00:00.000Z');
    INSERT INTO skill_invocations (skill_name, agent_name, invoked_at, outcome)
    VALUES ('tmb_planning', 'bro', datetime('now'), 'completed');
    INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 20, '0.10.0-gamma');
  `);
  db.close();
}

describe('schema upgrade — v20 -> v21 migration (retire skill_invocations, #118)', () => {
  it('drops skill_invocations on an existing DB without touching other tables', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV20Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.equal(meta!.schema_version, 32, 'schema_version must be 32 after the v20->v21->v22 chain');

    const invocationsTable = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='skill_invocations'",
    );
    assert.equal(invocationsTable, undefined, 'skill_invocations table must be dropped by v20->v21');

    // Unrelated rows are untouched and no FKs dangle.
    const planning = db.get<{ name: string }>(
      "SELECT name FROM cheatcodes WHERE name = 'tmb_planning'",
    );
    assert.ok(planning, 'cheatcodes rows survive the v20->v21 migration');
    const violations = db.all('PRAGMA foreign_key_check');
    assert.equal(violations.length, 0, 'no dangling FKs after dropping skill_invocations');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v32 backup written');

    db.close();
  });

  it('v20->v21 migration is idempotent (no second backup, table stays gone on re-open)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV20Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const db2 = new TrajectoryDB(dbPath);
    const stillGone = db2.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='skill_invocations'",
    );
    db2.close();

    assert.equal(stillGone, undefined, 'skill_invocations stays gone on re-open');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(backups, 1, 'reopening at v21 must not create another backup');
  });
});

function seedV21Db(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE issues (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        objective   TEXT    NOT NULL,
        description TEXT    NOT NULL DEFAULT '',
        status      TEXT    NOT NULL DEFAULT 'open',
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL,
        closed_at   TEXT,
        remote_iid  INTEGER,
        remote_kind TEXT,
        gh_iid      INTEGER,
        gl_iid      INTEGER
    );
    CREATE TABLE plugin_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        plugin_version TEXT NOT NULL
    );
    CREATE TABLE plugin_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    );
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (-1, 'system', '', 'open', datetime('now'), datetime('now'));
    INSERT INTO issues (objective, description, status, created_at, updated_at)
    VALUES ('pre-v22 issue', 'body', 'open', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 21, '0.10.0-gamma');
  `);
  db.close();
}

describe('schema upgrade — v21 -> v22 migration (issues.milestone, #83/#763)', () => {
  it('adds a nullable milestone column to an existing DB without touching other columns', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV21Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.equal(meta!.schema_version, 32, 'schema_version must be 32 after v21->v22');

    const cols = db.all<{ name: string }>('PRAGMA table_info(issues)').map((c) => c.name);
    assert.ok(cols.includes('milestone'), 'issues.milestone column must exist after v21->v22');

    // Pre-existing rows backfill to NULL; no other column is disturbed.
    const row = db.get<{ objective: string; milestone: string | null }>(
      "SELECT objective, milestone FROM issues WHERE objective = 'pre-v22 issue'",
    );
    assert.ok(row, 'pre-existing issue row must survive the migration');
    assert.equal(row!.milestone, null, 'existing rows backfill milestone to NULL');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v32 backup written');

    db.close();
  });

  it('v21->v22 migration is idempotent (no second backup, column stays on re-open)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV21Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const db2 = new TrajectoryDB(dbPath);
    const cols = db2.all<{ name: string }>('PRAGMA table_info(issues)').map((c) => c.name);
    db2.close();
    assert.ok(cols.includes('milestone'), 'milestone column stays on re-open');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v32.') && f.endsWith('.bak'),
    ).length;
    assert.equal(backups, 1, 'reopening at v25 must not create another backup');
  });
});

// #155 — repos-centric schema (v22 -> v23). seedV21Db chains v21 -> v23, so the
// repos-centric migration runs as part of the same TrajectoryDB open. These
// assertions target the v22 -> v23 step's invariants: the milestones table, the
// repo FK columns, repos.remotes, and FK enforcement.
describe('schema upgrade — v22 -> v23 repos-centric migration (#155)', () => {
  it('creates milestones + repo FK columns and reaches v23', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV21Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.equal(meta!.schema_version, 32, 'schema_version must be 32 after v22->v23');

    const milestonesExists = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='milestones'",
    );
    assert.ok(milestonesExists, 'milestones table must exist after v22->v23');

    for (const table of ['issues', 'tasks', 'discussions', 'audit', 'agent_runs', 'validation_attempts']) {
      const cols = db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
      assert.ok(cols.includes('repo'), `${table}.repo column must exist after v22->v23`);
    }

    const reposCols = db.all<{ name: string }>('PRAGMA table_info(repos)').map((c) => c.name);
    assert.ok(reposCols.includes('remotes'), 'repos.remotes column must exist after v22->v23');

    // FK enforcement: declared on issues.repo -> repos(name).
    const issuesFk = db.all<{ table: string; from: string }>('PRAGMA foreign_key_list(issues)');
    assert.ok(
      issuesFk.some((fk) => fk.table === 'repos' && fk.from === 'repo'),
      'issues.repo must declare an FK to repos(name)',
    );

    db.close();
  });
});

// #150/#152 — cheatcode registry data-integrity + origin provenance (v23 -> v24).
// Seed a minimal v23-shaped cheatcodes table (old origin enum builtin|installed)
// carrying both the scan-ingest garbage rows (#150) and real installed rows, then
// open with TrajectoryDB so migrateV23toV24 runs.
function seedV23Cheatcodes(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE plugin_meta (
        id             INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        plugin_version TEXT    NOT NULL
    );
    INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 23, '0.10.0-delta');
    CREATE TABLE cheatcodes (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT    NOT NULL UNIQUE,
        kind         TEXT    NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
        origin       TEXT    NOT NULL DEFAULT 'installed' CHECK (origin IN ('builtin','installed')),
        description  TEXT    NOT NULL DEFAULT '',
        source_url   TEXT,
        file_path    TEXT,
        version      TEXT,
        trust_tier   TEXT,
        scope        TEXT    NOT NULL DEFAULT 'project-local'
                       CHECK (scope IN ('global','template','project-local')),
        status       TEXT    NOT NULL DEFAULT 'installed',
        installed_at TEXT    NOT NULL,
        created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        CHECK (kind != 'skill' OR file_path IS NOT NULL),
        CHECK (origin != 'installed' OR source_url IS NOT NULL),
        CHECK (origin != 'builtin' OR source_url IS NULL)
    );
    CREATE TABLE cheatcode_attachments (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        cheatcode_id INTEGER NOT NULL REFERENCES cheatcodes(id) ON DELETE CASCADE,
        target       TEXT    NOT NULL,
        artifact     TEXT    NOT NULL,
        created_at   TEXT    NOT NULL
    );
  `);
  const ins = (
    name: string,
    kind: string,
    origin: string,
    sourceUrl: string | null,
    filePath: string | null,
  ): void => {
    db.prepare(
      `INSERT INTO cheatcodes (name, kind, origin, source_url, file_path, installed_at)
       VALUES (?, ?, ?, ?, ?, '2026-06-01T00:00:00Z')`,
    ).run(name, kind, origin, sourceUrl, filePath);
  };
  // A real builtin skill — must survive untouched as origin=builtin.
  ins('tmb_planning', 'skill', 'builtin', null, 'skills/tmb_planning/SKILL.md');
  // Real installed rows that backfill to a provenance: the named-marketplace set
  // and superpowers (external), plus a generic external repo URL.
  ins('typescript-lsp', 'plugin', 'installed', 'typescript-lsp@claude-plugins-official', null);
  ins('mcp-server-dev', 'plugin', 'installed', 'mcp-server-dev@claude-plugins-official', null);
  ins('plugin-dev', 'plugin', 'installed', 'plugin-dev@claude-plugins-official', null);
  ins('superpowers', 'plugin', 'installed', 'https://github.com/obra/superpowers.git', null);
  ins('pdf-extract', 'plugin', 'installed', 'https://github.com/x/pdf', null);
  // Scan-ingest garbage (#150): header words pass the charset gate (denylisted);
  // the ❯ glyph + a tokenized fragment fail the charset gate.
  ins('Installed', 'plugin', 'installed', 'scan_discovered', null);
  ins('Version', 'plugin', 'installed', 'scan_discovered', null);
  ins('Scope', 'plugin', 'installed', 'scan_discovered', null);
  ins('Status', 'plugin', 'installed', 'scan_discovered', null);
  ins('Location', 'plugin', 'installed', 'scan_discovered', null);
  ins('❯', 'plugin', 'installed', 'scan_discovered', null);
  ins('foo bar', 'plugin', 'installed', 'scan_discovered', null);
  db.close();
}

describe('schema upgrade — v23 -> v24 cheatcode registry integrity (#150/#152)', () => {
  it('deletes scan-ingest garbage rows and backfills origin provenance, reaching v25', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV23Cheatcodes(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.equal(meta!.schema_version, 32, 'schema_version must be 32 after the v23->v24->v25 chain');

    // (#150) Every scan_discovered garbage row is gone.
    const garbage = db.all<{ name: string }>(
      "SELECT name FROM cheatcodes WHERE source_url = 'scan_discovered'",
    );
    assert.equal(garbage.length, 0, 'all scan_discovered garbage rows deleted');
    for (const bad of ['Installed', 'Version', 'Scope', 'Status', 'Location', '❯', 'foo bar']) {
      const row = db.get<{ name: string }>('SELECT name FROM cheatcodes WHERE name = ?', [bad]);
      assert.equal(row, undefined, `garbage row '${bad}' must be deleted`);
    }

    // (#152) origin is the provenance enum, backfilled from the source.
    const originOf = (name: string): string | undefined =>
      db.get<{ origin: string }>('SELECT origin FROM cheatcodes WHERE name = ?', [name])?.origin;
    assert.equal(originOf('tmb_planning'), 'builtin', 'builtin survives untouched');
    assert.equal(originOf('typescript-lsp'), 'marketplace', 'named marketplace set → marketplace');
    assert.equal(originOf('mcp-server-dev'), 'marketplace', 'named marketplace set → marketplace');
    assert.equal(originOf('plugin-dev'), 'marketplace', 'named marketplace set → marketplace');
    assert.equal(originOf('superpowers'), 'external', 'superpowers → external');
    assert.equal(originOf('pdf-extract'), 'external', 'raw repo URL → external');

    // The new CHECK admits the provenance enum and rejects the retired 'installed'.
    assert.throws(
      () =>
        db.run(
          `INSERT INTO cheatcodes (name, kind, origin, source_url, installed_at)
           VALUES ('bad-origin', 'plugin', 'installed', 'x', '2026-06-01T00:00:00Z')`,
        ),
      /CHECK|constraint/i,
      "retired origin 'installed' must be rejected by the new CHECK",
    );

    db.close();
  });
});

// #161 — split the dual-responsibility tmb_push-triage builtin skill into
// tmb_push-gate + tmb_comment-triage (v24 -> v25). Seed a v24-shaped cheatcodes
// table (provenance enum builtin|marketplace|external) carrying the old
// tmb_push-triage builtin row, then open with TrajectoryDB so migrateV24toV25 runs.
function seedV24PushTriage(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE plugin_meta (
        id             INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        plugin_version TEXT    NOT NULL
    );
    INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 24, '0.10.0-delta');
    CREATE TABLE cheatcodes (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT    NOT NULL UNIQUE,
        kind         TEXT    NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
        origin       TEXT    NOT NULL DEFAULT 'external' CHECK (origin IN ('builtin','marketplace','external')),
        description  TEXT    NOT NULL DEFAULT '',
        source_url   TEXT,
        file_path    TEXT,
        version      TEXT,
        trust_tier   TEXT,
        scope        TEXT    NOT NULL DEFAULT 'project-local'
                       CHECK (scope IN ('global','template','project-local')),
        status       TEXT    NOT NULL DEFAULT 'installed',
        installed_at TEXT    NOT NULL,
        created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        CHECK (kind != 'skill' OR file_path IS NOT NULL),
        CHECK (origin = 'builtin' OR source_url IS NOT NULL),
        CHECK (origin != 'builtin' OR source_url IS NULL)
    );
  `);
  const ins = (name: string, filePath: string): void => {
    db.prepare(
      `INSERT INTO cheatcodes (name, kind, origin, source_url, file_path, installed_at)
       VALUES (?, 'skill', 'builtin', NULL, ?, '2026-06-01T00:00:00Z')`,
    ).run(name, filePath);
  };
  // The old dual-responsibility builtin row that the split retires.
  ins('tmb_push-triage', 'skills/tmb_push-triage/SKILL.md');
  // An unrelated builtin that must survive the split untouched.
  ins('tmb_planning', 'skills/tmb_planning/SKILL.md');
  db.close();
}

describe('schema upgrade — v24 -> v25 split tmb_push-triage (#161)', () => {
  it('replaces the tmb_push-triage builtin row with tmb_push-gate + tmb_comment-triage', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV24PushTriage(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.equal(meta!.schema_version, 32, 'schema_version must be 32 after v24->v25');

    const dead = db.get<{ name: string }>(
      "SELECT name FROM cheatcodes WHERE name = 'tmb_push-triage' AND origin = 'builtin'",
    );
    assert.equal(dead, undefined, 'the old tmb_push-triage builtin row must be deleted');

    for (const [name, filePath] of [
      ['tmb_push-gate', 'skills/tmb_push-gate/SKILL.md'],
      ['tmb_comment-triage', 'skills/tmb_comment-triage/SKILL.md'],
    ] as const) {
      const row = db.get<{ origin: string; file_path: string; source_url: string | null }>(
        'SELECT origin, file_path, source_url FROM cheatcodes WHERE name = ?',
        [name],
      );
      assert.ok(row, `${name} builtin row must be inserted`);
      assert.equal(row!.origin, 'builtin');
      assert.equal(row!.file_path, filePath);
      assert.equal(row!.source_url, null, 'builtin rows carry NULL source_url');
    }

    const planning = db.get<{ name: string }>(
      "SELECT name FROM cheatcodes WHERE name = 'tmb_planning'",
    );
    assert.ok(planning, 'unrelated builtin rows survive the split');

    db.close();
  });

  it('is idempotent — reopening at v25 leaves exactly the two new rows', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV24PushTriage(dbPath);

    new TrajectoryDB(dbPath).close();
    const db = new TrajectoryDB(dbPath);

    const rows = db.all<{ name: string }>(
      "SELECT name FROM cheatcodes WHERE name IN ('tmb_push-gate','tmb_comment-triage') ORDER BY name",
    );
    assert.deepEqual(
      rows.map((r) => r.name),
      ['tmb_comment-triage', 'tmb_push-gate'],
      'exactly one row each, no duplicates after re-run',
    );

    db.close();
  });
});

// v25 -> v26: typed mcp_available column replaces the 'MCP available:' feedback
// prefix on validation_attempts (#157). Seed a fully schema-valid DB, then swap
// validation_attempts back to its OLD v25 shape (feedback CHECK enforcing the
// prefix, no mcp_available) and stamp plugin_meta to 25, so opening with
// TrajectoryDB runs migrateV25toV26 against a real v25 table.
function seedV25ValidationAttempts(dbPath: string): void {
  const schemaDir = dirname(fileURLToPath(import.meta.url));
  const schema = readFileSync(join(schemaDir, '..', 'schema.sql'), 'utf8');

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(schema);

  // Replace the current validation_attempts with its v25 shape (the old feedback
  // CHECK, no mcp_available column).
  db.exec('DROP TABLE validation_attempts');
  db.exec(`
    CREATE TABLE validation_attempts (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id             INTEGER NOT NULL REFERENCES tasks(id),
        attempt_n           INTEGER NOT NULL,
        agent               TEXT    NOT NULL DEFAULT '',
        verdict             TEXT    NOT NULL,
        feedback            TEXT    NOT NULL DEFAULT '' CHECK (
            feedback LIKE 'MCP available: yes%' OR
            feedback LIKE 'MCP available: no — honor-system fallback%' OR
            feedback = ''
        ),
        subagent_session_id TEXT,
        repo                TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
        created_at          TEXT    NOT NULL,
        UNIQUE(task_id, attempt_n)
    );
  `);

  db.exec("INSERT INTO repos (name, path) VALUES ('plugin', '/tmp/plugin')");
  db.exec("INSERT INTO issues (id, objective, created_at, updated_at) VALUES (1, 'v25 seed', datetime('now'), datetime('now'))");
  const insTask = db.prepare(
    `INSERT INTO tasks (id, issue_id, branch_id, description, repo, created_at, updated_at)
     VALUES (?, 1, ?, 'seed task', 'plugin', datetime('now'), datetime('now'))`,
  );
  insTask.run(1, 'feat/seed-a');
  insTask.run(2, 'feat/seed-b');
  insTask.run(3, 'feat/seed-c');

  const ins = db.prepare(
    `INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, subagent_session_id, repo, created_at)
     VALUES (?, ?, 'pr-reviewer', ?, ?, ?, 'plugin', datetime('now'))`,
  );
  ins.run(1, 1, 'pass', 'MCP available: yes\nLGTM', 'sess-a');
  ins.run(2, 1, 'fail', 'MCP available: no — honor-system fallback\nMCP was down', 'sess-b');

  db.exec('UPDATE plugin_meta SET schema_version = 25 WHERE id = 1');
  db.close();
}

describe('schema upgrade — v25 -> v26 typed mcp_available (#157)', () => {
  it('rebuilds validation_attempts, backfilling mcp_available from the feedback prefix', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV25ValidationAttempts(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.equal(meta!.schema_version, 32, 'schema_version must be 32 after v25->v26');

    const cols = db.all<{ name: string }>('PRAGMA table_info(validation_attempts)');
    assert.ok(cols.some((c) => c.name === 'mcp_available'), 'mcp_available column must exist post-migration');

    const ddl = db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'validation_attempts'",
    );
    assert.ok(!/MCP available/.test(ddl!.sql), 'the feedback CHECK must be gone post-migration');

    const yesRow = db.get<{ mcp_available: number }>(
      'SELECT mcp_available FROM validation_attempts WHERE task_id = 1 AND attempt_n = 1',
    );
    assert.equal(yesRow!.mcp_available, 1, "an 'MCP available: yes' row backfills to 1");

    const noRow = db.get<{ mcp_available: number }>(
      'SELECT mcp_available FROM validation_attempts WHERE task_id = 2 AND attempt_n = 1',
    );
    assert.equal(noRow!.mcp_available, 0, "an 'MCP available: no' row backfills to 0");

    // Both FKs + the UNIQUE constraint survive the rebuild.
    const fks = db.all<{ from: string; table: string }>('PRAGMA foreign_key_list(validation_attempts)');
    assert.ok(fks.some((f) => f.from === 'task_id' && f.table === 'tasks'), 'task_id FK must survive');
    assert.ok(fks.some((f) => f.from === 'repo' && f.table === 'repos'), 'repo FK must survive');

    // Free-prose feedback that the old CHECK would have rejected now inserts cleanly.
    db.run(
      `INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, created_at)
       VALUES (3, 1, 'pr-reviewer', 'pass', 'arbitrary prose with no prefix', 1, datetime('now'))`,
    );
    const prose = db.get<{ feedback: string }>(
      'SELECT feedback FROM validation_attempts WHERE task_id = 3 AND attempt_n = 1',
    );
    assert.equal(prose!.feedback, 'arbitrary prose with no prefix', 'free-prose feedback must persist post-migration');

    db.close();
  });

  it('is idempotent — reopening at v26 does not re-rebuild or lose rows', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV25ValidationAttempts(dbPath);

    new TrajectoryDB(dbPath).close();
    const db = new TrajectoryDB(dbPath);

    const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM validation_attempts');
    assert.equal(count!.n, 2, 'the two seeded rows survive a second open');

    db.close();
  });
});

// v26 -> v27: the repos table becomes the SOLE source of truth for the four
// repo-scoped keys; they are removed from plugin_config (#980). Seed a v26-shaped
// DB by applying the current schema, then re-inserting the four legacy
// plugin_config keys, NULLing the repos policy columns, and stamping meta to 26,
// so opening with TrajectoryDB runs migrateV26toV27 against a real v26 table.
function seedV26PolicyKeys(dbPath: string): void {
  const schemaDir = dirname(fileURLToPath(import.meta.url));
  const schema = readFileSync(join(schemaDir, '..', 'schema.sql'), 'utf8');

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(schema);

  // A single registered repo whose policy columns are NULL — the migration must
  // drain the global keys into them before deleting.
  db.exec("INSERT INTO repos (name, path) VALUES ('plugin', '/tmp/plugin')");
  db.exec(
    "UPDATE repos SET target_branch = NULL, branching_model = NULL, protected_branches = NULL, remotes = NULL WHERE name = 'plugin'",
  );

  // Re-seed the four legacy global keys (deleted from schema.sql at v27).
  db.exec(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES
    ('pr_target',          '"dev"'),
    ('branching_model',    '"gitflow"'),
    ('protected_branches', '["main","dev"]'),
    ('remotes',            '[{"name":"origin","provider":"github","url":"https://github.com/x/plugin"}]'),
    ('issue_sync',         '"auto"')`);

  db.exec('UPDATE plugin_meta SET schema_version = 26 WHERE id = 1');
  db.close();
}

describe('schema upgrade — v26 -> v27 repos is sole source of truth (#980)', () => {
  it('drains the four global keys into repos, then deletes them from plugin_config', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV26PolicyKeys(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.equal(meta!.schema_version, 32, 'schema_version must be 32 after v26->v27');

    // The four keys are gone from plugin_config.
    for (const key of ['pr_target', 'branching_model', 'protected_branches', 'remotes']) {
      const row = db.get<{ value_json: string }>(
        'SELECT value_json FROM plugin_config WHERE key = ?',
        [key],
      );
      assert.equal(row, undefined, `plugin_config must not retain '${key}' after v27`);
    }

    // issue_sync (global) is untouched.
    const sync = db.get<{ value_json: string }>(
      "SELECT value_json FROM plugin_config WHERE key = 'issue_sync'",
    );
    assert.equal(sync!.value_json, '"auto"', 'issue_sync must survive in plugin_config');

    // repos row was drained from the global keys.
    const repo = db.get<{
      target_branch: string | null;
      branching_model: string | null;
      protected_branches: string | null;
      remotes: string | null;
    }>(
      'SELECT target_branch, branching_model, protected_branches, remotes FROM repos WHERE name = ?',
      ['plugin'],
    );
    assert.equal(repo!.target_branch, 'dev', 'target_branch drained from pr_target');
    assert.equal(repo!.branching_model, 'gitflow', 'branching_model drained from global');
    assert.equal(repo!.protected_branches, '["main","dev"]', 'protected_branches drained from global');
    assert.equal(
      repo!.remotes,
      '[{"name":"origin","provider":"github","url":"https://github.com/x/plugin"}]',
      'remotes drained from global',
    );

    db.close();
  });

  it('does not overwrite repos columns that already hold per-repo values', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV26PolicyKeys(dbPath);

    // Give the repo its own per-repo policy before the migration runs.
    const raw = new DatabaseSync(dbPath);
    raw.exec(
      "UPDATE repos SET target_branch = 'release', branching_model = 'github-flow' WHERE name = 'plugin'",
    );
    raw.close();

    const db = new TrajectoryDB(dbPath);

    const repo = db.get<{ target_branch: string | null; branching_model: string | null }>(
      'SELECT target_branch, branching_model FROM repos WHERE name = ?',
      ['plugin'],
    );
    assert.equal(repo!.target_branch, 'release', 'pre-existing target_branch must not be clobbered');
    assert.equal(repo!.branching_model, 'github-flow', 'pre-existing branching_model must not be clobbered');

    db.close();
  });

  it('is idempotent — reopening at v27 leaves plugin_config without the keys', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV26PolicyKeys(dbPath);

    new TrajectoryDB(dbPath).close();
    const db = new TrajectoryDB(dbPath);

    const remaining = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM plugin_config WHERE key IN ('pr_target','branching_model','protected_branches','remotes')",
    );
    assert.equal(remaining!.n, 0, 'the four keys stay deleted after a second open');

    db.close();
  });
});

// v27 -> v28: issues gains a nullable JSON-text `labels` column (#53) so
// issue_sync_retry replays the original validated label set. Seed a v27-shaped
// DB by applying the current schema, dropping the newly-added labels column, and
// stamping meta to 27, so opening with TrajectoryDB runs migrateV27toV28.
function seedV27NoLabels(dbPath: string): void {
  const schemaDir = dirname(fileURLToPath(import.meta.url));
  const schema = readFileSync(join(schemaDir, '..', 'schema.sql'), 'utf8');

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(schema);

  db.exec('ALTER TABLE issues DROP COLUMN labels');
  db.exec('UPDATE plugin_meta SET schema_version = 27 WHERE id = 1');
  db.close();
}

describe('schema upgrade — v27 -> v28 issues.labels column (#53)', () => {
  it('adds the nullable labels column and lands schema_version at 32', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV27NoLabels(dbPath);

    // Precondition: the seeded v27 table has no labels column.
    const pre = new DatabaseSync(dbPath);
    const preCols = (pre.prepare('PRAGMA table_info(issues)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    assert.ok(!preCols.includes('labels'), 'seed must not carry the labels column');
    pre.close();

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.equal(meta!.schema_version, 32, 'schema_version must be 32 after v27->v28');

    const cols = db.all<{ name: string }>('PRAGMA table_info(issues)').map((c) => c.name);
    assert.ok(cols.includes('labels'), 'v27->v28 must add issues.labels');

    // Nullable, no default: a fresh row reads NULL (the pre-v29 legacy marker).
    db.run(
      `INSERT INTO issues (objective, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ['post-upgrade', '', 'open', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
    );
    const row = db.get<{ labels: string | null }>(
      "SELECT labels FROM issues WHERE objective = 'post-upgrade'",
    );
    assert.equal(row!.labels, null, 'a new row defaults to NULL labels');

    db.close();
  });
});

// v28 -> v29: closed-enum CHECKs, dead-column drops, cursor-only pr_review_runs,
// hot-path indexes. Seeded from the frozen v28 schema.sql so the migration runs
// against the genuine v28 shape (remote_iid, attempts, agents.status, the
// pr_number=0 validation sentinels, the partial pr index).
function seedV28(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_V28_SQL);
  db.exec(`
    INSERT INTO repos (name, path) VALUES ('plugin', '/tmp/plugin');
    INSERT INTO milestones (name, repo, state) VALUES ('v1.0.3', 'plugin', 'open');
    INSERT INTO issues (id, objective, status, created_at, updated_at, remote_iid, remote_kind, gh_iid, repo, milestone)
      VALUES (5, 'legacy link', 'open', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 12, 'github', NULL, 'plugin', 'v1.0.3');
    INSERT INTO issues (id, objective, status, created_at, updated_at, remote_iid, remote_kind, gh_iid, repo)
      VALUES (6, 'dual link', 'closed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 7, 'github', 7, 'plugin');
    INSERT INTO issues (id, objective, created_at, updated_at) VALUES (9, 'deleted later', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    DELETE FROM issues WHERE id = 9;
    INSERT INTO tasks (id, issue_id, branch_id, description, status, attempts, repo, created_at, updated_at)
      VALUES (10, 5, 'fix/a', 'a', 'closed', 3, 'plugin', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO tasks (id, issue_id, branch_id, description, status, attempts, repo, created_at, updated_at)
      VALUES (11, 6, 'fix/b', 'b', 'running', 0, 'plugin', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, repo, created_at)
      VALUES (10, 1, 'pr-reviewer', 'fail', 'nope', 1, 'plugin', '2026-01-01T00:00:00.000Z');
    INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, repo, created_at)
      VALUES (10, 2, 'pr-reviewer', 'pass', 'ok', 0, 'plugin', '2026-01-02T00:00:00.000Z');
    INSERT INTO discussions (id, issue_id, author, kind, body, repo, created_at)
      VALUES (20, 5, 'bro', 'decision', 'pick the flamingo approach', 'plugin', '2026-01-01T00:00:00.000Z');
    INSERT INTO discussions (id, issue_id, author, kind, body, repo, created_at)
      VALUES (21, 5, 'bro', 'note', 'flamingo follow-up note', 'plugin', '2026-01-02T00:00:00.000Z');
    INSERT INTO discussions_embeddings (discussion_id, embedding, model_id, embedded_at)
      VALUES (20, x'00', 'm', '2026-01-01T00:00:00.000Z'), (21, x'01', 'm', '2026-01-01T00:00:00.000Z');
    INSERT INTO pr_review_runs (pr_number, repo, last_fetched_at, task_id, verdict, attempt_n)
      VALUES (0, 'plugin', '2026-01-01T00:00:00.000Z', 10, 'fail', 1), (0, 'plugin', '2026-01-02T00:00:00.000Z', 10, 'pass', 2);
    INSERT INTO pr_review_runs (pr_number, repo, last_fetched_at, last_comment_id, task_id)
      VALUES (42, 'owner/repo', '2026-01-03T00:00:00.000Z', 'c-9', 11);
    INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at) VALUES (11, 6, 'swe', '2026-01-03T00:00:00.000Z');
    INSERT INTO plugin_config (key, value_json) VALUES ('tmb_default_repo', '"plugin"');
  `);
  db.close();
}

describe('schema upgrade — v28 -> v29 constraints, drops, cursor-only pr_review_runs', () => {
  it('applies every v29 DDL item and preserves the data', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV28(dbPath);

    const db = new TrajectoryDB(dbPath);
    assertV29Shape(db);

    assert.equal(
      readdirSync(tmpDir).filter((f) => f.includes('.pre-v32.') && f.endsWith('.bak')).length,
      1,
      'exactly one pre-v32 backup must exist',
    );

    const legacy = db.get<{ gh_iid: number | null; remote_kind: string; milestone: string }>(
      'SELECT gh_iid, remote_kind, milestone FROM issues WHERE id = 5',
    );
    assert.equal(legacy!.gh_iid, 12, 'a remote_iid-only github link backfills into gh_iid');
    assert.equal(legacy!.milestone, 'v1.0.3', 'issue milestone survives the rebuild');
    assert.equal(db.get<{ gh_iid: number }>('SELECT gh_iid FROM issues WHERE id = 6')!.gh_iid, 7);

    db.run(
      `INSERT INTO issues (objective, created_at, updated_at) VALUES ('after upgrade', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`,
    );
    const next = db.get<{ id: number }>("SELECT id FROM issues WHERE objective = 'after upgrade'");
    assert.equal(next!.id, 10, 'the AUTOINCREMENT high-water mark survives — deleted ids are not reused');

    const tasks = db.all<{ id: number; status: string }>('SELECT id, status FROM tasks ORDER BY id').map((r) => ({ ...r }));
    assert.deepEqual(tasks, [{ id: 10, status: 'closed' }, { id: 11, status: 'running' }]);

    const va = db.all<{ verdict: string; mcp_available: number }>(
      'SELECT verdict, mcp_available FROM validation_attempts ORDER BY attempt_n',
    ).map((r) => ({ ...r }));
    assert.deepEqual(va, [{ verdict: 'fail', mcp_available: 1 }, { verdict: 'pass', mcp_available: 0 }]);

    const runs = db.all<{ pr_number: number; repo: string; last_comment_id: string; task_id: number }>(
      'SELECT pr_number, repo, last_comment_id, task_id FROM pr_review_runs',
    ).map((r) => ({ ...r }));
    assert.deepEqual(
      runs,
      [{ pr_number: 42, repo: 'owner/repo', last_comment_id: 'c-9', task_id: 11 }],
      'the pr_number=0 sentinels are gone; the real cursor row survives',
    );

    const hits = db.all<{ rowid: number }>(
      "SELECT rowid FROM discussions_fts WHERE discussions_fts MATCH 'flamingo' ORDER BY rowid",
    );
    assert.deepEqual(hits.map((h) => h.rowid), [20, 21], 'FTS search returns the rebuilt rows');
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM discussions_embeddings')!.n, 2, 'embeddings unchanged');

    db.run(
      `INSERT INTO discussions (issue_id, author, kind, body, created_at) VALUES (5, 'bro', 'note', 'pelican', '2026-02-01T00:00:00.000Z')`,
    );
    assert.equal(
      db.all("SELECT rowid FROM discussions_fts WHERE discussions_fts MATCH 'pelican'").length,
      1,
      'the recreated insert trigger keeps FTS in sync',
    );

    const fk = db.all('PRAGMA foreign_key_check');
    assert.equal(fk.length, 0, 'foreign_key_check must be clean');
    assert.equal(db.get<{ integrity_check: string }>('PRAGMA integrity_check')!.integrity_check, 'ok');

    db.close();
  });

  it('is idempotent — reopening at v29 does not rebuild, re-backup or lose rows', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV28(dbPath);

    new TrajectoryDB(dbPath).close();
    const db = new TrajectoryDB(dbPath);
    assertV29Shape(db);
    assert.equal(
      readdirSync(tmpDir).filter((f) => f.includes('.pre-v32.') && f.endsWith('.bak')).length,
      1,
      'reopening at v29 must not create another backup',
    );
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM issues')!.n, 3);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM discussions')!.n, 2);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pr_review_runs')!.n, 1);
    db.close();
  });

  it('aborts with one error naming every row that would violate a new constraint', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV28(dbPath);
    const raw = new DatabaseSync(dbPath);
    raw.exec("UPDATE tasks SET status = 'in_progress' WHERE id = 11");
    raw.exec("UPDATE discussions SET kind = 'rant' WHERE id = 21");
    raw.close();

    assert.throws(
      () => new TrajectoryDB(dbPath),
      (e: Error) =>
        /migrateV28toV29/.test(e.message) &&
        e.message.includes('tasks.status = "in_progress"') &&
        e.message.includes('discussions.kind = "rant"'),
    );

    const after = new DatabaseSync(dbPath);
    const meta = after.prepare('SELECT schema_version FROM plugin_meta').get() as { schema_version: number };
    assert.equal(meta.schema_version, 28, 'a failed migration leaves the DB at v28');
    const cols = (after.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(cols.includes('attempts'), 'the rollback leaves the v28 tasks shape intact');
    const sentinels = after.prepare('SELECT COUNT(*) AS n FROM pr_review_runs WHERE pr_number = 0').get() as { n: number };
    assert.equal(sentinels.n, 2, 'the sentinel delete rolls back with the failed migration');
    after.close();
  });
});

// v29 -> v30: agent_runs metering columns, discussions.remote_comment_id, one
// timestamp format. Seeded from the frozen v29 schema.sql so the migration runs
// against the genuine v29 shape (NOT NULL DEFAULT 0 token columns, the
// datetime('now') DEFAULTs, hook-written 19/20-char stamps).
function seedV29(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_V29_SQL);
  db.exec(`
    INSERT INTO repos (name, path, last_scanned_at) VALUES ('plugin', '/tmp/plugin', '2026-01-01 09:00:00');
    INSERT INTO issues (id, objective, status, created_at, updated_at, closed_at, repo)
      VALUES (5, 'metering', 'open', '2026-01-01 10:00:00', '2026-01-01T10:00:00Z', NULL, 'plugin');
    INSERT INTO tasks (id, issue_id, branch_id, description, status, repo, created_at, updated_at, completed_at)
      VALUES (10, 5, 'fix/a', 'a', 'closed', 'plugin', '2026-01-01T10:00:00.123Z', '2026-01-01T10:00:00.123Z', '2026-01-02 08:00:00');
    INSERT INTO tasks (id, issue_id, branch_id, description, status, repo, created_at, updated_at)
      VALUES (11, 5, 'fix/b', 'b', 'running', 'plugin', '2026-01-01T10:00:00.123Z', '2026-01-01T10:00:00.123Z');
    INSERT INTO agent_runs (id, task_id, issue_id, agent_type, started_at, completed_at, usage_baseline_json)
      VALUES (1, 10, 5, 'bro', '2026-01-01T10:00:00.000Z', '2026-01-02 08:00:00', '{"spawn_id":"s-zero"}');
    INSERT INTO agent_runs (id, task_id, issue_id, agent_type, tokens_in, tokens_out, tokens_total, cache_read_tokens, cache_creation_tokens, started_at, completed_at)
      VALUES (2, 10, 5, 'bro', 100, 50, 150, 1000, 20, '2026-01-01T10:00:00.000Z', '2026-01-02T08:00:00.000Z');
    INSERT INTO agent_runs (id, task_id, issue_id, agent_type, tokens_in, tokens_out, tokens_total, cache_read_tokens, cache_creation_tokens, tool_uses, duration_ms, completed_at, usage_baseline_json)
      VALUES (3, 10, 5, 'swe', 7, 9, 16, 0, 0, 4, 900, '2026-01-02 07:00:00', '{"spawn_id":"s-3"}');
    INSERT INTO agent_runs (id, task_id, issue_id, agent_type, started_at, usage_baseline_json)
      VALUES (4, 11, 5, 'bro', '2026-01-03T00:00:00.000Z', '{"baseline":1}');
    INSERT INTO discussions (id, issue_id, author, kind, body, created_at)
      VALUES (20, 5, 'bro', 'decision', 'pick the heron approach', '2026-01-01 10:00:00');
    INSERT INTO discussions_embeddings (discussion_id, embedding, model_id, embedded_at)
      VALUES (20, x'00', 'm', '2026-01-01 10:00:00');
    INSERT INTO audit (id, issue_id, event_type, summary, created_at)
      VALUES (31, 5, 'e', 'nineteen-char stamp', '2026-01-01 10:00:00'),
             (32, 5, 'e', 'twenty-char stamp', '2026-01-01T10:00:01Z'),
             (33, 5, 'e', 'ms stamp late in the second', '2026-01-01T10:00:01.500Z'),
             (34, 5, 'e', 'ms stamp early in the second', '2026-01-01T10:00:00.250Z'),
             (35, 5, 'e', 'microsecond stamp', '2026-01-01T10:00:02.123456Z'),
             (36, 5, 'e', 'date-only stamp', '2026-01-02');
    INSERT INTO pr_review_runs (pr_number, repo, last_fetched_at, task_id) VALUES (42, 'owner/repo', '2026-01-03T00:00:00Z', 11);
    INSERT INTO cheatcodes (id, name, kind, origin, source_url, scope, status, installed_at)
      VALUES (100, 'pdf', 'plugin', 'marketplace', 'pdf@x', 'project-local', 'installed', '2026-01-04 00:00:00');
    INSERT INTO cheatcode_attachments (cheatcode_id, target, artifact, created_at)
      VALUES (100, 'plugin', 'pdf@x', '2026-01-04 00:00:00');
  `);
  db.close();
}

describe('schema upgrade — v29 -> v30 metering columns, remote_comment_id, one timestamp format', () => {
  it('applies every v30 DDL item, backfills usage_source and normalizes timestamps', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV29(dbPath);

    const db = new TrajectoryDB(dbPath);
    assertV32Shape(db);
    assertTimestampsIso(db);
    assert.equal(
      readdirSync(tmpDir).filter((f) => f.includes('.pre-v32.') && f.endsWith('.bak')).length,
      1,
      'exactly one pre-v32 backup must exist',
    );

    const runs = db
      .all<Record<string, unknown>>(
        'SELECT id, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, usage_source, completed_at, spawn_id, session_id FROM agent_runs ORDER BY id',
      )
      .map((r) => ({ ...r }));
    assert.deepEqual(runs, [
      {
        id: 1, tokens_in: null, tokens_out: null, cache_read_tokens: null, cache_creation_tokens: null,
        usage_source: 'unmeasured', completed_at: '2026-01-02T08:00:00.000Z',
        spawn_id: null, session_id: null,
      },
      {
        id: 2, tokens_in: 100, tokens_out: 50, cache_read_tokens: 1000, cache_creation_tokens: 20,
        usage_source: 'transcript', completed_at: '2026-01-02T08:00:00.000Z',
        spawn_id: null, session_id: null,
      },
      {
        id: 3, tokens_in: 7, tokens_out: 9, cache_read_tokens: 0, cache_creation_tokens: 0,
        usage_source: 'subagent_stop', completed_at: '2026-01-02T07:00:00.000Z',
        spawn_id: null, session_id: null,
      },
      {
        id: 4, tokens_in: 0, tokens_out: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
        usage_source: null, completed_at: null,
        spawn_id: null, session_id: null,
      },
    ], 'all-zero closed → NULL + unmeasured; measured bro → transcript; swe → subagent_stop; open row untouched');

    const issue = db.get<{ created_at: string; updated_at: string }>('SELECT created_at, updated_at FROM issues WHERE id = 5');
    assert.deepEqual({ ...issue }, { created_at: '2026-01-01T10:00:00.000Z', updated_at: '2026-01-01T10:00:00.000Z' });
    assert.equal(
      db.get<{ created_at: string }>('SELECT created_at FROM tasks WHERE id = 10')!.created_at,
      '2026-01-01T10:00:00.123Z',
      'an ms-ISO stamp is left untouched',
    );

    const ordered = db.all<{ id: number; created_at: string }>(
      'SELECT id, created_at FROM audit WHERE id BETWEEN 31 AND 34 ORDER BY created_at, id',
    ).map((r) => ({ ...r }));
    assert.deepEqual(ordered, [
      { id: 31, created_at: '2026-01-01T10:00:00.000Z' },
      { id: 34, created_at: '2026-01-01T10:00:00.250Z' },
      { id: 32, created_at: '2026-01-01T10:00:01.000Z' },
      { id: 33, created_at: '2026-01-01T10:00:01.500Z' },
    ], 'normalized 19/20-char stamps sort correctly against ms-ISO stamps of the same second');
    const odd = db.all<{ id: number; created_at: string }>(
      'SELECT id, created_at FROM audit WHERE id IN (35, 36) ORDER BY id',
    ).map((r) => ({ ...r }));
    assert.deepEqual(odd, [
      { id: 35, created_at: '2026-01-01T10:00:02.123Z' },
      { id: 36, created_at: '2026-01-02T00:00:00.000Z' },
    ], 'parseable microsecond and date-only stamps normalize to 24 chars instead of aborting');
    assert.equal(
      db.all("SELECT rowid FROM audit_fts WHERE audit_fts MATCH 'nineteen'").length,
      1,
      'the audit UPDATE keeps audit_fts in sync',
    );

    const cheatcode = db.get<{ id: number; installed_at: string }>("SELECT id, installed_at FROM cheatcodes WHERE name = 'pdf'");
    assert.deepEqual({ ...cheatcode }, { id: 100, installed_at: '2026-01-04T00:00:00.000Z' }, 'cheatcode ids survive the rebuild');
    assert.equal(
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cheatcode_attachments WHERE cheatcode_id = 100')!.n,
      1,
      'cheatcode_attachments rows survive the cheatcodes rebuild',
    );
    db.run("DELETE FROM cheatcodes WHERE id = 100");
    assert.equal(
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cheatcode_attachments')!.n,
      0,
      'the ON DELETE CASCADE FK still points at the rebuilt cheatcodes table',
    );
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM discussions_embeddings')!.n, 1, 'embeddings unchanged');

    const now = new Date().toISOString();
    const insertRemote = (remote: string | null): void => {
      db.run(
        `INSERT INTO discussions (issue_id, author, kind, body, created_at, remote_comment_id) VALUES (5, 'bro', 'note', 'n', ?, ?)`,
        [now, remote],
      );
    };
    insertRemote(null);
    insertRemote(null);
    insertRemote('gh-7');
    assert.throws(() => insertRemote('gh-7'), /UNIQUE/, 'remote_comment_id is unique when non-NULL');

    db.run(`INSERT INTO agent_runs (task_id, agent_type, spawn_id, session_id) VALUES (11, 'swe', 'sp-1', 'sess-1')`);
    assert.throws(
      () => db.run(`INSERT INTO agent_runs (task_id, agent_type, spawn_id) VALUES (11, 'swe', 'sp-1')`),
      /UNIQUE/,
      'one agent_runs row per (task_id, spawn_id)',
    );

    assert.equal(db.all('PRAGMA foreign_key_check').length, 0, 'foreign_key_check must be clean');
    assert.equal(db.get<{ integrity_check: string }>('PRAGMA integrity_check')!.integrity_check, 'ok');
    db.close();
  });

  it('is idempotent — reopening at the current version does not rebuild, re-backup or change rows', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV29(dbPath);

    const first = new TrajectoryDB(dbPath);
    const snapshot = (db: TrajectoryDB): unknown[] =>
      db.all('SELECT * FROM agent_runs ORDER BY id').map((r) => ({ ...(r as object) }));
    const before = snapshot(first);
    first.close();

    const db = new TrajectoryDB(dbPath);
    assertV32Shape(db);
    assertTimestampsIso(db);
    assert.deepEqual(snapshot(db), before, 'agent_runs rows are unchanged by a reopen');
    assert.equal(
      readdirSync(tmpDir).filter((f) => f.includes('.pre-v32.') && f.endsWith('.bak')).length,
      1,
      'reopening at the current version must not create another backup',
    );
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit WHERE id BETWEEN 31 AND 36')!.n, 6);
    db.close();
  });

  it('aborts and leaves the DB at v29 when a timestamp cannot be normalized', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV29(dbPath);
    const raw = new DatabaseSync(dbPath);
    raw.exec("UPDATE audit SET created_at = 'yesterday' WHERE id = 32");
    raw.close();

    assert.throws(
      () => new TrajectoryDB(dbPath),
      (e: Error) => /migrateV29toV30/.test(e.message) && e.message.includes('audit.created_at = "yesterday"'),
    );

    const after = new DatabaseSync(dbPath);
    const meta = after.prepare('SELECT schema_version FROM plugin_meta').get() as { schema_version: number };
    assert.equal(meta.schema_version, 29, 'a failed migration leaves the DB at v29');
    const cols = (after.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(!cols.includes('usage_source'), 'the rollback leaves the v29 agent_runs shape intact');
    const stamp = after.prepare('SELECT created_at FROM audit WHERE id = 31').get() as { created_at: string };
    assert.equal(stamp.created_at, '2026-01-01 10:00:00', 'the normalization rolls back with the failed migration');
    after.close();
  });
});

// v30 -> v31: agent_runs drops tokens_total and usage_baseline_json. Seeded
// from the frozen v30 schema.sql so the migration runs against the genuine v30
// shape.
function seedV30(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_V30_SQL);
  db.exec(`
    INSERT INTO repos (name, path) VALUES ('plugin', '/tmp/plugin');
    INSERT INTO issues (id, objective, status, created_at, updated_at, repo)
      VALUES (5, 'metering', 'open', '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z', 'plugin');
    INSERT INTO tasks (id, issue_id, branch_id, description, status, repo, created_at, updated_at)
      VALUES (10, 5, 'fix/a', 'a', 'running', 'plugin', '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z');
    INSERT INTO agent_runs (id, task_id, issue_id, agent_type, tokens_in, tokens_out, tokens_total, cache_read_tokens,
                            cache_creation_tokens, tool_uses, duration_ms, started_at, completed_at, usage_baseline_json,
                            repo, spawn_id, session_id, usage_source)
      VALUES (1, 10, 5, 'bro', 100, 50, 150, 1000, 20, 3, 500, '2026-01-01T10:00:00.000Z', '2026-01-01T11:00:00.000Z',
              '{"ti":1}', 'plugin', NULL, 'sess-1', 'transcript'),
             (2, 10, 5, 'swe', 7, 9, 16, 0, 0, 4, 900, '2026-01-01T10:05:00.000Z', '2026-01-01T10:20:00.000Z',
              '{"spawn_id":"s-2"}', 'plugin', 's-2', NULL, 'subagent_stop'),
             (7, 10, 5, 'bro', NULL, NULL, 0, NULL, NULL, 0, 0, '2026-01-01T12:00:00.000Z', NULL, NULL, 'plugin', NULL, NULL, NULL);
    DELETE FROM agent_runs WHERE id = 7;
    INSERT INTO agent_runs (id, task_id, issue_id, agent_type, started_at) VALUES (3, 10, 5, 'bro', '2026-01-01T12:00:00.000Z');
  `);
  db.close();
}

describe('schema upgrade — v30 -> v31 drops agent_runs.tokens_total and usage_baseline_json', () => {
  it('drops both columns and keeps every row, id and the AUTOINCREMENT high-water mark', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV30(dbPath);

    const db = new TrajectoryDB(dbPath);
    assertV32Shape(db);
    assert.equal(
      readdirSync(tmpDir).filter((f) => f.includes('.pre-v32.') && f.endsWith('.bak')).length,
      1,
      'exactly one pre-v32 backup must exist',
    );
    const runs = db
      .all<Record<string, unknown>>(
        'SELECT id, agent_type, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, tool_uses, duration_ms, started_at, completed_at, repo, spawn_id, session_id, usage_source FROM agent_runs ORDER BY id',
      )
      .map((r) => ({ ...r }));
    assert.deepEqual(runs, [
      {
        id: 1, agent_type: 'bro', tokens_in: 100, tokens_out: 50, cache_read_tokens: 1000, cache_creation_tokens: 20,
        tool_uses: 3, duration_ms: 500, started_at: '2026-01-01T10:00:00.000Z', completed_at: '2026-01-01T11:00:00.000Z',
        repo: 'plugin', spawn_id: null, session_id: 'sess-1', usage_source: 'transcript',
      },
      {
        id: 2, agent_type: 'swe', tokens_in: 7, tokens_out: 9, cache_read_tokens: 0, cache_creation_tokens: 0,
        tool_uses: 4, duration_ms: 900, started_at: '2026-01-01T10:05:00.000Z', completed_at: '2026-01-01T10:20:00.000Z',
        repo: 'plugin', spawn_id: 's-2', session_id: null, usage_source: 'subagent_stop',
      },
      {
        id: 3, agent_type: 'bro', tokens_in: null, tokens_out: null, cache_read_tokens: null, cache_creation_tokens: null,
        tool_uses: 0, duration_ms: 0, started_at: '2026-01-01T12:00:00.000Z', completed_at: null,
        repo: null, spawn_id: null, session_id: null, usage_source: null,
      },
    ]);
    db.run(`INSERT INTO agent_runs (task_id, agent_type) VALUES (10, 'swe')`);
    assert.equal(
      db.get<{ id: number }>('SELECT MAX(id) AS id FROM agent_runs')!.id,
      8,
      'AUTOINCREMENT continues past the deleted id 7',
    );
    assert.throws(
      () => db.run(`INSERT INTO agent_runs (task_id, agent_type, spawn_id) VALUES (10, 'swe', 's-2')`),
      /UNIQUE/,
      'the (task_id, spawn_id) partial unique index survives the rebuild',
    );
    assert.equal(db.all('PRAGMA foreign_key_check').length, 0, 'foreign_key_check must be clean');
    assert.equal(db.get<{ integrity_check: string }>('PRAGMA integrity_check')!.integrity_check, 'ok');
    db.close();
  });

  it('is idempotent — reopening at the current version does not rebuild, re-backup or change rows', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV30(dbPath);

    const first = new TrajectoryDB(dbPath);
    const snapshot = (db: TrajectoryDB): unknown[] =>
      db.all('SELECT * FROM agent_runs ORDER BY id').map((r) => ({ ...(r as object) }));
    const before = snapshot(first);
    first.close();

    const db = new TrajectoryDB(dbPath);
    assertV32Shape(db);
    assert.deepEqual(snapshot(db), before, 'agent_runs rows are unchanged by a reopen');
    assert.equal(
      readdirSync(tmpDir).filter((f) => f.includes('.pre-v32.') && f.endsWith('.bak')).length,
      1,
      'reopening at the current version must not create another backup',
    );
    db.close();
  });
});

// v31 -> v32: cheatcodes keyed by (name, kind), phantom scan_discovered repair,
// broken bundled-server reset, mcp:<server> -> mcp:<plugin>/<server>. Seeded
// from the frozen v31 schema.sql so the migration runs against the genuine v31
// shape.
function seedV31(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_V31_SQL);
  db.exec(`
    INSERT INTO cheatcodes (id, name, kind, origin, source_url, scope, status, installed_at) VALUES
      (101, 'linear',            'plugin', 'marketplace', 'linear@claude-plugins-official', 'project-local', 'active', '2026-01-01T10:00:00.000Z'),
      (102, 'tmb',               'plugin', 'marketplace', 'tmb@trustmybot-dev',             'project-local', 'active', '2026-01-01T10:00:00.000Z'),
      (103, 'trajectory-server', 'mcp',    'marketplace', 'mcp:trajectory-server',          'project-local', 'broken', '2026-01-01T10:00:00.000Z'),
      (104, 'orphan-srv',        'mcp',    'marketplace', 'mcp:orphan-srv',                 'project-local', 'broken', '2026-01-01T10:00:00.000Z'),
      (105, 'user-srv',          'mcp',    'external',    'mcp:user-srv',                   'project-local', 'active', '2026-01-01T10:00:00.000Z');
    INSERT INTO cheatcode_attachments (cheatcode_id, target, artifact, created_at)
      VALUES (101, 'plugin', 'linear@claude-plugins-official', '2026-01-01T10:00:00.000Z');
    INSERT INTO audit (id, issue_id, from_node, event_type, summary, content_json, created_at) VALUES
      (10, -1, 'hook:scan', 'scan_discovered', 'linear (mcp): discovered', '{"name":"linear","kind":"mcp"}', '2026-01-01T10:00:00.000Z'),
      (11, -1, 'hook:scan', 'scan_discovered', 'linear (mcp): discovered', '{"name":"linear","kind":"mcp"}', '2026-01-01T10:01:00.000Z'),
      (12, -1, 'hook:scan', 'scan_discovered', 'linear (mcp): discovered', '{"name":"linear","kind":"mcp"}', '2026-01-01T10:02:00.000Z'),
      (13, -1, 'hook:scan', 'scan_discovered', 'linear (plugin): discovered', '{"name":"linear","kind":"plugin"}', '2026-01-01T10:03:00.000Z'),
      (14, -1, 'hook:scan', 'scan_discovered', 'trajectory-server (mcp): discovered', '{"name":"trajectory-server","kind":"mcp"}', '2026-01-01T10:04:00.000Z'),
      (15, -1, 'bro',       'decision',        'linear (mcp) noted', '{"name":"linear","kind":"mcp"}', '2026-01-01T10:05:00.000Z'),
      (16, -1, 'hook:scan', 'scan_discovered', 'unparseable', 'not json', '2026-01-01T10:06:00.000Z');
    INSERT INTO audit_embeddings (audit_id, embedding, model_id, embedded_at) VALUES
      (10, x'00', 'm', '2026-01-01T10:00:00.000Z'),
      (13, x'00', 'm', '2026-01-01T10:00:00.000Z');
  `);
  db.close();
}

// The migration resolves this plugin's own name from CLAUDE_PLUGIN_ROOT; pin
// it to the unset fallback ('tmb') for a deterministic rename.
function openWithoutPluginRoot(dbPath: string): TrajectoryDB {
  const saved = process.env['CLAUDE_PLUGIN_ROOT'];
  delete process.env['CLAUDE_PLUGIN_ROOT'];
  try {
    return new TrajectoryDB(dbPath);
  } finally {
    if (saved !== undefined) process.env['CLAUDE_PLUGIN_ROOT'] = saved;
  }
}

describe('schema upgrade — v31 -> v32 cheatcodes keyed by (name, kind), phantom scan_discovered repair', () => {
  it('rebuilds cheatcodes on (name, kind): a plugin and its same-named server coexist, a duplicate is rejected', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV31(dbPath);

    const db = openWithoutPluginRoot(dbPath);
    assertV32Shape(db);
    assert.equal(
      readdirSync(tmpDir).filter((f) => f.includes('.pre-v32.') && f.endsWith('.bak')).length,
      1,
      'exactly one pre-v32 backup must exist',
    );
    db.run(
      `INSERT INTO cheatcodes (name, kind, origin, source_url, status, installed_at)
       VALUES ('linear', 'mcp', 'marketplace', 'mcp:linear/linear', 'active', '2026-01-02T00:00:00.000Z')`,
    );
    assert.throws(
      () =>
        db.run(
          `INSERT INTO cheatcodes (name, kind, origin, source_url, status, installed_at)
           VALUES ('linear', 'mcp', 'external', 'mcp:linear', 'active', '2026-01-02T00:00:00.000Z')`,
        ),
      /UNIQUE/,
      'a third linear row of kind mcp must be rejected',
    );
    assert.equal(
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM cheatcodes WHERE name = 'linear'")!.n,
      2,
      'linear/plugin and linear/mcp coexist',
    );
    assert.deepEqual(
      db.all<{ cheatcode_id: number }>('SELECT cheatcode_id FROM cheatcode_attachments').map((r) => r.cheatcode_id),
      [101],
      'cheatcode_attachments rows survive the rebuild with their ids',
    );
    assert.equal(db.all('PRAGMA foreign_key_check').length, 0, 'foreign_key_check must be clean');
    assert.equal(db.get<{ integrity_check: string }>('PRAGMA integrity_check')!.integrity_check, 'ok');
    db.close();
  });

  it('deletes exactly the phantom scan_discovered rows with their FTS and embeddings entries and records the count', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV31(dbPath);

    const db = openWithoutPluginRoot(dbPath);
    const kept = db
      .all<{ id: number }>("SELECT id FROM audit WHERE event_type <> 'scan_discovered_repair' AND id BETWEEN 10 AND 16 ORDER BY id")
      .map((r) => r.id);
    assert.deepEqual(kept, [13, 14, 15, 16], 'only the three linear (mcp) phantoms are deleted');

    const repair = db.all<{ issue_id: number; from_node: string; content_json: string }>(
      "SELECT issue_id, from_node, content_json FROM audit WHERE event_type = 'scan_discovered_repair'",
    );
    assert.equal(repair.length, 1, 'one scan_discovered_repair row');
    assert.equal(repair[0].issue_id, -1);
    assert.equal(repair[0].from_node, 'system');
    assert.deepEqual(JSON.parse(repair[0].content_json), { deleted: 3 });

    assert.deepEqual(
      db.all<{ audit_id: number }>('SELECT audit_id FROM audit_embeddings ORDER BY audit_id').map((r) => r.audit_id),
      [13],
      'the phantom rows lose their embeddings',
    );
    const ftsIds = db
      .all<{ rowid: number }>("SELECT rowid FROM audit_fts WHERE audit_fts MATCH 'linear' ORDER BY rowid")
      .map((r) => r.rowid);
    assert.deepEqual(ftsIds, [13, 15], 'audit_fts no longer indexes the phantom rows');
    db.run("INSERT INTO audit_fts(audit_fts) VALUES ('integrity-check')");
    assert.equal(
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_fts_docsize')!.n,
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit')!.n,
      'audit_fts holds one entry per audit row',
    );
    db.close();
  });

  it('resets broken mcp: rows to installed and renames mcp:<server> when the parent plugin row exists', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV31(dbPath);

    const db = openWithoutPluginRoot(dbPath);
    const rows = db
      .all<Record<string, unknown>>(
        "SELECT name, source_url, status FROM cheatcodes WHERE kind = 'mcp' ORDER BY id",
      )
      .map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { name: 'trajectory-server', source_url: 'mcp:tmb/trajectory-server', status: 'installed' },
      { name: 'orphan-srv', source_url: 'mcp:orphan-srv', status: 'installed' },
      { name: 'user-srv', source_url: 'mcp:user-srv', status: 'active' },
    ]);
    db.close();
  });

  it('is idempotent — reopening at the current version does not rebuild, re-backup or change rows', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV31(dbPath);

    const snapshot = (db: TrajectoryDB): unknown[] => [
      ...db.all('SELECT * FROM cheatcodes ORDER BY id').map((r) => ({ ...(r as object) })),
      ...db.all('SELECT * FROM audit ORDER BY id').map((r) => ({ ...(r as object) })),
    ];
    const first = openWithoutPluginRoot(dbPath);
    const before = snapshot(first);
    first.close();

    const db = openWithoutPluginRoot(dbPath);
    assertV32Shape(db);
    assert.deepEqual(snapshot(db), before, 'cheatcodes and audit rows are unchanged by a reopen');
    assert.equal(
      readdirSync(tmpDir).filter((f) => f.includes('.pre-v32.') && f.endsWith('.bak')).length,
      1,
      'reopening at the current version must not create another backup',
    );
    db.close();
  });
});

function assertSchemaParity(migrated: TrajectoryDB, fresh: TrajectoryDB): void {
  const tables = (db: TrajectoryDB): string[] =>
    db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name",
      )
      .map((r) => r.name);
  assert.deepEqual(tables(migrated), tables(fresh), 'table sets must match');

  for (const table of tables(fresh)) {
    assert.deepEqual(
      migrated.all(`PRAGMA table_info(${table})`),
      fresh.all(`PRAGMA table_info(${table})`),
      `PRAGMA table_info(${table}) must match`,
    );
    assert.deepEqual(
      migrated.all(`PRAGMA foreign_key_list(${table})`),
      fresh.all(`PRAGMA foreign_key_list(${table})`),
      `PRAGMA foreign_key_list(${table}) must match`,
    );
  }

  assert.deepEqual(indexNames(migrated), indexNames(fresh), 'index name sets must match');

  const triggers = (db: TrajectoryDB): string[] =>
    db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").map((r) => r.name);
  assert.deepEqual(triggers(migrated), triggers(fresh), 'trigger sets must match');

  const indexSql = (db: TrajectoryDB): Array<{ name: string; sql: string }> =>
    db
      .all<{ name: string; sql: string }>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
      )
      .map((r) => ({ name: r.name, sql: r.sql.replace(/\s+/g, ' ').trim() }));
  assert.deepEqual(indexSql(migrated), indexSql(fresh), 'index definitions must match');
}

describe('schema parity — a migrated DB matches a fresh v32 DB', () => {
  for (const [label, seed] of [
    ['v28', seedV28],
    ['v29', seedV29],
    ['v30', seedV30],
    ['v31', seedV31],
  ] as const) {
    it(`a migrated ${label} DB has identical table columns, foreign keys, index names and triggers`, () => {
      const tmpDir = makeTmpDir();
      const migratedPath = join(tmpDir, 'migrated.db');
      seed(migratedPath);
      const migrated = new TrajectoryDB(migratedPath);
      const fresh = new TrajectoryDB(join(tmpDir, 'fresh.db'));

      assertSchemaParity(migrated, fresh);
      assertV32Shape(migrated);
      assertV32Shape(fresh);

      migrated.close();
      fresh.close();
    });
  }
});
