/**
 * Unit tests of the TypeScript swe-run gates (GH 1692): swe-brief-gate,
 * swe-spawn-bind, swe-spawn-rollback and post-task-create-spawn-hint. They
 * cover each allow, deny, hint and DB-write branch, the jq and bash read
 * semantics the parity corpus leans on, and the divergences from the .sh that
 * decision 703 allows: every gate here runs on a PATH holding neither jq nor
 * the sqlite3 CLI, where each .sh exits 0 untouched.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findGate, gateNames } from '../hooks/registry.js';
import { commandOnPath } from '../hooks/lib/persona.js';
import { briefSurface, denyReason, rawOrEmpty, resumeJson, sweBriefGate } from '../hooks/swe-brief-gate.js';
import { bindSql, joinedFields, readTwo, sweSpawnBind } from '../hooks/swe-spawn-bind.js';
import { rollbackSql, sweSpawnRollback, toolUseId } from '../hooks/swe-spawn-rollback.js';
import { hintReason, postTaskCreateSpawnHint, readTabFields, taskList, taskRows } from '../hooks/post-task-create-spawn-hint.js';
import { buildSandbox } from './hooks-swe-run-parity.suite.js';

const ALLOWED = { stdout: '', code: 0 };
const GATES = ['swe-brief-gate', 'swe-spawn-bind', 'swe-spawn-rollback', 'post-task-create-spawn-hint'];

function deny(stdout: string): string {
  assert.ok(stdout.endsWith('\n'));
  const out = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

function hint(stdout: string): string {
  assert.ok(stdout.endsWith('\n'));
  const out = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  return out.hookSpecificOutput.additionalContext;
}

describe('swe-run gates are registered', () => {
  for (const name of GATES) {
    it(`${name} is a gate dist/hooks-gates.txt lists`, () => {
      assert.ok(findGate(name));
      assert.ok(gateNames().includes(name));
    });
  }
  it('maps each name to its gate', () => {
    assert.equal(findGate('swe-brief-gate'), sweBriefGate);
    assert.equal(findGate('swe-spawn-bind'), sweSpawnBind);
    assert.equal(findGate('swe-spawn-rollback'), sweSpawnRollback);
    assert.equal(findGate('post-task-create-spawn-hint'), postTaskCreateSpawnHint);
  });
});

describe('swe-run gate helpers', () => {
  it('briefSurface keeps the .sh allowlist: Edit, Write and NotebookEdit, not MultiEdit', () => {
    assert.equal(briefSurface('mcp__plugin_tmb_trajectory-server__task_brief'), 'task_brief');
    assert.equal(briefSurface('Edit'), 'mutation');
    assert.equal(briefSurface('Write'), 'mutation');
    assert.equal(briefSurface('NotebookEdit'), 'mutation');
    assert.equal(briefSurface('MultiEdit'), 'other');
    assert.equal(briefSurface('mcp__tmb__trajectory-server__task_get'), 'trajectory');
    assert.equal(briefSurface('mcp__other-server__task_get'), 'other');
    assert.equal(briefSurface('Bash'), 'other');
  });
  it('rawOrEmpty prints numbers as their literals and nothing for null or false', () => {
    assert.equal(rawOrEmpty('{"tool_input":{"task_id":11.0}}\n', ['tool_input', 'task_id']), '11.0');
    assert.equal(rawOrEmpty('{"tool_input":{"task_id":null}}\n', ['tool_input', 'task_id']), '');
    assert.equal(rawOrEmpty('{"tool_input":{"task_id":false}}\n', ['tool_input', 'task_id']), '');
  });
  it('resumeJson writes the task id as jq --argjson does', () => {
    assert.equal(resumeJson('012', 'agent-a', 'T'), '{"task_id":12,"agent_id":"agent-a","observed_at":"T","consumed":0}');
  });
  it('joinedFields mirrors jq: tostring each, null on an indexing error or a parse error', () => {
    assert.equal(joinedFields('{"a":"x","b":{"c":7}}', ['a'], ['b', 'c']), 'x\x1f7');
    assert.equal(joinedFields('{"b":{"c":1.50}}', ['a'], ['b', 'c']), '\x1f1.50');
    assert.equal(joinedFields('{"a":"x","b":"s"}', ['a'], ['b', 'c']), null);
    assert.equal(joinedFields('{"a":"x"', ['a'], ['b']), null);
  });
  it('readTwo reads the first line, the last field keeping the rest but one trailing separator', () => {
    assert.deepEqual(readTwo('a\x1fb\nc\x1fd', '\x1f'), ['a', 'b']);
    assert.deepEqual(readTwo('a\x1fb\x1f', '\x1f'), ['a', 'b']);
    assert.deepEqual(readTwo('a\x1fb\x1fc', '\x1f'), ['a', 'b\x1fc']);
    assert.deepEqual(readTwo('a', '\x1f'), ['a', '']);
  });
  it('quotes ids into the bind and rollback SQL', () => {
    assert.ok(bindSql("t'1", "a'g").includes("spawn_id = 'tool_use:t''1'"));
    assert.ok(bindSql("t'1", "a'g").includes("SET spawn_id = 'a''g'"));
    assert.ok(rollbackSql("t'1", 'NOW').includes("spawn_id = 'tool_use:t''1'"));
  });
  it('toolUseId is null when jq would fail and keeps number literals', () => {
    assert.equal(toolUseId('{"tool_use_id":"toolu_1"}'), 'toolu_1');
    assert.equal(toolUseId('{"tool_use_id":1e2}'), '1E+2');
    assert.equal(toolUseId('{"tool_use_id":"toolu_1"} {'), null);
    assert.equal(toolUseId('"text"'), null);
    assert.equal(toolUseId('{}'), '');
  });
  it('taskList and taskRows read the task array as jq does', () => {
    const text = '[{"id":11,"branch_id":"feat/a"},{"id":"12","branch_id":null}]';
    assert.equal(taskList(text), '  - task_id=11 branch_id=feat/a\n  - task_id=12 branch_id=null');
    assert.deepEqual(taskRows(text), ['11\tfeat/a', '12\tnull']);
    assert.equal(taskList('{"error":"x"}'), '');
    assert.equal(taskList('[1]'), '');
    assert.deepEqual(taskRows('[{"id":1,"branch_id":"b"},2,{"id":3,"branch_id":"c"}]'), ['1\tb']);
  });
  it('readTabFields collapses and trims tab runs as IFS whitespace', () => {
    assert.deepEqual(readTabFields('\t11\t\tfeat/a\t'), ['11', 'feat/a']);
    assert.deepEqual(readTabFields('11'), ['11', '']);
  });
  it('hintReason names the tool after its last __', () => {
    assert.ok(hintReason('mcp__plugin_tmb_trajectory-server__task_create_batch', 'X').startsWith('🚀 SWE-spawn hint: task_create_batch created the following tasks.'));
  });
});

describe('swe-run gates without jq or the sqlite3 CLI (decision 703)', () => {
  let base: string;
  let s: string;
  let emptyBin: string;
  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-swe-run-gates-')));
    s = join(base, 'sandbox');
    emptyBin = join(base, 'empty-bin');
    mkdirSync(emptyBin);
  });
  beforeEach(() => buildSandbox(s));
  after(() => rmSync(base, { recursive: true, force: true }));

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    HOME: join(s, 'home'),
    CLAUDE_PROJECT_DIR: join(s, 'project'),
    TRAJECTORY_DB_PATH: join(s, 'project/.claude/tmb/trajectory.db'),
    PATH: emptyBin,
    LC_ALL: 'C',
    ...extra,
  });
  const rows = <T>(sql: string): T[] => {
    const db = new DatabaseSync(join(s, 'project/.claude/tmb/trajectory.db'), { readOnly: true });
    try {
      return db.prepare(sql).all() as T[];
    } finally {
      db.close();
    }
  };
  const brief = (payload: Record<string, unknown>): string => JSON.stringify({ agent_type: 'swe', ...payload });
  const agent = (payload: Record<string, unknown>, role = 'swe'): string => JSON.stringify({ tool_name: 'Agent', tool_input: { subagent_type: role }, ...payload });

  it('the PATH under test holds neither jq nor sqlite3', () => {
    assert.equal(commandOnPath('jq', env()), false);
    assert.equal(commandOnPath('sqlite3', env()), false);
  });

  it('swe-brief-gate denies an unbriefed swe on Edit and on a trajectory tool', () => {
    assert.equal(deny(sweBriefGate(brief({ tool_name: 'Edit', tool_input: { task_id: 11 } }), env()).stdout), denyReason('11', 'Edit'));
    const tool = 'mcp__plugin_tmb_trajectory-server__task_update_status';
    assert.equal(deny(sweBriefGate(brief({ tool_name: tool, tool_input: { task_id: '11' } }), env()).stdout), denyReason('11', tool));
  });
  it('swe-brief-gate takes the task from the spawn transcript beside the session one', () => {
    const payload = brief({ tool_name: 'Write', agent_id: 'agent-tx', transcript_path: join(s, 'transcripts/session.jsonl'), tool_input: {} });
    assert.equal(deny(sweBriefGate(payload, env()).stdout), denyReason('11', 'Write'));
  });
  it('swe-brief-gate strips a trailing newline from agent_type, tool_name and task_id as $(jq -r ...) does (F244-1)', () => {
    const tool = 'mcp__plugin_tmb_trajectory-server__task_get';
    assert.equal(deny(sweBriefGate(brief({ tool_name: tool, tool_input: { task_id: '11\n' } }), env()).stdout), denyReason('11', tool));
    assert.equal(deny(sweBriefGate(JSON.stringify({ agent_type: 'swe\n', tool_name: 'Edit', tool_input: { task_id: 11 } }), env()).stdout), denyReason('11', 'Edit'));
    assert.equal(deny(sweBriefGate(brief({ tool_name: 'Write\n', tool_input: { task_id: 11 } }), env()).stdout), denyReason('11', 'Write'));
  });
  it('swe-brief-gate binds the run to an agent_id stripped of its trailing newline', () => {
    sweBriefGate(brief({ tool_name: 'mcp__plugin_tmb_trajectory-server__task_brief', agent_id: 'agent-new\n', tool_input: { task_id: 11 } }), env());
    assert.deepEqual(rows<{ spawn_id: string }>('SELECT spawn_id FROM agent_runs WHERE task_id = 11').map((x) => x.spawn_id), ['agent-new']);
  });
  it('swe-brief-gate allows a briefed task, exploration, MultiEdit, other roles, no task and no DB', () => {
    assert.deepEqual(sweBriefGate(brief({ tool_name: 'Edit', tool_input: { task_id: 10 } }), env()), ALLOWED);
    assert.deepEqual(sweBriefGate(brief({ tool_name: 'Read', tool_input: { task_id: 11 } }), env()), ALLOWED);
    assert.deepEqual(sweBriefGate(brief({ tool_name: 'MultiEdit', tool_input: { task_id: 11 } }), env()), ALLOWED);
    assert.deepEqual(sweBriefGate(JSON.stringify({ agent_type: 'bro', tool_name: 'Edit', tool_input: { task_id: 11 } }), env()), ALLOWED);
    assert.deepEqual(sweBriefGate(brief({ tool_name: 'Edit', tool_input: { task_id: '11; DROP TABLE tasks' } }), env()), ALLOWED);
    assert.deepEqual(sweBriefGate(brief({ tool_name: 'Edit', tool_input: { task_id: 11 } }), env({ TRAJECTORY_DB_PATH: join(s, 'none.db') })), ALLOWED);
  });
  it('swe-brief-gate denies on a corrupt DB, as the .sh does', () => {
    const r = sweBriefGate(brief({ tool_name: 'Edit', tool_input: { task_id: 10 } }), env({ TRAJECTORY_DB_PATH: join(s, 'bad/.claude/tmb/trajectory.db') }));
    assert.equal(deny(r.stdout), denyReason('10', 'Edit'));
  });
  it('swe-brief-gate binds the newest open tool_use row on task_brief', () => {
    const r = sweBriefGate(brief({ tool_name: 'mcp__plugin_tmb_trajectory-server__task_brief', agent_id: 'agent-new', tool_input: { task_id: 11 } }), env());
    assert.deepEqual(r, ALLOWED);
    assert.deepEqual(rows<{ spawn_id: string }>('SELECT spawn_id FROM agent_runs WHERE task_id = 11').map((x) => x.spawn_id), ['agent-new']);
  });
  it('swe-brief-gate audits a resumed swe whose keyed run is closed', () => {
    sweBriefGate(brief({ tool_name: 'mcp__plugin_tmb_trajectory-server__task_brief', agent_id: 'agent-resumed', tool_input: { task_id: 12 } }), env());
    const audit = rows<{ issue_id: number; from_node: string; summary: string; content_json: string }>(
      "SELECT issue_id, from_node, summary, content_json FROM audit WHERE event_type = 'swe_resume_observed'",
    );
    assert.equal(audit.length, 1);
    assert.equal(audit[0].issue_id, 1);
    assert.equal(audit[0].from_node, 'hook:swe-brief-gate');
    assert.equal(audit[0].summary, 'swe agent-resumed resumed task 12 and called task_brief');
    assert.match(audit[0].content_json, /^\{"task_id":12,"agent_id":"agent-resumed","observed_at":"[^"]+","consumed":0\}$/);
  });

  it('swe-spawn-bind rebinds the tool_use row to the agent id', () => {
    assert.deepEqual(sweSpawnBind(agent({ tool_use_id: 'toolu_11', tool_response: { agentId: 'agent-bg' } }), env()), ALLOWED);
    assert.deepEqual(rows<{ spawn_id: string }>('SELECT spawn_id FROM agent_runs WHERE task_id = 11').map((x) => x.spawn_id), ['agent-bg']);
  });
  it('swe-spawn-bind strips a trailing newline from subagent_type and agentId as $(jq -r ...) does (F244-2)', () => {
    assert.deepEqual(sweSpawnBind(agent({ tool_use_id: 'toolu_11', tool_response: { agentId: 'agent-9\n' } }, 'swe\n'), env()), ALLOWED);
    assert.deepEqual(rows<{ spawn_id: string }>('SELECT spawn_id FROM agent_runs WHERE task_id = 11').map((x) => x.spawn_id), ['agent-9']);
  });
  it('swe-spawn-bind leaves the tool_use row when a row of the task already holds the agent id', () => {
    sweSpawnBind(agent({ tool_use_id: 'toolu_16', tool_response: { agentId: 'agent-bound' } }), env());
    assert.deepEqual(rows<{ spawn_id: string }>('SELECT spawn_id FROM agent_runs WHERE task_id = 16 ORDER BY id').map((x) => x.spawn_id), ['agent-bound', 'tool_use:toolu_16']);
  });
  it('swe-spawn-bind ignores other roles and fails open on a corrupt DB', () => {
    assert.deepEqual(sweSpawnBind(agent({ tool_use_id: 'toolu_11', tool_response: { agentId: 'a' } }, 'code-reviewer'), env()), ALLOWED);
    assert.deepEqual(rows<{ spawn_id: string }>('SELECT spawn_id FROM agent_runs WHERE task_id = 11').map((x) => x.spawn_id), ['tool_use:toolu_11']);
    const bad = env({ TRAJECTORY_DB_PATH: join(s, 'bad/.claude/tmb/trajectory.db') });
    assert.deepEqual(sweSpawnBind(agent({ tool_use_id: 'toolu_11', tool_response: { agentId: 'a' } }), bad), ALLOWED);
  });

  it('swe-spawn-rollback moves the task to pending and sweeps the run with its window', () => {
    assert.deepEqual(sweSpawnRollback(agent({ tool_use_id: 'toolu_11' }), env()), ALLOWED);
    assert.equal(rows<{ status: string }>('SELECT status FROM tasks WHERE id = 11')[0].status, 'pending');
    const [run] = rows<{ exit_reason: string; usage_source: string; window_matches: number }>(
      `SELECT exit_reason, usage_source,
              duration_ms = CAST(ROUND((julianday(completed_at) - julianday(started_at)) * 86400000) AS INTEGER) AS window_matches
         FROM agent_runs WHERE task_id = 11`,
    );
    assert.deepEqual({ ...run }, { exit_reason: 'swept_orphan', usage_source: 'unmeasured', window_matches: 1 });
  });
  it('swe-spawn-rollback strips a trailing newline from subagent_type as $(jq -r ...) does (F244-2)', () => {
    assert.deepEqual(sweSpawnRollback(agent({ tool_use_id: 'toolu_11' }, 'swe\n'), env()), ALLOWED);
    assert.equal(rows<{ status: string }>('SELECT status FROM tasks WHERE id = 11')[0].status, 'pending');
    assert.equal(rows<{ exit_reason: string }>('SELECT exit_reason FROM agent_runs WHERE task_id = 11')[0].exit_reason, 'swept_orphan');
  });
  it('swe-spawn-rollback keeps the task running while another swe run of it is open', () => {
    sweSpawnRollback(agent({ tool_use_id: 'toolu_14b' }), env());
    assert.equal(rows<{ status: string }>('SELECT status FROM tasks WHERE id = 14')[0].status, 'running');
    const runs = rows<{ spawn_id: string; exit_reason: string | null; duration_ms: number }>('SELECT spawn_id, exit_reason, duration_ms FROM agent_runs WHERE task_id = 14 ORDER BY id');
    assert.deepEqual(
      runs.map((r) => ({ ...r })),
      [
        { spawn_id: 'tool_use:toolu_14a', exit_reason: null, duration_ms: 0 },
        { spawn_id: 'tool_use:toolu_14b', exit_reason: 'swept_orphan', duration_ms: 1234 },
      ],
    );
  });
  it('swe-spawn-rollback leaves a measured run without usage_source', () => {
    sweSpawnRollback(agent({ tool_use_id: 'toolu_19' }), env());
    const [run] = rows<{ exit_reason: string; usage_source: string | null }>('SELECT exit_reason, usage_source FROM agent_runs WHERE task_id = 19');
    assert.deepEqual({ ...run }, { exit_reason: 'swept_orphan', usage_source: null });
  });

  it('post-task-create-spawn-hint places each worktree from the DB', () => {
    const payload = JSON.stringify({
      tool_name: 'mcp__plugin_tmb_trajectory-server__task_create_batch',
      tool_response: { content: [{ type: 'text', text: '[{"id":11,"branch_id":"feat/unbriefed"},{"id":99,"branch_id":"feat/none"}]' }] },
    });
    const context = hint(postTaskCreateSpawnHint(payload, env()).stdout);
    assert.ok(context.includes(`  - task_id=11 branch_id=feat/unbriefed worktree=${join(s, 'project/checkout/.claude/worktrees/unbriefed')}\n`));
    assert.ok(context.includes('  - task_id=99 branch_id=feat/none worktree=unresolved (task 99 has no tasks row)\n'));
    assert.deepEqual(postTaskCreateSpawnHint(payload, env({ TMB_DISABLE_SPAWN_HINT: '1' })), ALLOWED);
    const bad = hint(postTaskCreateSpawnHint(payload, env({ TRAJECTORY_DB_PATH: join(s, 'bad/.claude/tmb/trajectory.db') })).stdout);
    assert.ok(bad.includes('task_id=11 branch_id=feat/unbriefed worktree=unresolved (task 11: the trajectory DB read failed (tasks/repos))'));
    const none = hint(postTaskCreateSpawnHint(payload, env({ TRAJECTORY_DB_PATH: join(s, 'none.db') })).stdout);
    assert.ok(none.includes('task_id=11 branch_id=feat/unbriefed worktree=unresolved (no trajectory DB)'));
  });
  it('post-task-create-spawn-hint is silent on an error, another tool or no tasks', () => {
    const create = (text: string, extra: Record<string, unknown> = {}): string =>
      JSON.stringify({ tool_name: 'mcp__tmb__trajectory-server__task_create_batch', tool_response: { content: [{ type: 'text', text }], ...extra } });
    assert.deepEqual(postTaskCreateSpawnHint(create('[{"id":11,"branch_id":"b"}]', { is_error: true }), env()), ALLOWED);
    assert.deepEqual(postTaskCreateSpawnHint(create('[]'), env()), ALLOWED);
    assert.deepEqual(postTaskCreateSpawnHint(create('{"error":"x"}'), env()), ALLOWED);
    assert.deepEqual(postTaskCreateSpawnHint(JSON.stringify({ tool_name: 'Bash' }), env()), ALLOWED);
    assert.deepEqual(postTaskCreateSpawnHint('not json', env()), ALLOWED);
  });
});
