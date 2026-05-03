import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { TrajectoryDB } from '../db.js';
import { auditTools } from '../tools/audit.js';
import { issueTools } from '../tools/issues.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function call(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  name: string,
  args: Record<string, unknown>,
): Promise<RawResult> {
  return (await handlers[name]!(args)) as RawResult;
}

function parseResult(result: RawResult) {
  return JSON.parse(result.content[0].text);
}

async function createIssue(db: TrajectoryDB): Promise<number> {
  const tools = issueTools(db);
  const result = await call(tools.handlers, 'issue_create', {
    agent: 'bro',
    objective: 'Audit merge test issue',
  });
  const data = parseResult(result);
  return data.id as number;
}

function buildOldSchemaDb(dbPath: string): void {
  const sql = `
PRAGMA foreign_keys = OFF;
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS issues (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_issue_id INTEGER, objective TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', pre_commit_hash TEXT NOT NULL DEFAULT '', post_commit_hash TEXT, status TEXT NOT NULL DEFAULT 'open', current_task_id INTEGER, labels TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT, remote_iid INTEGER, remote_kind TEXT, remote_synced_at DATETIME);
CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL, branch_id TEXT NOT NULL, parent_branch_id TEXT, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL, tools_required TEXT NOT NULL DEFAULT '[]', skills_required TEXT NOT NULL DEFAULT '[]', success_criteria TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, spec_body TEXT NOT NULL DEFAULT '', commit_sha TEXT, repo TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL, branch_id TEXT, from_node TEXT NOT NULL, event_type TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '{}', is_truncated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL, branch_id TEXT, from_node TEXT NOT NULL DEFAULT 'executor', round INTEGER NOT NULL DEFAULT 0, tool_name TEXT NOT NULL, tool_args TEXT NOT NULL DEFAULT '{}', output TEXT NOT NULL DEFAULT '', output_chars INTEGER NOT NULL DEFAULT 0, is_truncated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS validation_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, attempt_n INTEGER NOT NULL, agent TEXT NOT NULL DEFAULT '', verdict TEXT NOT NULL, feedback TEXT NOT NULL DEFAULT '', subagent_session_id TEXT, created_at TEXT NOT NULL, UNIQUE(task_id, attempt_n));
CREATE TABLE IF NOT EXISTS discussions (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'note', body TEXT NOT NULL, created_at TEXT NOT NULL, verified_human INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS plugin_meta (id INTEGER PRIMARY KEY AUTOINCREMENT, schema_version INTEGER NOT NULL, plugin_version TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
INSERT INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 1, '0.0.0');
CREATE TABLE IF NOT EXISTS plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
INSERT OR IGNORE INTO plugin_config (key, value_json, updated_at) VALUES ('branching_model', '"github-flow"', datetime('now')), ('pr_target', '"main"', datetime('now')), ('protected_branches', '["main"]', datetime('now')), ('remotes', '[]', datetime('now')), ('issue_sync', '"off"', datetime('now'));
CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK (id = 1), human_name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS regen_state (target TEXT PRIMARY KEY, last_regen_at TEXT, last_seen_sha TEXT, notes TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS file_registry (path TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'unknown', language TEXT, size_bytes INTEGER, last_commit_sha TEXT, last_change_type TEXT, last_change_at TEXT, imports_json TEXT NOT NULL DEFAULT '[]', exports_json TEXT NOT NULL DEFAULT '[]', metadata_json TEXT NOT NULL DEFAULT '{}', content_md5 TEXT, summary TEXT, summary_updated_at TEXT);
CREATE TABLE IF NOT EXISTS skills (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, file_path TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', created_by TEXT NOT NULL DEFAULT 'system', trust_tier TEXT NOT NULL DEFAULT 'curated', status TEXT NOT NULL DEFAULT 'active', when_to_use TEXT NOT NULL DEFAULT '', when_not_to_use TEXT NOT NULL DEFAULT '', uses INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, effectiveness REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roundtables (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL, topic TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', outcome TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, closed_at TEXT, state TEXT NOT NULL DEFAULT 'collecting', expected_participants INTEGER, ratification_received_at TEXT);
CREATE TABLE IF NOT EXISTS roundtable_votes (id INTEGER PRIMARY KEY AUTOINCREMENT, roundtable_id INTEGER NOT NULL, agent TEXT NOT NULL, participant TEXT, vote TEXT NOT NULL, rationale TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, issue_id INTEGER, agent_type TEXT NOT NULL, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, tokens_total INTEGER NOT NULL DEFAULT 0, tool_uses INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, started_at TEXT, completed_at TEXT NOT NULL, exit_status TEXT NOT NULL DEFAULT 'completed');
CREATE TABLE IF NOT EXISTS pr_review_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, pr_number INTEGER NOT NULL, repo TEXT NOT NULL, remote_kind TEXT NOT NULL, last_fetched_at DATETIME NOT NULL, last_comment_id TEXT, comments_processed INTEGER NOT NULL DEFAULT 0, tasks_created INTEGER NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT (datetime('now')));
INSERT INTO issues (id, objective, created_at, updated_at) VALUES (1, 'Migration test issue', datetime('now'), datetime('now'));
INSERT INTO ledger (issue_id, branch_id, from_node, event_type, summary, content, created_at) VALUES (1, 'feat/x', 'bro', 'planning_complete', 'Plan done', '{"detail":"ctx"}', datetime('now')), (1, 'feat/x', 'swe', 'task_started', 'SWE started', '{}', datetime('now')), (1, NULL, 'bro', 'bro_verification_pass', 'V1 pass', '{}', datetime('now'));
INSERT INTO audit (issue_id, branch_id, from_node, round, tool_name, tool_args, output, output_chars, created_at) VALUES (1, 'feat/x', 'executor', 0, 'Bash', '{}', 'ok', 2, datetime('now')), (1, 'feat/x', 'executor', 1, 'Read', '{}', 'file contents', 13, datetime('now'));
`;
  const result = spawnSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Failed to build old-schema DB: ${result.stderr}`);
  }
}

describe('migrateLedgerIntoAudit', () => {
  it('ledger table is dropped after migration', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tmb-migration-'));
    const dbPath = join(tmpDir, 'test.db');
    buildOldSchemaDb(dbPath);

    const tdb = new TrajectoryDB(dbPath);

    const ledgerRow = tdb.get<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='ledger'`,
    );
    assert.equal(ledgerRow, undefined, 'ledger table should be dropped after migration');

    tdb.close();
    unlinkSync(dbPath);
  });

  it('ledger rows migrated into audit with kind=event', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tmb-migration-'));
    const dbPath = join(tmpDir, 'test.db');
    buildOldSchemaDb(dbPath);

    const tdb = new TrajectoryDB(dbPath);

    const eventRows = tdb.all<{ kind: string; event_type: string; from_node: string }>(
      `SELECT kind, event_type, from_node FROM audit WHERE kind = 'event' ORDER BY id ASC`,
    );
    assert.equal(eventRows.length, 3, '3 ledger rows should have been migrated as kind=event');
    assert.equal(eventRows[0].event_type, 'planning_complete');
    assert.equal(eventRows[1].event_type, 'task_started');
    assert.equal(eventRows[2].event_type, 'bro_verification_pass');

    tdb.close();
    unlinkSync(dbPath);
  });

  it('pre-existing audit rows preserved as kind=tool_call after migration', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tmb-migration-'));
    const dbPath = join(tmpDir, 'test.db');
    buildOldSchemaDb(dbPath);

    const tdb = new TrajectoryDB(dbPath);

    const toolCallRows = tdb.all<{ kind: string; tool_name: string }>(
      `SELECT kind, tool_name FROM audit WHERE kind = 'tool_call' ORDER BY id ASC`,
    );
    assert.equal(toolCallRows.length, 2, '2 original audit rows should have kind=tool_call');
    assert.equal(toolCallRows[0].tool_name, 'Bash');
    assert.equal(toolCallRows[1].tool_name, 'Read');

    tdb.close();
    unlinkSync(dbPath);
  });

  it('total audit row count equals sum of old ledger + old audit', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tmb-migration-'));
    const dbPath = join(tmpDir, 'test.db');
    buildOldSchemaDb(dbPath);

    const tdb = new TrajectoryDB(dbPath);

    const total = tdb.get<{ c: number }>('SELECT COUNT(*) as c FROM audit');
    assert.equal(total?.c, 5, 'total = 3 ledger + 2 audit rows');

    tdb.close();
    unlinkSync(dbPath);
  });

  it('migration is idempotent on fresh DB (no ledger table present)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tmb-migration-'));
    const dbPath = join(tmpDir, 'test.db');

    const tdb1 = new TrajectoryDB(dbPath);
    tdb1.close();

    assert.doesNotThrow(() => {
      const tdb2 = new TrajectoryDB(dbPath);
      tdb2.close();
    }, 'opening an already-migrated DB should not throw');

    unlinkSync(dbPath);
  });
});

