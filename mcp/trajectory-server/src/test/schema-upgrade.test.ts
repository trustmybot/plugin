import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { TrajectoryDB } from '../db.js';

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
      `INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'legacy issue', '', 'open', '2026-01-01', '2026-01-01')`,
    );
    seed.exec(
      `INSERT INTO tasks (id, issue_id, branch_id, title, description, status, attempts, spec_body, success_criteria, created_at, updated_at) VALUES (1, 1, 'feat/legacy', '', 'legacy desc', 'pending', 0, '', 'done', '2026-01-01', '2026-01-01')`,
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
    assert.equal(meta.schema_version, 23);

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
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one backup file must exist');

    db.run(
      `INSERT INTO tasks (issue_id, branch_id, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [1, 'feat/test-round-trip', 'desc', 'pending', '2026-01-01', '2026-01-01'],
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
    assert.equal(meta.schema_version, 23);

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'backup must exist for rc-current upgrade');

    db.run(
      `INSERT INTO issues (objective, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ['post-upgrade', '', 'open', '2026-01-01', '2026-01-01'],
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
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
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
      `INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (42, 'wal-pending', '', 'open', '2026-01-01', '2026-01-01')`,
    );
    // Hold the connection open so the WAL doesn't drain on close.
    // The TrajectoryDB opens a separate connection — SQLite's WAL
    // arbitration plus busy_timeout handle the overlap.

    const db = new TrajectoryDB(dbPath);

    const backupFile = readdirSync(dirname(dbPath)).find(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
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
    assert.equal(meta.schema_version, 23, 'schema_version must be 23 after migration');

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
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one pre-v23 backup must exist');

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
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v4 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
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
    assert.equal(meta.schema_version, 23, 'schema_version must be 23 after v4->v5 migration');

    const cols = db.all<{ name: string }>('PRAGMA table_info(issues)').map((c) => c.name);
    assert.ok(cols.includes('gh_iid'), 'gh_iid column must exist after migration');
    assert.ok(cols.includes('gl_iid'), 'gl_iid column must exist after migration');
    assert.ok(cols.includes('remote_iid'), 'remote_iid must still exist (back-compat)');
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
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v5 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
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
    assert.equal(meta?.schema_version, 23, 'fresh DB schema_version must be 23');

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
    assert.equal(meta.schema_version, 23, 'schema_version must be 23 after migration');

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
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one pre-v23 backup must exist');

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
    assert.equal(meta.schema_version, 23, 'v2 DB must reach v23 via chained migrations');

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
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v4 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
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
    assert.equal(meta.schema_version, 23, 'schema_version must be 23 after migration');

    const cols = db.all<{ name: string }>('PRAGMA table_info(agent_runs)').map((c) => c.name);
    assert.ok(cols.includes('cache_read_tokens'), 'cache_read_tokens must exist after v9 migration');
    assert.ok(cols.includes('cache_creation_tokens'), 'cache_creation_tokens must exist after v9 migration');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one pre-v23 backup must exist');

    db.close();
  });

  it('v8 DB upgrades to v9 with pr_review_runs audit columns added', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV8Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const cols = db.all<{ name: string }>('PRAGMA table_info(pr_review_runs)').map((c) => c.name);
    assert.ok(cols.includes('task_id'), 'task_id must exist in pr_review_runs after v9 migration');
    assert.ok(cols.includes('verdict'), 'verdict must exist in pr_review_runs after v9 migration');
    assert.ok(cols.includes('attempt_n'), 'attempt_n must exist in pr_review_runs after v9 migration');

    const auditIdx = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pr_review_runs_audit'",
    );
    assert.ok(auditIdx, 'idx_pr_review_runs_audit must exist after v9 migration');

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
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v9 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    ).length;
    assert.equal(secondCount, 1, 'reopening at v9 must not create another backup');
  });

  it('fresh v9 DB has cache token columns with default 0', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');

    const db = new TrajectoryDB(dbPath);

    db.run(
      `INSERT INTO issues (objective, description, status, created_at, updated_at) VALUES ('test', '', 'open', datetime('now'), datetime('now'))`,
    );
    const issueId = (db.get<{ id: number }>('SELECT last_insert_rowid() AS id') as { id: number }).id;

    db.run(
      `INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, tokens_total) VALUES (NULL, ?, 'swe', 100, 50, 150)`,
      [issueId],
    );
    const run = db.get<{ cache_read_tokens: number; cache_creation_tokens: number }>(
      'SELECT cache_read_tokens, cache_creation_tokens FROM agent_runs WHERE issue_id = ?',
      [issueId],
    );
    assert.ok(run, 'agent_run row must exist');
    assert.equal(run.cache_read_tokens, 0, 'cache_read_tokens defaults to 0');
    assert.equal(run.cache_creation_tokens, 0, 'cache_creation_tokens defaults to 0');

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
    assert.equal(meta.schema_version, 23, 'schema_version must be 23 after v9->v10 migration');

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
      `INSERT INTO tasks (issue_id, branch_id, description, status, attempts, spec_body, prompt_bearing, created_at, updated_at)
       VALUES (1, 'feat/prompt-task', 'desc', 'pending', 0, '', 1, datetime('now'), datetime('now'))`,
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
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v10 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
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
    assert.equal(meta?.schema_version, 23, 'fresh DB schema_version must be 23');

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
    assert.equal(meta.schema_version, 23, 'schema_version must be 23 after v10->v11 migration');

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
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v11 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
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
    assert.equal(meta?.schema_version, 23, 'fresh DB schema_version must be 23');

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
  it('v11 DB gains usage_baseline_json column on agent_runs after migration', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV11Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta, 'plugin_meta row required');
    assert.equal(meta.schema_version, 23, 'schema_version must be 23 after v11->v12 migration');

    const cols = db.all<{ name: string }>('PRAGMA table_info(agent_runs)').map((c) => c.name);
    assert.ok(cols.includes('usage_baseline_json'), 'agent_runs.usage_baseline_json must exist after migration');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v23 backup must be written on upgrade');

    db.close();
  });

  it('v11->v12: existing agent_run row gets usage_baseline_json=NULL (no backfill)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV11Db(dbPath);

    const db = new TrajectoryDB(dbPath);

    const run = db.get<{ usage_baseline_json: string | null }>(
      'SELECT usage_baseline_json FROM agent_runs WHERE id = 1',
    );
    assert.ok(run, 'seeded agent_run must survive migration');
    assert.equal(run.usage_baseline_json, null, 'existing rows must have usage_baseline_json=NULL after migration');

    db.close();
  });

  it('v11->v12 migration is idempotent (chained to v13)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV11Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const firstCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v12 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    ).length;
    assert.equal(secondCount, 1, 'reopening at v12 must not create another backup');
  });

  it('fresh v12 DB has usage_baseline_json column and schema_version=15', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.equal(meta?.schema_version, 23, 'fresh DB schema_version must be 23');

    const cols = db.all<{ name: string }>('PRAGMA table_info(agent_runs)').map((c) => c.name);
    assert.ok(cols.includes('usage_baseline_json'), 'usage_baseline_json must exist in fresh DB agent_runs');

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
    assert.equal(meta.schema_version, 23, 'schema_version must be 23 after v12->v13 migration');

    const cols = db.all<{ name: string }>('PRAGMA table_info(tasks)').map((c) => c.name);
    assert.ok(cols.includes('files'), 'tasks.files must exist after migration');
    assert.ok(cols.includes('verification'), 'tasks.verification must exist after migration');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v23 backup must be written on upgrade');

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
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v13 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
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
    assert.equal(meta?.schema_version, 23, 'fresh DB schema_version must be 23');

    const cols = db.all<{ name: string }>('PRAGMA table_info(tasks)').map((c) => c.name);
    assert.ok(cols.includes('files'), 'files must exist in fresh DB tasks');
    assert.ok(cols.includes('verification'), 'verification must exist in fresh DB tasks');

    db.run(
      `INSERT INTO tasks (issue_id, branch_id, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [-1, 'feat/fresh-typed', 'desc', 'pending', '2026-01-01', '2026-01-01'],
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
    assert.equal(meta.schema_version, 23, 'schema_version must be 23 after v13->v14 migration');

    for (const t of ['cheatcodes', 'cheatcode_attachments']) {
      const row = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [t],
      );
      assert.ok(row !== undefined, `${t} table must exist after migration`);
    }

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v23 backup must be written on upgrade');

    db.close();
  });

  it('v13->v14 migration is idempotent (no second backup on re-open)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV13Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const firstCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v18 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
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
      ['pdf', 'plugin', 'https://github.com/x/pdf', '1.0.0', 'trusted', '2026-01-01'],
    );
    const id = Number(cc.lastInsertRowid);
    db.run(
      `INSERT INTO cheatcode_attachments (cheatcode_id, target, artifact, created_at)
       VALUES (?, ?, ?, ?)`,
      [id, 'plugin', 'marketplace-plugin:https://github.com/x/pdf', '2026-01-01'],
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
    VALUES ('pdf', 'plugin', 'https://github.com/x/pdf', '1.0.0', 'trusted', 'installed', '2026-01-01');
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
    assert.equal(meta.schema_version, 23, 'schema_version must be 23 after v14->v15 migration');

    const cols = db.all<{ name: string }>('PRAGMA table_info(cheatcodes)').map((c) => c.name);
    assert.ok(cols.includes('scope'), 'cheatcodes.scope must exist after migration');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v23 backup must be written on upgrade');

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
    assert.equal(row.origin, 'installed', 'pre-v20 cheatcodes are origin=installed');

    db.close();
  });

  it('v14->v15 migration is idempotent (no second backup on re-open)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV14Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const firstCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v18 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
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
    assert.equal(meta.schema_version, 23, 'schema_version must be 23 after v15->v16 migration');

    for (const t of ['rules', 'rule_invocations']) {
      const row = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [t],
      );
      assert.equal(row, undefined, `${t} table must be dropped after migration`);
    }

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v23 backup must be written on upgrade');

    db.close();
  });

  it('v15->v16 migration is idempotent (no second backup on re-open)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV15Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const firstCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v18 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
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
    assert.equal(meta.schema_version, 23, 'schema_version must be 23 after chained v16->v18 migration');

    const row = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='commands'",
    );
    assert.equal(row, undefined, 'commands table must be dropped after migration');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v23 backup must be written on upgrade');

    db.close();
  });

  it('v16->v17 migration is idempotent (no second backup on re-open)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV16Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const firstCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v18 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
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
    assert.equal(meta.schema_version, 23, 'schema_version must be 23 after the v17->v19 chain');

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
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v23 backup must be written on upgrade');

    db.close();
  });

  it('v17->v19 migration is idempotent (no second backup on re-open)', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV17Db(dbPath);

    const db1 = new TrajectoryDB(dbPath);
    db1.close();

    const firstCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v18 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
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
    VALUES ('tmb_planning', 'd', 'skills/tmb_planning/SKILL.md', 'global', 'curated', 'active', '2026-01-01', '2026-01-01');
    INSERT INTO skill_invocations (skill_name, agent_name, invoked_at, outcome)
    VALUES ('tmb_planning', 'bro', datetime('now'), 'completed');
    INSERT INTO cheatcodes (name, kind, source_url, version, trust_tier, scope, status, installed_at)
    VALUES ('pdf-plugin', 'plugin', 'https://github.com/x/pdf', '1.0.0', 'trusted', 'local', 'installed', '2026-02-02'),
           ('global-mcp', 'mcp', 'https://github.com/x/mcp', NULL, 'caution', 'global', 'installed', '2026-02-03');
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
    assert.equal(meta!.schema_version, 23, 'schema_version must be 23 after the v18->v19->v20 chain');

    assert.equal(
      db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='skills'"),
      undefined,
      'skills table must be dropped',
    );

    const pdf = db.get<{ origin: string; scope: string; source_url: string }>(
      "SELECT origin, scope, source_url FROM cheatcodes WHERE name = 'pdf-plugin'",
    );
    assert.equal(pdf!.origin, 'installed');
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
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v23 backup written');

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
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
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
      ('tmb_planning',      'skill', 'builtin', 'd', NULL, 'skills/tmb_planning/SKILL.md',      'global', 'curated', 'active', '2026-01-01'),
      ('tmb_agent-creator', 'skill', 'builtin', 'd', NULL, 'skills/tmb_agent-creator/SKILL.md', 'global', 'curated', 'active', '2026-01-01');
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
    assert.equal(meta!.schema_version, 23, 'schema_version must be 23 after v19->v20');

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
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v23 backup written');

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
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
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
    VALUES ('tmb_planning', 'skill', 'builtin', 'd', NULL, 'skills/tmb_planning/SKILL.md', 'global', 'curated', 'active', '2026-01-01');
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
    assert.equal(meta!.schema_version, 23, 'schema_version must be 23 after the v20->v21->v22 chain');

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
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v23 backup written');

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
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
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
    VALUES ('pre-v22 issue', 'body', 'open', '2026-01-01', '2026-01-01');
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
    assert.equal(meta!.schema_version, 23, 'schema_version must be 23 after v21->v22');

    const cols = db.all<{ name: string }>('PRAGMA table_info(issues)').map((c) => c.name);
    assert.ok(cols.includes('milestone'), 'issues.milestone column must exist after v21->v22');

    // Pre-existing rows backfill to NULL; no other column is disturbed.
    const row = db.get<{ objective: string; milestone: string | null }>(
      "SELECT objective, milestone FROM issues WHERE objective = 'pre-v22 issue'",
    );
    assert.ok(row, 'pre-existing issue row must survive the migration');
    assert.equal(row!.milestone, null, 'existing rows backfill milestone to NULL');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one .pre-v23 backup written');

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
      (f) => f.startsWith(basename(dbPath) + '.pre-v23.') && f.endsWith('.bak'),
    ).length;
    assert.equal(backups, 1, 'reopening at v23 must not create another backup');
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
    assert.equal(meta!.schema_version, 23, 'schema_version must be 23 after v22->v23');

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
