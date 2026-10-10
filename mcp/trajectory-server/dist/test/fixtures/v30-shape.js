import assert from 'node:assert/strict';
import { assertV29Shape, indexNames, tableDdl } from './v29-shape.js';
export const ISO_NOW_DEFAULT = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
export const V30_INDEXES = [
    ['idx_agent_runs_task', /ON agent_runs\(task_id\)$/],
    ['idx_agent_runs_issue', /ON agent_runs\(issue_id\)$/],
    ['idx_agent_runs_open', /WHERE completed_at IS NULL$/],
    ['idx_agent_runs_spawn', /UNIQUE INDEX .* ON agent_runs\(task_id, spawn_id\) WHERE spawn_id IS NOT NULL$/],
    ['idx_agent_runs_session', /ON agent_runs\(session_id\) WHERE session_id IS NOT NULL$/],
    ['idx_discussions_remote_comment', /UNIQUE INDEX .* ON discussions\(remote_comment_id\) WHERE remote_comment_id IS NOT NULL$/],
    ['idx_cheatcode_attachments_cheatcode', /ON cheatcode_attachments\(cheatcode_id\)$/],
];
const ISO_DEFAULT_COLUMNS = [
    ['repos', 'last_scanned_at'],
    ['agents', 'created_at'],
    ['agents', 'updated_at'],
    ['cheatcodes', 'created_at'],
    ['cheatcodes', 'updated_at'],
];
const NULLABLE_TOKEN_COLUMNS = ['tokens_in', 'tokens_out', 'cache_read_tokens', 'cache_creation_tokens'];
function columns(db, table) {
    return db.all(`PRAGMA table_info(${table})`);
}
/** Every v30 DDL item (plus all of v29), asserted identically on fresh and migrated DBs. */
export function assertV30Shape(db) {
    const meta = db.get('SELECT schema_version FROM plugin_meta LIMIT 1');
    assert.equal(meta.schema_version, 30, 'schema_version must be 30');
    assertV29Shape(db);
    const runCols = columns(db, 'agent_runs');
    for (const name of NULLABLE_TOKEN_COLUMNS) {
        const col = runCols.find((c) => c.name === name);
        assert.ok(col, `agent_runs.${name} must exist`);
        assert.equal(col.notnull, 0, `agent_runs.${name} must be nullable`);
        assert.equal(col.dflt_value, null, `agent_runs.${name} must carry no DEFAULT`);
    }
    for (const name of ['tokens_total', 'tool_uses', 'duration_ms']) {
        const col = runCols.find((c) => c.name === name);
        assert.equal(col?.notnull, 1, `agent_runs.${name} stays NOT NULL`);
        assert.equal(col?.dflt_value, '0', `agent_runs.${name} keeps DEFAULT 0`);
    }
    for (const name of ['usage_baseline_json', 'spawn_id', 'session_id', 'usage_source']) {
        assert.ok(runCols.some((c) => c.name === name), `agent_runs.${name} must exist`);
    }
    assert.ok(tableDdl(db, 'agent_runs').includes("usage_source IN ('transcript','subagent_stop','unmeasured')"), 'agent_runs DDL must CHECK usage_source');
    assert.ok(columns(db, 'discussions').some((c) => c.name === 'remote_comment_id'), 'discussions.remote_comment_id must exist');
    for (const [table, column] of ISO_DEFAULT_COLUMNS) {
        const col = columns(db, table).find((c) => c.name === column);
        assert.equal(col?.dflt_value, ISO_NOW_DEFAULT, `${table}.${column} must DEFAULT to ms-ISO now`);
    }
    for (const table of ['repos', 'agents', 'cheatcodes']) {
        assert.ok(!tableDdl(db, table).includes("datetime('now')"), `${table} DDL must not use datetime('now')`);
    }
    const cheatcodeDdl = tableDdl(db, 'cheatcodes');
    for (const check of [
        "kind IN ('skill','mcp','plugin')",
        "origin IN ('builtin','marketplace','external')",
        "scope IN ('global','template','project-local')",
        "CHECK (kind != 'skill' OR file_path IS NOT NULL)",
        "CHECK (origin = 'builtin' OR source_url IS NOT NULL)",
        "CHECK (origin != 'builtin' OR source_url IS NULL)",
    ]) {
        assert.ok(cheatcodeDdl.includes(check), `cheatcodes DDL must carry ${check}`);
    }
    const agentsDdl = tableDdl(db, 'agents');
    assert.ok(agentsDdl.includes("kind IN ('backbone','consultant')"), 'agents DDL must CHECK kind');
    assert.ok(agentsDdl.includes("scope IN ('global','template','project-local')"), 'agents DDL must CHECK scope');
    const fk = db
        .all('PRAGMA foreign_key_list(cheatcode_attachments)')
        .map((r) => ({ table: r.table, on_delete: r.on_delete }));
    assert.deepEqual(fk, [{ table: 'cheatcodes', on_delete: 'CASCADE' }], 'cheatcode_attachments FK must survive');
    const indexes = indexNames(db);
    for (const [name, shape] of V30_INDEXES) {
        assert.ok(indexes.includes(name), `index ${name} must exist`);
        const sql = db.get("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", [name]);
        assert.match(sql.sql.replace(/\s+/g, ' ').trim(), shape, `index ${name} must have the v30 shape`);
    }
    assert.throws(() => db.run(`INSERT INTO agent_runs (agent_type, usage_source) VALUES ('swe', 'guess')`), /CHECK/, 'agent_runs.usage_source CHECK must reject an unknown source');
}
/** Every non-NULL value in every timestamp column must be the 24-char ms-ISO form. */
export function assertTimestampsIso(db) {
    const tables = db
        .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'")
        .map((r) => r.name);
    for (const table of tables) {
        for (const col of columns(db, table).filter((c) => c.name.endsWith('_at'))) {
            const bad = db.all(`SELECT ${col.name} AS v FROM ${table} WHERE ${col.name} IS NOT NULL AND length(${col.name}) <> 24 LIMIT 3`);
            assert.deepEqual(bad.map((r) => r.v), [], `${table}.${col.name} must hold only 24-char timestamps`);
        }
    }
}
//# sourceMappingURL=v30-shape.js.map