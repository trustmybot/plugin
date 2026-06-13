import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tempDB } from './helpers.js';
import { TrajectoryDB } from '../db.js';
describe('schema — current table set, default values, constraints', () => {
    it('fresh prod-mode DB contains 22 tables (no eval/debug, no directories post-v8 — world model in kuzu)', () => {
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
            // #2886 capability catalog + junctions
            'rules',
            'commands',
            'skill_invocations',
            'rule_invocations',
            // #2905 FTS5 virtual tables (workflow tables only — directories moved to kuzu)
            'discussions_fts',
            'audit_fts',
            // #2905 embedding tables (workflow tables only)
            'discussions_embeddings',
            'audit_embeddings',
        ];
        const rows = db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%\_fts\_%' ESCAPE '\\' ORDER BY name");
        const actualNames = rows.map((r) => r.name).sort();
        assert.deepEqual(actualNames, [...expectedTables].sort());
        db.close();
    });
    it('fresh DB has schema_version = 11 in plugin_meta', () => {
        const db = tempDB();
        const meta = db.get('SELECT schema_version, plugin_version FROM plugin_meta LIMIT 1');
        assert.ok(meta !== undefined, 'plugin_meta must have a seed row');
        assert.equal(meta.schema_version, 11);
        assert.ok(typeof meta.plugin_version === 'string' && meta.plugin_version.length > 0, 'plugin_version must be a non-empty string');
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
    it('tasks table has prompt_bearing column with default 0', () => {
        const db = tempDB();
        const cols = db.all('PRAGMA table_info(tasks)');
        const col = cols.find((c) => c.name === 'prompt_bearing');
        assert.ok(col !== undefined, 'prompt_bearing column must exist in tasks');
        assert.equal(col.type.toUpperCase(), 'INTEGER', 'prompt_bearing must be INTEGER');
        assert.equal(col.notnull, 1, 'prompt_bearing must be NOT NULL');
        assert.equal(col.dflt_value, '0', 'prompt_bearing default must be 0');
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
    it('plugin_config has the 5 schema-seeded default policy keys on init', () => {
        const db = tempDB();
        const rows = db.all("SELECT key, value_json FROM plugin_config ORDER BY key");
        // node:sqlite returns rows as null-prototype objects; map to plain objects
        // so assert.deepEqual matches the literal expected shape.
        const plain = rows.map((r) => ({ key: r.key, value_json: r.value_json }));
        assert.deepEqual(plain, [
            { key: 'branching_model', value_json: '"github-flow"' },
            { key: 'issue_sync', value_json: '"off"' },
            { key: 'pr_target', value_json: '"main"' },
            { key: 'protected_branches', value_json: '["main"]' },
            { key: 'remotes', value_json: '[]' },
        ]);
        db.close();
    });
    it('directories table does NOT exist post-v8 (world model lives in kuzu — ADR 0002)', () => {
        const db = tempDB();
        const row = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='directories'");
        assert.equal(row, undefined, 'directories table must be absent — world model moved to kuzu graph DB');
        db.close();
    });
    it('eval_results has the A/B columns (#131) on a fresh DB', () => {
        process.env['TMB_EVAL_MODE'] = '1';
        let db;
        try {
            db = tempDB();
            const cols = db.all('PRAGMA table_info(eval_results)');
            const byName = new Map(cols.map((c) => [c.name, c]));
            const arm = byName.get('arm');
            assert.ok(arm, 'arm column must exist');
            assert.equal(arm.type, 'TEXT');
            assert.equal(arm.notnull, 1, 'arm must be NOT NULL');
            assert.equal(arm.dflt_value, "'control'", 'arm must default to control');
            const scenario = byName.get('scenario');
            assert.ok(scenario, 'scenario column must exist');
            assert.equal(scenario.type, 'TEXT');
            assert.equal(scenario.notnull, 0, 'scenario is nullable');
            db.close();
        }
        finally {
            delete process.env['TMB_EVAL_MODE'];
        }
    });
    it('last_verified_sha config key is NOT schema-seeded (#45 — initial null is correct)', () => {
        const db = tempDB();
        const row = db.get("SELECT value_json FROM plugin_config WHERE key = 'last_verified_sha'");
        assert.equal(row, undefined, 'last_verified_sha must start absent');
        db.close();
    });
    it('prod-mode DB does NOT have eval_results or debug_trajectory tables (#163)', () => {
        const db = tempDB();
        const evalTable = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='eval_results'");
        assert.equal(evalTable, undefined, 'eval_results must be absent in prod mode');
        const debugTable = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='debug_trajectory'");
        assert.equal(debugTable, undefined, 'debug_trajectory must be absent in prod mode');
        db.close();
    });
    it('eval-mode DB has eval_results + debug_trajectory when TMB_EVAL_MODE=1 (#163)', () => {
        process.env['TMB_EVAL_MODE'] = '1';
        let db;
        try {
            db = tempDB();
            const evalTable = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='eval_results'");
            assert.ok(evalTable !== undefined, 'eval_results must be present in eval mode');
            const debugTable = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='debug_trajectory'");
            assert.ok(debugTable !== undefined, 'debug_trajectory must be present in eval mode');
            db.close();
        }
        finally {
            delete process.env['TMB_EVAL_MODE'];
        }
    });
    it('debug_trajectory has zero rows on init (issue #108)', () => {
        process.env['TMB_EVAL_MODE'] = '1';
        let db;
        try {
            db = tempDB();
            const rows = db.all('SELECT * FROM debug_trajectory');
            assert.equal(rows.length, 0);
            db.close();
        }
        finally {
            delete process.env['TMB_EVAL_MODE'];
        }
    });
    it('debug_trajectory has expected columns + index (issue #108, extended for #110)', () => {
        process.env['TMB_EVAL_MODE'] = '1';
        let db;
        try {
            db = tempDB();
            const cols = db.all('PRAGMA table_info(debug_trajectory)');
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
            const indexes = db.all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='debug_trajectory'");
            const indexNames = indexes.map((i) => i.name);
            assert.ok(indexNames.includes('idx_debug_trajectory_session'), 'session-step index must exist for L5 reads');
            db.close();
        }
        finally {
            delete process.env['TMB_EVAL_MODE'];
        }
    });
    it('eval_results table exists with v2 multi-scorer schema (issue #110)', () => {
        process.env['TMB_EVAL_MODE'] = '1';
        let db;
        try {
            db = tempDB();
            const rows = db.all('SELECT * FROM eval_results');
            assert.equal(rows.length, 0, 'eval_results must be empty on init');
            const cols = db.all('PRAGMA table_info(eval_results)');
            const colNames = cols.map((c) => c.name).sort();
            assert.deepEqual(colNames, [
                'arm',
                'created_at',
                'explanation',
                'flow_name',
                'id',
                'metadata_json',
                'pass',
                'run_id',
                'scenario',
                'scorer_name',
                'value',
            ]);
            const indexes = db.all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='eval_results'");
            const indexNames = indexes.map((i) => i.name).sort();
            assert.ok(indexNames.includes('idx_eval_results_run'), 'run_id index required');
            assert.ok(indexNames.includes('idx_eval_results_flow'), 'flow_name index required');
            db.close();
        }
        finally {
            delete process.env['TMB_EVAL_MODE'];
        }
    });
    it('audit table has idx_audit_event_type and idx_audit_issue_branch indexes', () => {
        const db = tempDB();
        const indexes = db.all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit'");
        const names = indexes.map((i) => i.name);
        assert.ok(names.includes('idx_audit_event_type'), `idx_audit_event_type must exist, found: ${names.join(', ')}`);
        assert.ok(names.includes('idx_audit_issue_branch'), `idx_audit_issue_branch must exist, found: ${names.join(', ')}`);
        db.close();
    });
    it('plugin_meta has exactly 1 row after 10 sequential opens of the same file-backed DB (GL #23)', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'tmb-schema-test-'));
        try {
            const dbPath = join(tmpDir, 'trajectory.db');
            for (let i = 0; i < 10; i++) {
                const db = new TrajectoryDB(dbPath);
                db.close();
            }
            const db = new TrajectoryDB(dbPath);
            const row = db.get('SELECT COUNT(*) AS cnt FROM plugin_meta');
            assert.ok(row !== undefined);
            assert.equal(row.cnt, 1, 'plugin_meta must have exactly 1 row after 10 opens');
            db.close();
        }
        finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=schema.test.js.map