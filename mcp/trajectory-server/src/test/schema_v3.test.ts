import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';

describe('schema v5 — spec_body_md, discussions, task_spec_path', () => {
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

  it('fresh DB has schema_version = 5 in plugin_meta', () => {
    const db = tempDB();

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta !== undefined, 'plugin_meta must have a seed row');
    assert.equal(meta.schema_version, 5);

    db.close();
  });

  it('tasks table has spec_body_md column with default empty string', () => {
    const db = tempDB();

    const cols = db.all<{ name: string; dflt_value: string | null }>('PRAGMA table_info(tasks)');
    const col = cols.find((c) => c.name === 'spec_body_md');
    assert.ok(col !== undefined, 'spec_body_md column must exist in tasks');
    assert.equal(col.dflt_value, "''", "spec_body_md default must be empty string");

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
