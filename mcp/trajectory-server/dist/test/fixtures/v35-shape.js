import assert from 'node:assert/strict';
import { tableDdl } from './v29-shape.js';
import { assertV34Shape } from './v34-shape.js';
/**
 * Every v35 DDL item (plus all of v29–v34), asserted identically on fresh and
 * migrated DBs. The schema_version stamp is asserted by v36-shape.ts.
 */
export function assertV35Shape(db) {
    assertV34Shape(db);
    const repoCols = db.all('PRAGMA table_info(repos)').map((c) => c.name);
    assert.deepEqual(repoCols, ['name', 'path', 'file_count', 'last_scanned_at', 'target_branch', 'branching_model', 'protected_branches'], 'repos has no remotes column at v35');
    const cols = db.all('PRAGMA table_info(repo_remotes)');
    assert.deepEqual(cols.map((c) => [c.name, c.type, c.notnull, c.pk]), [
        ['repo', 'TEXT', 1, 1],
        ['name', 'TEXT', 1, 2],
        ['provider', 'TEXT', 1, 0],
        ['url', 'TEXT', 1, 0],
        ['is_primary', 'INTEGER', 1, 0],
        ['created_at', 'TEXT', 1, 0],
    ], 'repo_remotes columns and PRIMARY KEY (repo, name)');
    const ddl = tableDdl(db, 'repo_remotes').replace(/\s+/g, ' ');
    assert.match(ddl, /provider TEXT NOT NULL CHECK \(provider IN \('github','gitlab','other'\)\)/, 'repo_remotes.provider CHECK');
    assert.match(ddl, /is_primary INTEGER NOT NULL DEFAULT 0 CHECK \(is_primary IN \(0,1\)\)/, 'repo_remotes.is_primary CHECK');
    const fks = db.all('PRAGMA foreign_key_list(repo_remotes)');
    assert.deepEqual(fks.map((f) => [f.table, f.from, f.to, f.on_update, f.on_delete]), [['repos', 'repo', 'name', 'CASCADE', 'CASCADE']], 'repo_remotes.repo → repos(name) ON DELETE CASCADE ON UPDATE CASCADE');
    const idx = db.all('PRAGMA index_list(repo_remotes)').map((i) => i.name);
    assert.ok(idx.includes('idx_repo_remotes_primary'), 'idx_repo_remotes_primary exists');
    assert.deepEqual(db.all('PRAGMA index_info(idx_repo_remotes_primary)').map((c) => c.name), ['repo', 'is_primary']);
    const va = db.all('PRAGMA table_info(validation_attempts)');
    const reviewer = va.find((c) => c.name === 'reviewer_agent_id');
    assert.ok(reviewer, 'validation_attempts.reviewer_agent_id exists at v35');
    assert.equal(reviewer.type, 'TEXT');
    assert.equal(reviewer.notnull, 0, 'reviewer_agent_id is nullable');
    assert.equal(reviewer.dflt_value, null, 'reviewer_agent_id has no default');
    const blank = db.get("SELECT COUNT(*) AS n FROM audit WHERE branch_id = ''");
    assert.equal(blank.n, 0, "no audit row carries branch_id ''");
}
//# sourceMappingURL=v35-shape.js.map