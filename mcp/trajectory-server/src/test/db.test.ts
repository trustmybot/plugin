import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { nowISO, genId } from '../db.js';

describe('TrajectoryDB', () => {
  it('opens an in-memory DB and verifies all 14 tables exist with schema_version=1', () => {
    const db = tempDB();

    const expectedTables = [
      'issues',
      'tasks',
      'ledger',
      'audit',
      'validation_attempts',
      'skills',
      'roundtables',
      'roundtable_votes',
      'discussions',
      'plugin_meta',
      'file_registry',
      'plugin_config',
      'identity',
      'regen_state',
    ];

    const rows = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const actualNames = rows.map((r) => r.name).sort();
    const expectedSorted = [...expectedTables].sort();

    assert.deepEqual(actualNames, expectedSorted);

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta !== undefined, 'plugin_meta should have a row');
    assert.equal(meta.schema_version, 1);

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

    const all = db.all<{ name: string }>(
      'SELECT name FROM skills ORDER BY name',
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

  it('genId returns a string starting with the prefix and is unique across 100 calls', () => {
    const ids = Array.from({ length: 100 }, () => genId('iss'));
    for (const id of ids) {
      assert.ok(id.startsWith('iss_'), `Expected id to start with "iss_": ${id}`);
    }
    const unique = new Set(ids);
    assert.equal(unique.size, 100, 'All 100 IDs must be unique');
  });
});
