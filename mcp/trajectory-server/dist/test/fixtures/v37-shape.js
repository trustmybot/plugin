import assert from 'node:assert/strict';
import { tableDdl } from './v29-shape.js';
import { assertV36Shape } from './v36-shape.js';
/** Every v37 DDL item (plus all of v29–v36), asserted identically on fresh and migrated DBs. */
export function assertV37Shape(db) {
    const meta = db.get('SELECT schema_version FROM plugin_meta LIMIT 1');
    assert.equal(meta.schema_version, 43, 'schema_version must be 43');
    assertV36Shape(db);
    const column = (table, name) => db
        .all(`PRAGMA table_info(${table})`)
        .find((c) => c.name === name);
    const taskEffort = column('tasks', 'effort');
    assert.ok(taskEffort, 'tasks.effort exists');
    assert.deepEqual([taskEffort.type, taskEffort.notnull, taskEffort.dflt_value], ['TEXT', 1, "'medium'"], "tasks.effort TEXT NOT NULL DEFAULT 'medium'");
    assert.match(tableDdl(db, 'tasks').replace(/\s+/g, ' '), /effort TEXT NOT NULL DEFAULT 'medium' CHECK \(effort IN \('low','medium','high'\)\)/, 'tasks.effort CHECK');
    const runEffort = column('agent_runs', 'effort');
    assert.ok(runEffort, 'agent_runs.effort exists');
    assert.deepEqual([runEffort.type, runEffort.notnull, runEffort.dflt_value], ['TEXT', 0, null], 'agent_runs.effort TEXT, nullable');
    assert.match(tableDdl(db, 'agent_runs').replace(/\s+/g, ' '), /effort TEXT CHECK \(effort IN \('low','medium','high'\)\)/, 'agent_runs.effort CHECK');
}
//# sourceMappingURL=v37-shape.js.map