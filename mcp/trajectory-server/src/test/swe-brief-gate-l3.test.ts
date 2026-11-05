/**
 * The swe-brief-gate l3 bash suite in node:test (GH 1692): the gate runs as
 * `node dist/hooks.js swe-brief-gate`, CLAUDE_PROJECT_DIR pinned to the
 * sandbox and PWD set. An swe must call task_brief before any other
 * trajectory-server tool, Edit, Write or MultiEdit; the task_brief handler
 * writes the sentinel, so these cases seed it with SQL in the handler's shape.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { makeSandbox, runGate, type Sandbox } from './hook-sandbox.js';
import { DENY, gateEnv, has, hasNot, sql } from './git-push-guard-l3.js';

const TOOL = (name: string) => `mcp__tmb__trajectory-server__${name}`;

describe('swe-brief-gate l3', () => {
  let sb: Sandbox;
  let db: string;

  function q(statement: string, ...params: SQLInputValue[]): string {
    const d = new DatabaseSync(db);
    try {
      const row = d.prepare(statement).get(...params) as Record<string, unknown> | undefined;
      return row === undefined ? '' : String(Object.values(row)[0]);
    } finally {
      d.close();
    }
  }

  function makeTranscript(task: number): string {
    const tf = join(sb.dir, `transcript_${task}.jsonl`);
    writeFileSync(tf, `${JSON.stringify({ message: { content: [{ type: 'text', text: `task_id=${task} worktree: /some/path` }] } })}\n`);
    return tf;
  }

  function seedSentinel(task: number): void {
    sql(
      db,
      `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, repo, created_at)
         VALUES (1, NULL, 'swe', 'swe_brief_fetched', ?, ?, NULL, datetime('now'))`,
      `SWE fetched task_brief for task_id=${task}`,
      JSON.stringify({ task_id: task, agent_type: 'swe' }),
    );
  }

  const sentinelCount = (task: number) =>
    q("SELECT COUNT(*) FROM audit WHERE event_type='swe_brief_fetched' AND json_extract(content_json, '$.task_id') = ?", task);

  /** The gate's stdout + stderr (a `2>&1`) for <input>, run from <cwd>. */
  function runHook(input: object, opts: { cwd?: string; db?: string } = {}): string {
    const cwd = opts.cwd ?? sb.dir;
    const r = runGate('swe-brief-gate', { cwd, input: JSON.stringify(input), env: { ...gateEnv(sb, cwd), TRAJECTORY_DB_PATH: opts.db ?? db } });
    return r.stdout + r.stderr;
  }

  const call = (agent: string, tool: string, task: number, toolInput: object = {}) => ({
    agent_type: agent,
    tool_name: tool,
    agent_transcript_path: makeTranscript(task),
    tool_input: toolInput,
  });

  const insertTask = (id: number, branch: string, spec = 'spec') => sql(db, "INSERT OR IGNORE INTO tasks VALUES (?, 1, ?, 'pending', ?)", id, branch, spec);

  before(() => {
    sb = makeSandbox('swe-brief-gate');
    db = join(sb.dir, 'trajectory.db');
    const d = new DatabaseSync(db);
    try {
      d.exec(`
        CREATE TABLE issues (
          id INTEGER PRIMARY KEY,
          objective TEXT NOT NULL DEFAULT 'test',
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          repo TEXT
        );
        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY,
          issue_id INTEGER NOT NULL REFERENCES issues(id),
          branch_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          spec_body TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id INTEGER NOT NULL,
          branch_id TEXT,
          from_node TEXT NOT NULL DEFAULT 'swe',
          event_type TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          content_json TEXT NOT NULL DEFAULT '{}',
          repo TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO issues VALUES (1, 'test', '', 'open', datetime('now'), datetime('now'), NULL);
        INSERT INTO tasks VALUES (10, 1, 'feat/my-feature', 'pending', 'spec here');
      `);
    } finally {
      d.close();
    }
  });
  after(() => sb.remove());

  it('non-SWE caller (bro): any tool allowed without sentinel', () => {
    assert.equal(runHook(call('bro', TOOL('task_get'), 10)), '', 'bro should pass through silently');
  });

  it('SWE caller: task_brief call passes through and writes nothing', () => {
    assert.equal(runHook(call('swe', TOOL('task_brief'), 10)), '', 'task_brief should pass through silently');
    assert.equal(sentinelCount(10), '0', 'the hook must not write a sentinel row');
    seedSentinel(10);
  });

  it('SWE caller: any tool allowed after sentinel exists', () => {
    assert.equal(runHook(call('swe', TOOL('task_update_status'), 10, { task_id: '10' })), '', 'tool after sentinel should pass through silently');
  });

  it('SWE caller: non-task_brief tool DENIED when no sentinel (new task)', () => {
    insertTask(20, 'feat/new-task');
    const out = runHook(call('swe', TOOL('task_update_status'), 20, { task_id: '20' }));
    has(out, DENY, 'should deny without sentinel');
    has(out, 'task_brief', 'deny reason should mention task_brief');
    has(out, '20', 'deny reason should mention the task_id');
  });

  it('SWE caller with tmb: prefix: denied without sentinel', () => {
    insertTask(30, 'feat/prefixed');
    has(runHook(call('tmb:swe', TOOL('task_get'), 30)), DENY, 'tmb:swe prefix should also be denied without sentinel');
  });

  it('SWE caller with tmb: prefix: task_brief passes through and writes nothing', () => {
    assert.equal(runHook(call('tmb:swe', TOOL('task_brief'), 30)), '', 'task_brief with tmb: prefix should be allowed');
    assert.equal(sentinelCount(30), '0', 'the hook must not write a sentinel row for task 30');
  });

  it('SWE caller: repeated task_brief call leaves the seeded sentinel as the only row', () => {
    runHook(call('swe', TOOL('task_brief'), 10));
    assert.equal(sentinelCount(10), '1', 'task_brief through the hook must not add a sentinel row');
  });

  it('No DB: hook allows any SWE tool call silently', () => {
    const out = runHook({ agent_type: 'swe', tool_name: TOOL('task_update_status'), tool_input: { task_id: '99' } }, { db: join(sb.dir, 'nonexistent.db') });
    hasNot(out, DENY, 'no DB should allow all calls');
  });

  it('No task_id in transcript or tool_input: hook allows', () => {
    hasNot(runHook({ agent_type: 'swe', tool_name: TOOL('task_update_status'), tool_input: {} }), DENY, 'no task_id should allow');
  });

  it('bro context: task_update_status not denied even without sentinel', () => {
    insertTask(40, 'feat/bro-task');
    assert.equal(runHook(call('bro', TOOL('task_update_status'), 40, { task_id: '40' })), '', 'bro should never be denied by brief gate');
  });

  describe('injection', () => {
    let auditBefore: string;
    before(() => {
      auditBefore = q('SELECT COUNT(*) FROM audit');
    });

    it("Injection: task_id='1; DROP TABLE tasks;--' treated as missing (no SQL error, no row)", () => {
      const out = runHook({ agent_type: 'swe', tool_name: TOOL('task_update_status'), tool_input: { task_id: '1; DROP TABLE tasks;--' } });
      hasNot(out, DENY, 'injected task_id should be treated as missing (allow)');
      hasNot(out, 'Error', 'injected task_id should not surface a SQL error');
      assert.equal(q("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'"), 'tasks', 'tasks table must survive injection attempt');
      assert.equal(q('SELECT COUNT(*) FROM audit'), auditBefore, 'no audit row should be written for injected task_id');
    });

    it('Injection: task_brief with injected task_id passes through and writes nothing', () => {
      const out = runHook({ agent_type: 'swe', tool_name: TOOL('task_brief'), tool_input: { task_id: '1; DROP TABLE tasks;--' } });
      assert.equal(out, '', 'injected task_brief should pass through silently');
      assert.equal(q('SELECT COUNT(*) FROM audit'), auditBefore, 'injected task_brief should not write a sentinel row');
    });
  });

  it('SWE caller: Edit DENIED pre-brief with teaching message', () => {
    insertTask(50, 'feat/edit-deny');
    const out = runHook(call('swe', 'Edit', 50));
    has(out, DENY, 'Edit should be denied pre-brief');
    has(out, 'task_brief', 'deny reason must mention task_brief recovery');
    has(out, '50', 'deny reason must mention the task_id');
  });

  it('SWE caller: Write DENIED pre-brief with teaching message', () => {
    const out = runHook(call('swe', 'Write', 50));
    has(out, DENY, 'Write should be denied pre-brief');
    has(out, 'task_brief', 'deny reason must mention task_brief recovery');
  });

  it('SWE caller: MultiEdit pre-brief — denied with the Edit text', () => {
    const out = runHook(call('swe', 'MultiEdit', 50, { edits: [] }));
    has(out, DENY, 'MultiEdit should be denied pre-brief');
    has(
      out,
      "BLOCKED: SWE must call task_brief(agent='swe', task_id=50) before MultiEdit. task_brief delivers the spec",
      'MultiEdit gets the Edit deny text',
    );
  });

  it('SWE caller: Read allowed pre-brief (read-only exploration is legitimate)', () => {
    hasNot(runHook(call('swe', 'Read', 50)), DENY, 'Read must be allowed pre-brief');
  });

  it('SWE caller: Bash allowed pre-brief (exploration, no worktree mutation)', () => {
    hasNot(runHook(call('swe', 'Bash', 50)), DENY, 'Bash must be allowed pre-brief');
  });

  it('SWE caller: Edit allowed after brief sentinel exists', () => {
    runHook(call('swe', TOOL('task_brief'), 50));
    seedSentinel(50);
    hasNot(runHook(call('swe', 'Edit', 50)), DENY, 'Edit must be allowed after task_brief');
    assert.equal(runHook(call('swe', 'MultiEdit', 50, { edits: [] })), '', 'MultiEdit must be allowed after task_brief');
  });

  describe('GH 1550: identity is the spawn transcript, never the cwd', () => {
    let fakeWt: string;
    /** The subagent transcript beside the session transcript: <transcript_path minus .jsonl>/subagents/agent-<agent_id>.jsonl. */
    const subInput = (tool: string) => ({ agent_type: 'swe', agent_id: 'sub70', transcript_path: join(sb.dir, 'session.jsonl'), tool_name: tool, tool_input: {} });

    before(() => {
      insertTask(70, 'fix/slug-task');
      fakeWt = join(sb.dir, '.claude/worktrees/slug-task');
      mkdirSync(fakeWt, { recursive: true });
      mkdirSync(join(sb.dir, 'session/subagents'), { recursive: true });
      writeFileSync(join(sb.dir, 'session/subagents/agent-sub70.jsonl'), `${JSON.stringify({ message: { content: [{ type: 'text', text: 'task_id=70' }] } })}\n`);
    });

    it("GH 1550: no transcript, shell inside a task's worktree → the cwd resolves nothing", () => {
      const out = runHook({ agent_type: 'swe', tool_name: TOOL('task_update_status'), tool_input: {} }, { cwd: fakeWt });
      assert.equal(out, '', 'a cwd inside a worktree is not identity');
    });

    it('Subagents transcript: no agent_transcript_path → gate evaluates (denies)', () => {
      const out = runHook(subInput(TOOL('task_update_status')));
      has(out, DENY, 'the subagents transcript resolves the task');
      has(out, 'task_brief', 'deny reason must mention task_brief');
    });

    it('Subagents transcript: task_brief passes through and writes nothing', () => {
      assert.equal(runHook(subInput(TOOL('task_brief'))), '', 'task_brief should be allowed');
      assert.equal(sentinelCount(70), '0', 'the hook must not write a sentinel row');
      seedSentinel(70);
    });

    it('Subagents transcript: after sentinel exists, tool allowed', () => {
      hasNot(runHook(subInput(TOOL('task_update_status'))), DENY, 'tool allowed after the sentinel');
    });
  });

  it('bro caller: Edit never denied (gate must not affect bro)', () => {
    insertTask(60, 'feat/bro-edit');
    assert.equal(runHook(call('bro', 'Edit', 60)), '', 'bro Edit must never be denied by brief gate');
  });
});
