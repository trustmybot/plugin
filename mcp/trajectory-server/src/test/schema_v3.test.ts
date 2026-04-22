import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';

describe('schema v4 — discussions table and task_spec_path column', () => {
  it('fresh DB contains all 14 tables', () => {
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
    assert.deepEqual(actualNames, [...expectedTables].sort());

    db.close();
  });

  it('fresh DB has schema_version = 4 in plugin_meta', () => {
    const db = tempDB();

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta !== undefined, 'plugin_meta must have a seed row');
    assert.equal(meta.schema_version, 4);

    db.close();
  });

  it('identity has zero rows on init', () => {
    const db = tempDB();

    const rows = db.all('SELECT * FROM identity');
    assert.equal(rows.length, 0);

    db.close();
  });

  it('plugin_config has zero rows on init', () => {
    const db = tempDB();

    const rows = db.all('SELECT * FROM plugin_config');
    assert.equal(rows.length, 0);

    db.close();
  });

  it('regen_state has zero rows on init', () => {
    const db = tempDB();

    const rows = db.all('SELECT * FROM regen_state');
    assert.equal(rows.length, 0);

    db.close();
  });

  it('file_registry has zero rows on init', () => {
    const db = tempDB();

    const rows = db.all('SELECT * FROM file_registry');
    assert.equal(rows.length, 0);

    db.close();
  });

  it('identity CHECK constraint rejects a second row with id != 1', () => {
    const db = tempDB();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO identity (id, gatekeeper_name, created_at, updated_at) VALUES (1, 'bro', ?, ?)`,
      [now, now],
    );

    assert.throws(
      () => {
        db.run(
          `INSERT INTO identity (id, gatekeeper_name, created_at, updated_at) VALUES (2, 'bro', ?, ?)`,
          [now, now],
        );
      },
      /CHECK constraint failed/,
    );

    db.close();
  });
});