describe('auditTools — kind discriminator', () => {
  it('audit_log with kind=event stores event fields', async () => {
    const db = new TrajectoryDB(':memory:');
    const issueId = await createIssue(db);
    const tools = auditTools(db);

    const result = await call(tools.handlers, 'audit_log', {
      agent: 'bro',
      issue_id: String(issueId),
      from_node: 'bro',
      kind: 'event',
      event_type: 'planning_complete',
      summary: 'Plan done',
      content_json: JSON.stringify({ detail: 'ctx' }),
    });

    const row = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(row)}`);
    assert.equal(row.kind, 'event');
    assert.equal(row.event_type, 'planning_complete');
    assert.equal(row.summary, 'Plan done');
    assert.equal(row.tool_name, '');

    db.close();
  });

  it('audit_log with kind=tool_call stores tool-call fields', async () => {
    const db = new TrajectoryDB(':memory:');
    const issueId = await createIssue(db);
    const tools = auditTools(db);

    const result = await call(tools.handlers, 'audit_log', {
      agent: 'swe',
      issue_id: String(issueId),
      from_node: 'executor',
      kind: 'tool_call',
      tool_name: 'Bash',
      tool_args: { cmd: 'echo hi' },
      output: 'hi',
    });

    const row = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(row)}`);
    assert.equal(row.kind, 'tool_call');
    assert.equal(row.tool_name, 'Bash');
    assert.equal(row.output, 'hi');
    assert.equal(row.event_type, null);

    db.close();
  });

  it('audit_log defaults kind to event when omitted', async () => {
    const db = new TrajectoryDB(':memory:');
    const issueId = await createIssue(db);
    const tools = auditTools(db);

    const result = await call(tools.handlers, 'audit_log', {
      agent: 'bro',
      issue_id: String(issueId),
      from_node: 'bro',
      event_type: 'bro_verification_pass',
      summary: 'V1 pass',
    });

    const row = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(row)}`);
    assert.equal(row.kind, 'event');

    db.close();
  });

  it('audit_log kind=event rejects missing event_type', async () => {
    const db = new TrajectoryDB(':memory:');
    const issueId = await createIssue(db);
    const tools = auditTools(db);

    const result = await call(tools.handlers, 'audit_log', {
      agent: 'bro',
      issue_id: String(issueId),
      from_node: 'bro',
      kind: 'event',
      summary: 'missing event_type',
    });

    assert.ok(result.isError, 'Expected error when event_type is missing');

    db.close();
  });

  it('audit_log kind=tool_call rejects missing tool_name', async () => {
    const db = new TrajectoryDB(':memory:');
    const issueId = await createIssue(db);
    const tools = auditTools(db);

    const result = await call(tools.handlers, 'audit_log', {
      agent: 'swe',
      issue_id: String(issueId),
      from_node: 'executor',
      kind: 'tool_call',
      tool_args: {},
      output: 'ok',
    });

    assert.ok(result.isError, 'Expected error when tool_name is missing');

    db.close();
  });
});

describe('audit_log_list', () => {
  it('returns all rows when no kind filter', async () => {
    const db = new TrajectoryDB(':memory:');
    const issueId = await createIssue(db);
    const tools = auditTools(db);

    await call(tools.handlers, 'audit_log', {
      agent: 'bro', issue_id: String(issueId), from_node: 'bro',
      kind: 'event', event_type: 'planning_complete', summary: 'Plan done',
    });
    await call(tools.handlers, 'audit_log', {
      agent: 'swe', issue_id: String(issueId), from_node: 'executor',
      kind: 'tool_call', tool_name: 'Bash', tool_args: {}, output: 'ok',
    });

    const result = await call(tools.handlers, 'audit_log_list', {
      agent: 'bro',
      issue_id: String(issueId),
    });

    const rows = parseResult(result);
    assert.ok(!result.isError);
    assert.equal(rows.length, 2);

    db.close();
  });

  it('filters by kind=event', async () => {
    const db = new TrajectoryDB(':memory:');
    const issueId = await createIssue(db);
    const tools = auditTools(db);

    await call(tools.handlers, 'audit_log', {
      agent: 'bro', issue_id: String(issueId), from_node: 'bro',
      kind: 'event', event_type: 'planning_complete', summary: 'Plan done',
    });
    await call(tools.handlers, 'audit_log', {
      agent: 'bro', issue_id: String(issueId), from_node: 'bro',
      kind: 'event', event_type: 'task_started', summary: 'SWE started',
    });
    await call(tools.handlers, 'audit_log', {
      agent: 'swe', issue_id: String(issueId), from_node: 'executor',
      kind: 'tool_call', tool_name: 'Bash', tool_args: {}, output: 'ok',
    });

    const result = await call(tools.handlers, 'audit_log_list', {
      agent: 'bro',
      issue_id: String(issueId),
      kind: 'event',
    });

    const rows = parseResult(result);
    assert.ok(!result.isError);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r: { kind: string }) => r.kind === 'event'));

    db.close();
  });

  it('filters by kind=tool_call', async () => {
    const db = new TrajectoryDB(':memory:');
    const issueId = await createIssue(db);
    const tools = auditTools(db);

    await call(tools.handlers, 'audit_log', {
      agent: 'bro', issue_id: String(issueId), from_node: 'bro',
      kind: 'event', event_type: 'planning_complete', summary: 'done',
    });
    await call(tools.handlers, 'audit_log', {
      agent: 'swe', issue_id: String(issueId), from_node: 'executor',
      kind: 'tool_call', tool_name: 'Bash', tool_args: {}, output: 'ok',
    });

    const result = await call(tools.handlers, 'audit_log_list', {
      agent: 'bro',
      issue_id: String(issueId),
      kind: 'tool_call',
    });

    const rows = parseResult(result);
    assert.ok(!result.isError);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'tool_call');

    db.close();
  });

  it('paginates with limit and offset', async () => {
    const db = new TrajectoryDB(':memory:');
    const issueId = await createIssue(db);
    const tools = auditTools(db);

    for (let i = 0; i < 5; i++) {
      await call(tools.handlers, 'audit_log', {
        agent: 'bro', issue_id: String(issueId), from_node: 'bro',
        kind: 'event', event_type: 'step', summary: `Step ${i}`,
      });
    }

    const page1Result = await call(tools.handlers, 'audit_log_list', {
      agent: 'bro', issue_id: String(issueId), kind: 'event', limit: 2, offset: 0,
    });
    const page1 = parseResult(page1Result);
    assert.equal(page1.length, 2);
    assert.equal(page1[0].summary, 'Step 0');
    assert.equal(page1[1].summary, 'Step 1');

    const page2Result = await call(tools.handlers, 'audit_log_list', {
      agent: 'bro', issue_id: String(issueId), kind: 'event', limit: 2, offset: 2,
    });
    const page2 = parseResult(page2Result);
    assert.equal(page2.length, 2);
    assert.equal(page2[0].summary, 'Step 2');
    assert.equal(page2[1].summary, 'Step 3');

    db.close();
  });

  it('filters by branch_id', async () => {
    const db = new TrajectoryDB(':memory:');
    const issueId = await createIssue(db);
    const tools = auditTools(db);

    await call(tools.handlers, 'audit_log', {
      agent: 'bro', issue_id: String(issueId), branch_id: 'feat/a', from_node: 'bro',
      kind: 'event', event_type: 'start', summary: 'Branch A entry',
    });
    await call(tools.handlers, 'audit_log', {
      agent: 'bro', issue_id: String(issueId), branch_id: 'feat/b', from_node: 'bro',
      kind: 'event', event_type: 'start', summary: 'Branch B entry',
    });

    const result = await call(tools.handlers, 'audit_log_list', {
      agent: 'bro', issue_id: String(issueId), branch_id: 'feat/a',
    });
    const rows = parseResult(result);
    assert.ok(!result.isError);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].summary, 'Branch A entry');

    db.close();
  });

  it('oversized content_json is truncated and is_truncated=1', async () => {
    const db = new TrajectoryDB(':memory:');
    const issueId = await createIssue(db);
    const tools = auditTools(db);

    const bigContent = JSON.stringify({ data: 'x'.repeat(1_100_000) });

    const result = await call(tools.handlers, 'audit_log', {
      agent: 'bro', issue_id: String(issueId), from_node: 'bro',
      kind: 'event', event_type: 'large_event', summary: 'Oversized',
      content_json: bigContent,
    });
    const row = parseResult(result);
    assert.ok(!result.isError, `Expected no error: ${JSON.stringify(row)}`);
    assert.equal(row.is_truncated, 1, 'is_truncated should be 1 for oversized content');
    assert.ok(
      Buffer.byteLength(row.content_json, 'utf8') <= 1_000_000,
      'content_json should be truncated to <= 1 MB',
    );

    db.close();
  });
});
