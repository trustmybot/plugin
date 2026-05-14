import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { TrajectoryDB } from '../db.js';
const tmpDirs = [];
function makeTmpDir() {
    const dir = mkdtempSync(join(tmpdir(), 'tmb-schema-upgrade-'));
    tmpDirs.push(dir);
    return dir;
}
after(() => {
    for (const dir of tmpDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});
function seedLegacyV1Db(dbPath, kind) {
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
    }
    else {
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
describe('schema upgrade — v1 -> v2 migration framework', () => {
    it('legacy pre-#2886 DB upgrades to v2', () => {
        const tmpDir = makeTmpDir();
        const dbPath = join(tmpDir, 'trajectory.db');
        seedLegacyV1Db(dbPath, 'pre-2886');
        const seed = new DatabaseSync(dbPath);
        seed.exec(`INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'legacy issue', '', 'open', '2026-01-01', '2026-01-01')`);
        seed.exec(`INSERT INTO tasks (id, issue_id, branch_id, title, description, status, attempts, spec_body, success_criteria, created_at, updated_at) VALUES (1, 1, 'feat/legacy', '', 'legacy desc', 'pending', 0, '', 'done', '2026-01-01', '2026-01-01')`);
        // Pre-#2876 onboarded marker — must be translated to plugin_config('onboarded': true)
        // by the migration. Without translation, post-upgrade first_run=true re-fires
        // the onboarding ceremony on a user who was already onboarded.
        seed.exec(`INSERT INTO identity (id) VALUES (1)`);
        seed.close();
        const db = new TrajectoryDB(dbPath);
        const meta = db.get('SELECT schema_version FROM plugin_meta LIMIT 1');
        assert.ok(meta, 'plugin_meta row required');
        assert.equal(meta.schema_version, 2);
        const identity = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='identity'");
        assert.equal(identity, undefined, 'identity table must be dropped');
        const regen = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='regen_state'");
        assert.equal(regen, undefined, 'regen_state table must be dropped');
        const taskCols = db
            .all('PRAGMA table_info(tasks)')
            .map((c) => c.name);
        assert.ok(!taskCols.includes('success_criteria'), 'tasks.success_criteria must be removed');
        const skillCols = db
            .all('PRAGMA table_info(skills)')
            .map((c) => c.name);
        assert.ok(skillCols.includes('scope'), 'skills.scope must be added');
        const fileRegCols = db
            .all('PRAGMA table_info(file_registry)')
            .map((c) => c.name);
        assert.ok(!fileRegCols.includes('size_bytes'), 'file_registry.size_bytes must be removed');
        assert.ok(!fileRegCols.includes('last_commit_sha'), 'file_registry.last_commit_sha must be removed');
        assert.ok(!fileRegCols.includes('language'), 'file_registry.language must be removed');
        for (const t of ['rules', 'commands', 'skill_invocations', 'rule_invocations']) {
            const row = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t]);
            assert.ok(row !== undefined, `${t} table must exist after upgrade`);
        }
        const survivingTask = db.get('SELECT id FROM tasks WHERE id = 1');
        assert.ok(survivingTask, 'seeded task row must survive migration');
        const onboardedRow = db.get(`SELECT value_json FROM plugin_config WHERE key = 'onboarded'`);
        assert.ok(onboardedRow, 'onboarded marker must be translated from legacy identity row');
        assert.equal(onboardedRow.value_json, 'true');
        const backups = readdirSync(dirname(dbPath)).filter((f) => f.startsWith(basename(dbPath) + '.pre-v2.') && f.endsWith('.bak'));
        assert.equal(backups.length, 1, 'exactly one backup file must exist');
        db.run(`INSERT INTO tasks (issue_id, branch_id, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [1, 'feat/test-round-trip', 'desc', 'pending', '2026-01-01', '2026-01-01']);
        db.close();
    });
    it('rc-current DB upgrades cleanly (no rebuilds needed, just version bump)', () => {
        const tmpDir = makeTmpDir();
        const dbPath = join(tmpDir, 'trajectory.db');
        seedLegacyV1Db(dbPath, 'rc-current');
        const db = new TrajectoryDB(dbPath);
        const meta = db.get('SELECT schema_version FROM plugin_meta LIMIT 1');
        assert.ok(meta);
        assert.equal(meta.schema_version, 2);
        const backups = readdirSync(dirname(dbPath)).filter((f) => f.startsWith(basename(dbPath) + '.pre-v2.') && f.endsWith('.bak'));
        assert.equal(backups.length, 1, 'backup must exist for rc-current upgrade');
        db.run(`INSERT INTO issues (objective, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, ['post-upgrade', '', 'open', '2026-01-01', '2026-01-01']);
        db.close();
    });
    it('idempotent — re-opening at v2 does NOT create a second backup', () => {
        const tmpDir = makeTmpDir();
        const dbPath = join(tmpDir, 'trajectory.db');
        seedLegacyV1Db(dbPath, 'pre-2886');
        const db1 = new TrajectoryDB(dbPath);
        db1.close();
        const firstCount = readdirSync(dirname(dbPath)).filter((f) => f.startsWith(basename(dbPath) + '.pre-v2.') && f.endsWith('.bak')).length;
        assert.equal(firstCount, 1, 'first upgrade creates exactly one backup');
        const db2 = new TrajectoryDB(dbPath);
        db2.close();
        const secondCount = readdirSync(dirname(dbPath)).filter((f) => f.startsWith(basename(dbPath) + '.pre-v2.') && f.endsWith('.bak')).length;
        assert.equal(secondCount, 1, 'reopening at v2 must not create another backup');
    });
    it('rejects DB with schema_version > TARGET (downgrade protection)', () => {
        const tmpDir = makeTmpDir();
        const dbPath = join(tmpDir, 'trajectory.db');
        seedLegacyV1Db(dbPath, 'rc-current');
        const raw = new DatabaseSync(dbPath);
        raw.exec('UPDATE plugin_meta SET schema_version = 99 WHERE id = 1');
        raw.close();
        assert.throws(() => new TrajectoryDB(dbPath), /newer than code's max/, 'must reject schema_version > TARGET');
        assert.ok(existsSync(dbPath), 'DB file should remain after rejected open');
    });
});
//# sourceMappingURL=schema-upgrade.test.js.map