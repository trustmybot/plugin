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
    assert.equal(meta.schema_version, 6);

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

    const skillCols = db
      .all<{ name: string }>('PRAGMA table_info(skills)')
      .map((c) => c.name);
    assert.ok(skillCols.includes('scope'), 'skills.scope must be added');

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

    for (const t of ['rules', 'commands', 'skill_invocations', 'rule_invocations']) {
      const row = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [t],
      );
      assert.ok(row !== undefined, `${t} table must exist after upgrade`);
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
      (f) => f.startsWith(basename(dbPath) + '.pre-v6.') && f.endsWith('.bak'),
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
    assert.equal(meta.schema_version, 6);

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v6.') && f.endsWith('.bak'),
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
      (f) => f.startsWith(basename(dbPath) + '.pre-v6.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v6.') && f.endsWith('.bak'),
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
      (f) => f.startsWith(basename(dbPath) + '.pre-v6.') && f.endsWith('.bak'),
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
    seed.exec(
      `INSERT INTO file_registry (repo, path, type, summary)
       VALUES ('', 'src/test.ts', 'source', 'pre-migration file summary')`,
    );
    seed.close();

    const db = new TrajectoryDB(dbPath);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta, 'plugin_meta row required');
    assert.equal(meta.schema_version, 6, 'schema_version must be 6 after migration');

    for (const ftsTable of ['discussions_fts', 'audit_fts', 'file_registry_fts']) {
      const row = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [ftsTable],
      );
      assert.ok(row !== undefined, `${ftsTable} virtual table must exist after v3 migration`);
    }

    const discFtsCount = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM discussions_fts',
    );
    assert.ok((discFtsCount?.n ?? 0) >= 1, 'discussions_fts must be backfilled with existing rows');

    const auditFtsCount = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM audit_fts',
    );
    assert.ok((auditFtsCount?.n ?? 0) >= 1, 'audit_fts must be backfilled (excludes system seed rows not counted here)');

    const fileFtsCount = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM file_registry_fts',
    );
    assert.ok((fileFtsCount?.n ?? 0) >= 1, 'file_registry_fts must be backfilled with rows that have a summary');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v6.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one pre-v6 backup must exist');

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
      (f) => f.startsWith(basename(dbPath) + '.pre-v6.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v4 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v6.') && f.endsWith('.bak'),
    ).length;
    assert.equal(secondCount, 1, 'reopening at v4 must not create another backup');
  });

  it('FTS tables not populated for file_registry rows where summary IS NULL', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'trajectory.db');
    seedV2Db(dbPath);

    const seed = new DatabaseSync(dbPath);
    seed.exec(
      `INSERT INTO file_registry (repo, path, type, summary)
       VALUES ('', 'src/no-summary.ts', 'source', NULL)`,
    );
    seed.exec(
      `INSERT INTO file_registry (repo, path, type, summary)
       VALUES ('', 'src/with-summary.ts', 'source', 'auth module for user login')`,
    );
    seed.close();

    const db = new TrajectoryDB(dbPath);

    // Non-null summary row must be searchable
    const authMatch = db.get<{ rowid: number }>(
      "SELECT rowid FROM file_registry_fts WHERE file_registry_fts MATCH 'auth'",
    );
    assert.ok(authMatch, 'file with non-null summary must be findable via FTS MATCH');

    // The null-summary row must exist in the source table
    const noSummaryRow = db.get<{ path: string }>(
      "SELECT path FROM file_registry WHERE summary IS NULL",
    );
    assert.ok(noSummaryRow, 'null-summary row must exist in source file_registry table');

    // FTS trigger was guarded by WHEN summary IS NOT NULL, so the null-summary row
    // was not inserted into the FTS index. Searching for a term only in its summary
    // (which is NULL) must return nothing — but we need to verify the trigger logic
    // works for INSERTs post-migration too:
    db.run(
      `INSERT INTO file_registry (repo, path, type, summary) VALUES ('', 'src/post-null.ts', 'source', NULL)`,
    );
    const postNullSearch = db.get<{ rowid: number }>(
      "SELECT rowid FROM file_registry_fts WHERE file_registry_fts MATCH 'post'",
    );
    assert.equal(
      postNullSearch,
      undefined,
      'post-migration INSERT with NULL summary must not be indexed in FTS',
    );

    db.run(
      `INSERT INTO file_registry (repo, path, type, summary) VALUES ('', 'src/post-with-summary.ts', 'source', 'database migration helper')`,
    );
    const postWithSummarySearch = db.get<{ rowid: number }>(
      "SELECT rowid FROM file_registry_fts WHERE file_registry_fts MATCH 'migration'",
    );
    assert.ok(
      postWithSummarySearch,
      'post-migration INSERT with non-null summary must be indexed in FTS',
    );

    db.close();
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
    assert.equal(meta.schema_version, 6, 'schema_version must be 6 after v4->v5 migration');

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
      (f) => f.startsWith(basename(dbPath) + '.pre-v6.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v5 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v6.') && f.endsWith('.bak'),
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
    assert.equal(meta?.schema_version, 6, 'fresh DB schema_version must be 6');

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
    assert.equal(meta.schema_version, 6, 'schema_version must be 6 after migration');

    for (const t of ['discussions_embeddings', 'audit_embeddings', 'file_registry_embeddings']) {
      const row = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [t],
      );
      assert.ok(row !== undefined, `${t} table must exist after v4 migration`);
    }

    for (const idx of [
      'idx_discussions_embeddings_model',
      'idx_audit_embeddings_model',
      'idx_file_registry_embeddings_model',
    ]) {
      const row = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name=?",
        [idx],
      );
      assert.ok(row !== undefined, `index ${idx} must exist after v4 migration`);
    }

    const embCount = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM discussions_embeddings',
    );
    assert.equal(embCount?.n, 0, 'embedding tables must be empty after migration (no backfill)');

    const backups = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v6.') && f.endsWith('.bak'),
    );
    assert.equal(backups.length, 1, 'exactly one pre-v6 backup must exist');

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
    assert.equal(meta.schema_version, 6, 'v2 DB must reach v6 via chained migrations');

    for (const t of ['discussions_fts', 'audit_fts', 'file_registry_fts']) {
      const row = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [t],
      );
      assert.ok(row !== undefined, `${t} must exist (v3 step)`);
    }

    for (const t of ['discussions_embeddings', 'audit_embeddings', 'file_registry_embeddings']) {
      const row = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [t],
      );
      assert.ok(row !== undefined, `${t} must exist (v4 step)`);
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
      (f) => f.startsWith(basename(dbPath) + '.pre-v6.') && f.endsWith('.bak'),
    ).length;
    assert.equal(firstCount, 1, 'first v4 upgrade creates exactly one backup');

    const db2 = new TrajectoryDB(dbPath);
    db2.close();

    const secondCount = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '.pre-v6.') && f.endsWith('.bak'),
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

