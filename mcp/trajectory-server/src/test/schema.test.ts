import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';

describe('schema — current table set, default values, constraints', () => {
  it('fresh DB contains all 16 tables', () => {
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
      'debug_trajectory',
      'eval_results',
    ];

    const rows = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const actualNames = rows.map((r) => r.name).sort();
    assert.deepEqual(actualNames, [...expectedTables].sort());

    db.close();
  });

  it('fresh DB has schema_version = 1 in plugin_meta', () => {
    const db = tempDB();

    const meta = db.get<{ schema_version: number }>(
      'SELECT schema_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta !== undefined, 'plugin_meta must have a seed row');
    assert.equal(meta.schema_version, 1);

    db.close();
  });

  it('tasks table has spec_body column with default empty string', () => {
    const db = tempDB();

    const cols = db.all<{ name: string; dflt_value: string | null }>('PRAGMA table_info(tasks)');
    const specBody = cols.find((c) => c.name === 'spec_body');
    assert.ok(specBody !== undefined, 'spec_body column must exist in tasks');
    assert.equal(specBody.dflt_value, "''", "spec_body default must be empty string");

    db.close();
  });

  it('validation_attempts.task_id is INTEGER with FK to tasks(id)', () => {
    const db = tempDB();

    const cols = db.all<{ name: string; type: string; notnull: number }>(
      'PRAGMA table_info(validation_attempts)',
    );
    const taskId = cols.find((c) => c.name === 'task_id');
    assert.ok(taskId !== undefined, 'task_id column must exist');
    assert.equal(taskId.type.toUpperCase(), 'INTEGER', 'task_id must be INTEGER');
    assert.equal(taskId.notnull, 1, 'task_id must be NOT NULL');

    const fks = db.all<{ table: string; from: string; to: string }>(
      'PRAGMA foreign_key_list(validation_attempts)',
    );
    const fk = fks.find((f) => f.from === 'task_id');
    assert.ok(fk !== undefined, 'task_id must have a foreign key');
    assert.equal(fk.table, 'tasks');
    assert.equal(fk.to, 'id');

    db.close();
  });

  it('identity has zero rows on init', () => {
    const db = tempDB();

    const rows = db.all('SELECT * FROM identity');
    assert.equal(rows.length, 0);

    db.close();
  });

  it('plugin_config has the 3 schema-seeded default policy keys on init', () => {
    const db = tempDB();

    const rows = db.all<{ key: string; value_json: string }>(
      "SELECT key, value_json FROM plugin_config ORDER BY key",
    );
    // node:sqlite returns rows as null-prototype objects; map to plain objects
    // so assert.deepEqual matches the literal expected shape.
    const plain = rows.map((r) => ({ key: r.key, value_json: r.value_json }));
    assert.deepEqual(plain, [
      { key: 'branching_model', value_json: '"github-flow"' },
      { key: 'pr_target', value_json: '"main"' },
      { key: 'protected_branches', value_json: '["main"]' },
    ]);

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

  it('file_registry has the codebase-memory columns (#45) on a fresh DB', () => {
    const db = tempDB();

    const cols = db.all<{ name: string; type: string }>(
      'PRAGMA table_info(file_registry)',
    );
    const byName = new Map(cols.map((c) => [c.name, c.type]));

    assert.equal(byName.get('content_md5'), 'TEXT');
    assert.equal(byName.get('summary'), 'TEXT');
    assert.equal(byName.get('summary_updated_at'), 'TEXT');

    db.close();
  });

  it('last_verified_sha config key is NOT schema-seeded (#45 — initial null is correct)', () => {
    const db = tempDB();

    const row = db.get<{ value_json: string } | undefined>(
      "SELECT value_json FROM plugin_config WHERE key = 'last_verified_sha'",
    );
    assert.equal(row, undefined, 'last_verified_sha must start absent');

    db.close();
  });

  it('debug_trajectory has zero rows on init (issue #108)', () => {
    const db = tempDB();

    const rows = db.all('SELECT * FROM debug_trajectory');
    assert.equal(rows.length, 0);

    db.close();
  });

  it('debug_trajectory has expected columns + index (issue #108, extended for #110)', () => {
    const db = tempDB();

    const cols = db.all<{ name: string }>('PRAGMA table_info(debug_trajectory)');
    const colNames = cols.map((c) => c.name).sort();
    assert.deepEqual(colNames, [
      'agent',
      'args_json',
      'created_at',
      'id',
      'is_error',
      'kind',
      'latency_ms',
      'result_json',
      'session_id',
      'step_n',
      'tokens_in',
      'tokens_out',
      'tool_or_mcp_name',
    ]);

    const indexes = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='debug_trajectory'",
    );
    const indexNames = indexes.map((i) => i.name);
    assert.ok(
      indexNames.includes('idx_debug_trajectory_session'),
      'session-step index must exist for L5 reads',
    );

    db.close();
  });

  it('eval_results table exists with v2 multi-scorer schema (issue #110)', () => {
    const db = tempDB();

    const rows = db.all('SELECT * FROM eval_results');
    assert.equal(rows.length, 0, 'eval_results must be empty on init');

    const cols = db.all<{ name: string }>('PRAGMA table_info(eval_results)');
    const colNames = cols.map((c) => c.name).sort();
    assert.deepEqual(colNames, [
      'created_at',
      'explanation',
      'flow_name',
      'id',
      'metadata_json',
      'pass',
      'run_id',
      'scorer_name',
      'value',
    ]);

    const indexes = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='eval_results'",
    );
    const indexNames = indexes.map((i) => i.name).sort();
    assert.ok(indexNames.includes('idx_eval_results_run'), 'run_id index required');
    assert.ok(indexNames.includes('idx_eval_results_flow'), 'flow_name index required');

    db.close();
  });

  it('identity CHECK constraint rejects a second row with id != 1', () => {
    const db = tempDB();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO identity (id, human_name, created_at, updated_at) VALUES (1, 'Alice', ?, ?)`,
      [now, now],
    );

    assert.throws(
      () => {
        db.run(
          `INSERT INTO identity (id, human_name, created_at, updated_at) VALUES (2, 'Bob', ?, ?)`,
          [now, now],
        );
      },
      /CHECK constraint failed/,
    );

    db.close();
  });
});
