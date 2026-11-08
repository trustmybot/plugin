/**
 * agent-arg-matches-caller (GH 1692): a subagent's agent_type (or
 * subagent_type) must equal the agent arg of a trajectory-server tool call,
 * and the main session must pass bro; a mismatch denies naming the tool and
 * both values and writes one agent_arg_mismatch row on the task's issue, else
 * the system issue -1; a missing agent arg and role aliases pass; with no
 * usable DB a mismatch still denies and a match still allows; and through the
 * PreToolUse router a mismatch denies and a denied validation_record leaves no
 * reviewer_identity_observed row. Each case runs `node dist/hooks.js` in a
 * sandbox with its own HOME.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { jsonValues, makeSandbox, PLUGIN_ROOT, runGate, type Sandbox } from './hook-sandbox.js';

const GATE = 'agent-arg-matches-caller';
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const NOW = '2026-10-12T10:00:00.000Z';

type Payload = Record<string, unknown> & { tool_input: Record<string, unknown> };

function payload(tool: string, agentType: string, agent: string, taskId?: number): Payload {
  const tool_input: Record<string, unknown> = {};
  if (agent !== '') tool_input.agent = agent;
  if (taskId !== undefined) tool_input.task_id = taskId;
  const p: Payload = { hook_event_name: 'PreToolUse', session_id: 'main-session-1', tool_name: `mcp__plugin_tmb_trajectory-server__${tool}`, tool_input };
  if (agentType !== '') Object.assign(p, { agent_type: agentType, agent_id: 'a1b2c3d4e5f6a7b8c' });
  return p;
}

function decision(stdout: string): string {
  const v = jsonValues(stdout)[0] as { hookSpecificOutput?: { permissionDecision?: string } } | undefined;
  return v?.hookSpecificOutput?.permissionDecision ?? 'allow';
}

function query(path: string, sql: string): string {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare(sql).all() as Record<string, unknown>[]).map((r) => Object.values(r).map(String).join('|')).join('\n');
  } finally {
    db.close();
  }
}

describe('agent-arg-matches-caller: the agent arg names the calling role', () => {
  let sb: Sandbox;
  let proj: string;
  let db: string;

  before(() => {
    sb = makeSandbox(GATE);
    proj = join(sb.dir, 'proj');
    db = join(proj, '.claude/tmb/trajectory.db');
    mkdirSync(join(proj, '.claude/tmb'), { recursive: true });
    const d = new DatabaseSync(db);
    try {
      d.exec(SCHEMA);
      d.prepare("INSERT OR IGNORE INTO issues (id, objective, status, created_at, updated_at) VALUES (-1, 'system', 'open', ?, ?)").run(NOW, NOW);
      d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (7, 'roles', 'open', ?, ?)").run(NOW, NOW);
      d.prepare(
        "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, created_at, updated_at) VALUES (42, 7, 'fix/roles', 'dev', 'd', 'running', ?, ?)",
      ).run(NOW, NOW);
    } finally {
      d.close();
    }
  });

  after(() => sb.remove());

  const run = (project: string, p: Payload) =>
    runGate(GATE, { cwd: project, input: JSON.stringify(p), env: { ...sb.env, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
  const chain = (p: Payload) => runGate('PreToolUse', { cwd: proj, input: JSON.stringify(p), env: { ...sb.env, CLAUDE_PROJECT_DIR: proj } });
  const rows = () => query(db, "SELECT COUNT(*) AS n FROM audit WHERE event_type = 'agent_arg_mismatch'");

  it("a code-reviewer subagent passing agent='bro' is denied with an audit row", () => {
    const out = run(proj, payload('audit_append', 'code-reviewer', 'bro', 42)).stdout;
    assert.equal(decision(out), 'deny', 'denied');
    assert.ok(
      out.includes("BLOCKED: audit_append called with agent='bro' but the caller is a code-reviewer subagent. Allowed form: the same audit_append call with agent='code-reviewer'"),
      'reason names tool and both values',
    );
    assert.equal(rows(), '1', 'one row written');
    assert.equal(
      query(db, "SELECT issue_id || '|' || from_node || '|' || content_json AS r FROM audit WHERE event_type = 'agent_arg_mismatch'"),
      '7|hook:agent-arg-matches-caller|{"tool":"audit_append","given":"bro","actual":"code-reviewer","task_id":42}',
      "row on the task's issue with tool, given, actual",
    );
  });

  it("a swe subagent passing agent='swe' is allowed", () => {
    assert.equal(decision(run(proj, payload('task_update_status', 'swe', 'swe', 42)).stdout), 'allow', 'allowed');
    assert.equal(rows(), '1', 'no row for a match');
  });

  it("a swe subagent passing agent='bro' is denied", () => {
    const out = run(proj, payload('bro_atomic_close', 'tmb:swe', 'bro')).stdout;
    assert.equal(decision(out), 'deny', 'denied');
    assert.ok(out.includes("call with agent='swe'"), "reason names the caller's role");
    assert.equal(rows(), '2', 'second row written');
    assert.equal(query(db, "SELECT issue_id FROM audit WHERE event_type = 'agent_arg_mismatch' ORDER BY id DESC LIMIT 1"), '-1', 'no task_id: row on the system issue');
  });

  it("the main session passing agent='bro' is allowed", () => {
    assert.equal(decision(run(proj, payload('task_update_spec', '', 'bro', 42)).stdout), 'allow', 'allowed');
  });

  it("the main session passing agent='swe' is denied", () => {
    const out = run(proj, payload('task_update_status', '', 'swe', 42)).stdout;
    assert.equal(decision(out), 'deny', 'denied');
    assert.ok(out.includes("but the caller is the main session (bro). Allowed form: the same"), 'reason names the main session');
    assert.equal(rows(), '3', 'third row written');
  });

  it("a consultant agent_type cto passing agent='cto' is allowed, agent='bro' denied", () => {
    assert.equal(decision(run(proj, payload('discussion_append', 'cto', 'cto')).stdout), 'allow', 'allowed');
    const out = run(proj, payload('issue_create', 'cto', 'bro')).stdout;
    assert.equal(decision(out), 'deny', 'denied');
    assert.ok(out.includes("a cto subagent. Allowed form: the same"), 'reason names the consultant');
    assert.equal(rows(), '4', 'fourth row written');
  });

  it('no agent arg is allowed', () => {
    assert.equal(decision(run(proj, payload('world_model_get', 'code-reviewer', '')).stdout), 'allow', 'subagent without agent: allowed');
    assert.equal(decision(run(proj, payload('world_model_get', '', '')).stdout), 'allow', 'main session without agent: allowed');
  });

  it('role aliases normalise to the same role', () => {
    assert.equal(decision(run(proj, payload('validation_record', 'tmb:code-reviewer', 'code-reviewer', 42)).stdout), 'allow', 'prefixed agent_type, bare agent');
    assert.equal(decision(run(proj, payload('validation_record', 'code-reviewer', 'tmb:code-reviewer', 42)).stdout), 'allow', 'bare agent_type, prefixed agent');
    assert.equal(decision(run(proj, payload('task_get', '', 'BRO')).stdout), 'allow', 'case-blind like the server');
    assert.equal(rows(), '4', 'no row for aliases');
  });

  it('subagent_type stands in for agent_type', () => {
    const out = run(proj, { ...payload('task_get', '', 'bro'), subagent_type: 'swe' }).stdout;
    assert.equal(decision(out), 'deny', "subagent_type swe with agent='bro': denied");
    assert.equal(rows(), '5', 'fifth row written');
  });

  it('an unreadable DB: a mismatch denies, a match allows', () => {
    const broken = join(sb.dir, 'broken');
    mkdirSync(join(broken, '.claude/tmb'), { recursive: true });
    writeFileSync(join(broken, '.claude/tmb/trajectory.db'), 'not a database');
    const out = run(broken, payload('audit_append', 'code-reviewer', 'bro', 42)).stdout;
    assert.equal(decision(out), 'deny', 'mismatch denied');
    assert.ok(out.includes("call with agent='code-reviewer'"), 'the mismatch reason, not the db-unavailable one');
    assert.equal(decision(run(broken, payload('audit_append', 'code-reviewer', 'code-reviewer', 42)).stdout), 'allow', 'match allowed');
  });

  it('no trajectory DB: a mismatch denies, a match allows', () => {
    const bare = join(sb.dir, 'bare');
    mkdirSync(bare);
    assert.equal(decision(run(bare, payload('audit_append', 'swe', 'bro')).stdout), 'deny', 'mismatch denied');
    assert.equal(decision(run(bare, payload('audit_append', 'swe', 'swe')).stdout), 'allow', 'match allowed');
  });

  it('other tools are not judged', () => {
    const p = { ...payload('task_get', 'code-reviewer', 'bro'), tool_name: 'mcp__github__get_issue' };
    assert.equal(decision(run(proj, p).stdout), 'allow', 'non-trajectory tool allowed');
  });

  it('the PreToolUse router chain denies a mismatch', () => {
    assert.equal(decision(chain(payload('audit_append', 'code-reviewer', 'bro', 42)).stdout), 'deny', 'denied through the PreToolUse router');
    assert.equal(rows(), '6', 'row written through the PreToolUse router');
  });

  it("a code-reviewer validation_record with agent='bro' through the chain leaves no reviewer_identity_observed row", () => {
    const observed = () => query(db, "SELECT COUNT(*) AS n FROM audit WHERE event_type = 'reviewer_identity_observed'");
    const vr = (agent: string, toolUseId: string): Payload => {
      const p = payload('validation_record', 'code-reviewer', agent, 42);
      return { ...p, tool_input: { ...p.tool_input, attempt_n: 1 }, tool_use_id: toolUseId };
    };
    let out = chain(vr('bro', 'tu-vr1')).stdout;
    assert.equal(decision(out), 'deny', 'denied');
    assert.ok(out.includes("call with agent='code-reviewer'"), "agent-arg-matches-caller's reason");
    assert.equal(observed(), '0', 'no observation row');
    out = chain(vr('code-reviewer', 'tu-vr2')).stdout;
    assert.equal(decision(out), 'allow', 'the matching call is allowed');
    assert.equal(observed(), '1', 'and reaches reviewer-identity-observe');
  });
});
