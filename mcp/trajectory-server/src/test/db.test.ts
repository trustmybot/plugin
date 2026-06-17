import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { tempDB } from './helpers.js';
import { nowISO, TrajectoryDB } from '../db.js';

describe('TrajectoryDB', () => {
  it('opens an in-memory DB and verifies all prod tables exist with schema_version=18 (world model in kuzu)', () => {
    const db = tempDB();

    const expectedTables = [
      'issues',
      'tasks',
      'audit',
      'validation_attempts',
      'skills',
      'agents',
      'roundtables',
      'roundtable_votes',
      'discussions',
      'plugin_meta',
      'plugin_config',
      'agent_runs',
      'pr_review_runs',
      'repos',
      // #2886 capability catalog junction
      'skill_invocations',
      // #2905 FTS5 virtual tables (workflow tables only — directories moved to kuzu)
      'discussions_fts',
      'audit_fts',
      // #2905 embedding tables (workflow tables only)
      'discussions_embeddings',
      'audit_embeddings',
      // #659 cheatcode install stage
      'cheatcodes',
      'cheatcode_attachments',
    ];

    const rows = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%\\_fts\\_%' ESCAPE '\\' ORDER BY name",
    );
    const actualNames = rows.map((r) => r.name).sort();
    const expectedSorted = [...expectedTables].sort();

    assert.deepEqual(actualNames, expectedSorted);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta !== undefined, 'plugin_meta should have a row');
    assert.equal(meta.schema_version, 18);

    db.close();
  });

  it('run inserts a row into skills, get retrieves it, all lists multiple rows', () => {
    const db = tempDB();
    const now = nowISO();

    db.run(
      `INSERT INTO skills (name, description, file_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['skill-a', 'Skill A', '/path/a.md', now, now],
    );
    db.run(
      `INSERT INTO skills (name, description, file_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['skill-b', 'Skill B', '/path/b.md', now, now],
    );

    const single = db.get<{ name: string; description: string }>(
      'SELECT name, description FROM skills WHERE name = ?',
      ['skill-a'],
    );
    assert.ok(single !== undefined);
    assert.equal(single.name, 'skill-a');
    assert.equal(single.description, 'Skill A');

    // Scope to the test's inserted rows — schema seeds bundled tmb_* skills
    // (#2884) so the table is never empty on a fresh DB. Filter on the names
    // this test wrote to keep the assertion local to the test's intent.
    const all = db.all<{ name: string }>(
      "SELECT name FROM skills WHERE name IN ('skill-a','skill-b') ORDER BY name",
    );
    assert.equal(all.length, 2);
    assert.equal(all[0].name, 'skill-a');
    assert.equal(all[1].name, 'skill-b');

    db.close();
  });

  it('transaction rolls back on thrown error', () => {
    const db = tempDB();
    const now = nowISO();

    assert.throws(() => {
      db.transaction(() => {
        db.run(
          `INSERT INTO skills (name, description, file_path, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          ['rollback-skill', 'Should not persist', '/path/r.md', now, now],
        );
        throw new Error('forced rollback');
      });
    }, /forced rollback/);

    const row = db.get<{ name: string }>(
      'SELECT name FROM skills WHERE name = ?',
      ['rollback-skill'],
    );
    assert.equal(row, undefined, 'rolled-back row must not be present');

    db.close();
  });

  it('nowISO returns an ISO 8601 string ending with Z', () => {
    const iso = nowISO();
    assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
  });

  it('syncs plugin_version from CLAUDE_PLUGIN_ROOT manifest on init', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tmb-test-'));
    try {
      mkdirSync(join(tmpDir, '.claude-plugin'), { recursive: true });
      writeFileSync(
        join(tmpDir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'tmb', version: '9.9.9' }),
        'utf8',
      );
      const saved = process.env['CLAUDE_PLUGIN_ROOT'];
      process.env['CLAUDE_PLUGIN_ROOT'] = tmpDir;
      try {
        const db = new TrajectoryDB(':memory:');
        const row = db.get<{ plugin_version: string }>(
          'SELECT plugin_version FROM plugin_meta WHERE id = 1',
        );
        assert.ok(row !== undefined, 'plugin_meta row must exist');
        assert.equal(row.plugin_version, '9.9.9');
        db.close();
      } finally {
        if (saved === undefined) {
          delete process.env['CLAUDE_PLUGIN_ROOT'];
        } else {
          process.env['CLAUDE_PLUGIN_ROOT'] = saved;
        }
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('updates plugin_version on next init when manifest version changes', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tmb-test-'));
    try {
      mkdirSync(join(tmpDir, '.claude-plugin'), { recursive: true });
      const manifestPath = join(tmpDir, '.claude-plugin', 'plugin.json');
      writeFileSync(manifestPath, JSON.stringify({ name: 'tmb', version: '9.9.9' }), 'utf8');
      const dbPath = join(tmpDir, 'trajectory.db');
      const saved = process.env['CLAUDE_PLUGIN_ROOT'];
      process.env['CLAUDE_PLUGIN_ROOT'] = tmpDir;
      try {
        const db1 = new TrajectoryDB(dbPath);
        db1.close();

        writeFileSync(manifestPath, JSON.stringify({ name: 'tmb', version: '9.9.10' }), 'utf8');

        const db2 = new TrajectoryDB(dbPath);
        const row = db2.get<{ plugin_version: string }>(
          'SELECT plugin_version FROM plugin_meta WHERE id = 1',
        );
        assert.ok(row !== undefined, 'plugin_meta row must exist');
        assert.equal(row.plugin_version, '9.9.10');
        db2.close();
      } finally {
        if (saved === undefined) {
          delete process.env['CLAUDE_PLUGIN_ROOT'];
        } else {
          process.env['CLAUDE_PLUGIN_ROOT'] = saved;
        }
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('flags legacyNoPluginMeta=false on a genuinely fresh DB', () => {
    const db = new TrajectoryDB(':memory:');
    assert.equal(db.legacyNoPluginMeta, false);
    db.close();
  });

  it('flags legacyNoPluginMeta=true when a DB has tables but no plugin_meta (#602)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tmb-legacy-'));
    try {
      const dbPath = join(tmpDir, 'trajectory.db');
      // Seed a pre-stamp legacy shape: a user table present, NO plugin_meta.
      // Use a zombie table the current schema no longer defines so reapplying
      // schema.sql stays clean — the flag only depends on a non-sqlite table
      // existing alongside a missing plugin_meta.
      const seed = new DatabaseSync(dbPath);
      seed.exec('PRAGMA journal_mode = WAL');
      seed.exec(`
        CREATE TABLE regen_state (id INTEGER PRIMARY KEY, state_json TEXT);
        INSERT INTO regen_state (state_json) VALUES ('{"legacy":true}');
      `);
      seed.close();

      const db = new TrajectoryDB(dbPath);
      try {
        assert.equal(db.legacyNoPluginMeta, true, 'pre-stamp legacy DB must be flagged');
        // Adopted forward, not bricked: plugin_meta now exists and is stamped,
        // and the pre-existing legacy table is preserved.
        const meta = db.get<{ schema_version: number }>(
          'SELECT schema_version FROM plugin_meta LIMIT 1',
        );
        assert.ok(meta !== undefined, 'plugin_meta should be stamped on adopt-forward');
        const legacyRow = db.get<{ state_json: string }>(
          'SELECT state_json FROM regen_state LIMIT 1',
        );
        assert.ok(legacyRow !== undefined, 'pre-existing legacy rows must survive');
      } finally {
        db.close();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
