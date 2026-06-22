import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tempDB } from './helpers.js';
import { TrajectoryDB } from '../db.js';

describe('schema — current table set, default values, constraints', () => {
  it('fresh prod-mode DB contains the current table set (skills folded into cheatcodes, #101; world model in kuzu)', () => {
    const db = tempDB();

    const expectedTables = [
      'issues',
      'tasks',
      'audit',
      'validation_attempts',
      'agents',
      'roundtables',
      'roundtable_votes',
      'discussions',
      'plugin_meta',
      'plugin_config',
      'agent_runs',
      'pr_review_runs',
      'repos',
      // #155 repos-centric schema — milestones FK hub
      'milestones',
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
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%\_fts\_%' ESCAPE '\\' ORDER BY name",
    );
    const actualNames = rows.map((r) => r.name).sort();
    assert.deepEqual(actualNames, [...expectedTables].sort());

    db.close();
  });

  it('skills table is gone — folded into cheatcodes (v19, #101)', () => {
    const db = tempDB();

    const row = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='skills'",
    );
    assert.equal(row, undefined, 'skills table must be absent — unified into cheatcodes');

    db.close();
  });

  it('cheatcodes is the unified registry: origin/file_path/description cols + builtin tmb_* seed (v19, #101)', () => {
    const db = tempDB();

    const cols = db
      .all<{ name: string }>('PRAGMA table_info(cheatcodes)')
      .map((c) => c.name);
    for (const kept of ['name', 'kind', 'origin', 'description', 'file_path', 'scope', 'trust_tier', 'status', 'source_url', 'created_at', 'updated_at']) {
      assert.ok(cols.includes(kept), `cheatcodes.${kept} must exist`);
    }

    // The bundled tmb_* skills are seeded as origin='builtin' skill rows — the
    // seed set must match the 8 shipped skills/<name>/ dirs exactly (#102).
    const builtins = db.all<{ name: string; kind: string; file_path: string | null; source_url: string | null }>(
      `SELECT name, kind, file_path, source_url FROM cheatcodes WHERE origin = 'builtin' AND name LIKE 'tmb_%'`,
    );
    const names = builtins.map((b) => b.name).sort();
    assert.deepEqual(
      names,
      [
        'tmb_cheatcode',
        'tmb_comment-triage',
        'tmb_concerns-protocol',
        'tmb_docs-conventions',
        'tmb_planning',
        'tmb_push-gate',
        'tmb_recovery',
        'tmb_review',
        'tmb_skill-creator',
        'tmb_swe-checklist',
      ],
      'builtin-skill seed must equal the 10 shipped skills (tmb_push-triage split into tmb_push-gate + tmb_comment-triage)',
    );
    for (const b of builtins) {
      assert.equal(b.kind, 'skill', `${b.name} must be kind=skill`);
      assert.ok(b.file_path, `${b.name} must carry a file_path (skill CHECK)`);
      assert.equal(b.source_url, null, `${b.name} must have NULL source_url (builtin CHECK)`);
    }

    db.close();
  });

  it('cheatcodes CHECKs enforce the origin/kind shape (v19, #101)', () => {
    const db = tempDB();
    const now = '2026-01-01T00:00:00Z';

    // skill kind without file_path is rejected.
    assert.throws(() => {
      db.run(
        `INSERT INTO cheatcodes (name, kind, origin, source_url, installed_at) VALUES ('bad-skill', 'skill', 'external', 'https://x/y', ?)`,
        [now],
      );
    }, /CHECK/i);

    // a non-builtin (marketplace|external) without source_url is rejected.
    assert.throws(() => {
      db.run(
        `INSERT INTO cheatcodes (name, kind, origin, file_path, installed_at) VALUES ('bad-installed', 'plugin', 'external', NULL, ?)`,
        [now],
      );
    }, /CHECK/i);

    // the retired 'installed' origin is rejected by the provenance CHECK (#152).
    assert.throws(() => {
      db.run(
        `INSERT INTO cheatcodes (name, kind, origin, source_url, installed_at) VALUES ('bad-origin', 'plugin', 'installed', 'https://x/y', ?)`,
        [now],
      );
    }, /CHECK/i);

    // builtin with a source_url is rejected.
    assert.throws(() => {
      db.run(
        `INSERT INTO cheatcodes (name, kind, origin, file_path, source_url, installed_at) VALUES ('bad-builtin', 'skill', 'builtin', 'f.md', 'https://x/y', ?)`,
        [now],
      );
    }, /CHECK/i);

    db.close();
  });

  it('fresh DB has schema_version = 27 in plugin_meta', () => {
    const db = tempDB();

    const meta = db.get<{ schema_version: number; plugin_version: string }>(
      'SELECT schema_version, plugin_version FROM plugin_meta LIMIT 1',
    );
    assert.ok(meta !== undefined, 'plugin_meta must have a seed row');
    assert.equal(meta.schema_version, 27);
    assert.ok(
      typeof meta.plugin_version === 'string' && meta.plugin_version.length > 0,
      'plugin_version must be a non-empty string',
    );

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

  it('tasks table has prompt_bearing column with default 0', () => {
    const db = tempDB();

    const cols = db.all<{ name: string; type: string; notnull: number; dflt_value: string | null }>(
      'PRAGMA table_info(tasks)',
    );
    const col = cols.find((c) => c.name === 'prompt_bearing');
    assert.ok(col !== undefined, 'prompt_bearing column must exist in tasks');
    assert.equal(col.type.toUpperCase(), 'INTEGER', 'prompt_bearing must be INTEGER');
    assert.equal(col.notnull, 1, 'prompt_bearing must be NOT NULL');
    assert.equal(col.dflt_value, '0', 'prompt_bearing default must be 0');

    db.close();
  });

  it('tasks table has typed files + verification columns defaulting to empty JSON arrays (#673)', () => {
    const db = tempDB();

    const cols = db.all<{ name: string; type: string; notnull: number; dflt_value: string | null }>(
      'PRAGMA table_info(tasks)',
    );
    for (const name of ['files', 'verification']) {
      const col = cols.find((c) => c.name === name);
      assert.ok(col !== undefined, `${name} column must exist in tasks`);
      assert.equal(col.type.toUpperCase(), 'TEXT', `${name} must be TEXT`);
      assert.equal(col.notnull, 1, `${name} must be NOT NULL`);
      assert.equal(col.dflt_value, "'[]'", `${name} default must be an empty JSON array`);
    }

    db.close();
  });

  it('cheatcodes table has scope column NOT NULL DEFAULT project-local (#101)', () => {
    const db = tempDB();

    const cols = db.all<{ name: string; type: string; notnull: number; dflt_value: string | null }>(
      'PRAGMA table_info(cheatcodes)',
    );
    const col = cols.find((c) => c.name === 'scope');
    assert.ok(col !== undefined, 'scope column must exist in cheatcodes');
    assert.equal(col.type.toUpperCase(), 'TEXT', 'scope must be TEXT');
    assert.equal(col.notnull, 1, 'scope must be NOT NULL');
    assert.equal(col.dflt_value, "'project-local'", "scope default must be 'project-local'");

    db.close();
  });

  it('cheatcodes table has origin column NOT NULL DEFAULT external (#152)', () => {
    const db = tempDB();

    const cols = db.all<{ name: string; type: string; notnull: number; dflt_value: string | null }>(
      'PRAGMA table_info(cheatcodes)',
    );
    const col = cols.find((c) => c.name === 'origin');
    assert.ok(col !== undefined, 'origin column must exist in cheatcodes');
    assert.equal(col.type.toUpperCase(), 'TEXT', 'origin must be TEXT');
    assert.equal(col.notnull, 1, 'origin must be NOT NULL');
    assert.equal(col.dflt_value, "'external'", "origin default must be 'external'");

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

  it('validation_attempts has mcp_available INTEGER NOT NULL DEFAULT 1 (#157)', () => {
    const db = tempDB();

    const cols = db.all<{ name: string; type: string; notnull: number; dflt_value: string | null }>(
      'PRAGMA table_info(validation_attempts)',
    );
    const col = cols.find((c) => c.name === 'mcp_available');
    assert.ok(col !== undefined, 'mcp_available column must exist');
    assert.equal(col.type.toUpperCase(), 'INTEGER', 'mcp_available must be INTEGER');
    assert.equal(col.notnull, 1, 'mcp_available must be NOT NULL');
    assert.equal(col.dflt_value, '1', 'mcp_available default must be 1');

    db.close();
  });

  it('validation_attempts.feedback CHECK is gone — free prose is accepted (#157)', () => {
    const db = tempDB();

    const ddl = db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'validation_attempts'",
    );
    assert.ok(ddl !== undefined, 'validation_attempts DDL must be present');
    assert.ok(
      !/MCP available/.test(ddl.sql),
      'the MCP-availability feedback CHECK must be removed from validation_attempts',
    );

    db.close();
  });

  it('plugin_config has the 3 schema-seeded global keys on init (#980: repo-scoped keys live on repos)', () => {
    const db = tempDB();

    const rows = db.all<{ key: string; value_json: string }>(
      "SELECT key, value_json FROM plugin_config ORDER BY key",
    );
    // node:sqlite returns rows as null-prototype objects; map to plain objects
    // so assert.deepEqual matches the literal expected shape.
    const plain = rows.map((r) => ({ key: r.key, value_json: r.value_json }));
    assert.deepEqual(plain, [
      { key: 'issue_classification_labels', value_json: '["Bug","Feature","Improvement","Docs","Test","Chore"]' },
      { key: 'issue_priority_labels', value_json: '["Priority: Urgent","Priority: High","Priority: Medium","Priority: Low"]' },
      { key: 'issue_sync', value_json: '"off"' },
    ]);

    db.close();
  });


  it('directories table does NOT exist post-v8 (world model lives in kuzu — ADR 0002)', () => {
    const db = tempDB();

    const row = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='directories'",
    );
    assert.equal(row, undefined, 'directories table must be absent — world model moved to kuzu graph DB');

    db.close();
  });

  it('eval_results has the A/B columns (#131) on a fresh DB', () => {
    process.env['TMB_EVAL_MODE'] = '1';
    let db;
    try {
      db = tempDB();

      const cols = db.all<{ name: string; type: string; dflt_value: string | null; notnull: number }>(
        'PRAGMA table_info(eval_results)',
      );
      const byName = new Map(cols.map((c) => [c.name, c]));

      const arm = byName.get('arm');
      assert.ok(arm, 'arm column must exist');
      assert.equal(arm!.type, 'TEXT');
      assert.equal(arm!.notnull, 1, 'arm must be NOT NULL');
      assert.equal(arm!.dflt_value, "'control'", 'arm must default to control');

      const scenario = byName.get('scenario');
      assert.ok(scenario, 'scenario column must exist');
      assert.equal(scenario!.type, 'TEXT');
      assert.equal(scenario!.notnull, 0, 'scenario is nullable');

      db.close();
    } finally {
      delete process.env['TMB_EVAL_MODE'];
    }
  });

  it('last_verified_sha config key is NOT schema-seeded (#45 — initial null is correct)', () => {
    const db = tempDB();

    const row = db.get<{ value_json: string } | undefined>(
      "SELECT value_json FROM plugin_config WHERE key = 'last_verified_sha'",
    );
    assert.equal(row, undefined, 'last_verified_sha must start absent');

    db.close();
  });

  it('prod-mode DB does NOT have eval_results or debug_trajectory tables (#163)', () => {
    const db = tempDB();

    const evalTable = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='eval_results'",
    );
    assert.equal(evalTable, undefined, 'eval_results must be absent in prod mode');

    const debugTable = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='debug_trajectory'",
    );
    assert.equal(debugTable, undefined, 'debug_trajectory must be absent in prod mode');

    db.close();
  });

  it('eval-mode DB has eval_results + debug_trajectory when TMB_EVAL_MODE=1 (#163)', () => {
    process.env['TMB_EVAL_MODE'] = '1';
    let db;
    try {
      db = tempDB();

      const evalTable = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='eval_results'",
      );
      assert.ok(evalTable !== undefined, 'eval_results must be present in eval mode');

      const debugTable = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='debug_trajectory'",
      );
      assert.ok(debugTable !== undefined, 'debug_trajectory must be present in eval mode');

      db.close();
    } finally {
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
    } finally {
      delete process.env['TMB_EVAL_MODE'];
    }
  });

  it('debug_trajectory has expected columns + index (issue #108, extended for #110)', () => {
    process.env['TMB_EVAL_MODE'] = '1';
    let db;
    try {
      db = tempDB();

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
    } finally {
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

      const cols = db.all<{ name: string }>('PRAGMA table_info(eval_results)');
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

      const indexes = db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='eval_results'",
      );
      const indexNames = indexes.map((i) => i.name).sort();
      assert.ok(indexNames.includes('idx_eval_results_run'), 'run_id index required');
      assert.ok(indexNames.includes('idx_eval_results_flow'), 'flow_name index required');

      db.close();
    } finally {
      delete process.env['TMB_EVAL_MODE'];
    }
  });

  it('audit table has idx_audit_event_type and idx_audit_issue_branch indexes', () => {
    const db = tempDB();

    const indexes = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit'",
    );
    const names = indexes.map((i) => i.name);
    assert.ok(
      names.includes('idx_audit_event_type'),
      `idx_audit_event_type must exist, found: ${names.join(', ')}`,
    );
    assert.ok(
      names.includes('idx_audit_issue_branch'),
      `idx_audit_issue_branch must exist, found: ${names.join(', ')}`,
    );

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
      const row = db.get<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM plugin_meta');
      assert.ok(row !== undefined);
      assert.equal(row.cnt, 1, 'plugin_meta must have exactly 1 row after 10 opens');
      db.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});
