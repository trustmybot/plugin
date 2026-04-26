import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
describe('schema — current table set, default values, constraints', () => {
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
        const rows = db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
        const actualNames = rows.map((r) => r.name).sort();
        assert.deepEqual(actualNames, [...expectedTables].sort());
        db.close();
    });
    it('fresh DB has schema_version = 1 in plugin_meta', () => {
        const db = tempDB();
        const meta = db.get('SELECT schema_version FROM plugin_meta LIMIT 1');
        assert.ok(meta !== undefined, 'plugin_meta must have a seed row');
        assert.equal(meta.schema_version, 1);
        db.close();
    });
    it('tasks table has spec_body column with default empty string', () => {
        const db = tempDB();
        const cols = db.all('PRAGMA table_info(tasks)');
        const specBody = cols.find((c) => c.name === 'spec_body');
        assert.ok(specBody !== undefined, 'spec_body column must exist in tasks');
        assert.equal(specBody.dflt_value, "''", "spec_body default must be empty string");
        db.close();
    });
    it('validation_attempts.task_id is INTEGER with FK to tasks(id)', () => {
        const db = tempDB();
        const cols = db.all('PRAGMA table_info(validation_attempts)');
        const taskId = cols.find((c) => c.name === 'task_id');
        assert.ok(taskId !== undefined, 'task_id column must exist');
        assert.equal(taskId.type.toUpperCase(), 'INTEGER', 'task_id must be INTEGER');
        assert.equal(taskId.notnull, 1, 'task_id must be NOT NULL');
        const fks = db.all('PRAGMA foreign_key_list(validation_attempts)');
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
        db.run(`INSERT INTO identity (id, human_name, created_at, updated_at) VALUES (1, 'Alice', ?, ?)`, [now, now]);
        assert.throws(() => {
            db.run(`INSERT INTO identity (id, human_name, created_at, updated_at) VALUES (2, 'Bob', ?, ?)`, [now, now]);
        }, /CHECK constraint failed/);
        db.close();
    });
});
//# sourceMappingURL=schema.test.js.map