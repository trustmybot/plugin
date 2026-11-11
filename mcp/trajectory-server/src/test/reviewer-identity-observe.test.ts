/**
 * reviewer-identity-observe end to end (GH 1692), the PreToolUse gate on
 * validation_record:
 *   1. a code-reviewer subagent payload (agent_id + agent_type code-reviewer,
 *      bare or plugin-prefixed) writes one reviewer_identity_observed row on
 *      the task's issue with {task_id, attempt_n, session_id, agent_id,
 *      tool_use_id, observed_at, consumed: 0}; a payload without tool_use_id
 *      still writes the row with tool_use_id null;
 *   2. swe subagent and bro main-loop (no agent_id) payloads write nothing;
 *   3. every observed call is allowed;
 *   4. an unreadable DB denies with the db-unavailable reason;
 *   5. without jq on PATH it still records the caller, silently;
 *   6. through the PreToolUse router chain, a reviewer retry (the first
 *      validation_record fails on bad args, the second succeeds) leaves one
 *      consumed and one superseded row; a main-loop validation_record with
 *      agent='code-reviewer' is denied by agent-arg-matches-caller and leaves
 *      the existing row unconsumed and unsuperseded.
 * Each case runs `node dist/hooks.js` in a sandbox with its own HOME.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { jsonValues, makeSandbox, noCmdPath, PLUGIN_ROOT, runGate, type Sandbox } from './hook-sandbox.js';

const GATE = 'reviewer-identity-observe';
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const DIST = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist');
const NOW = '2026-10-11T19:00:00.000Z';

type Payload = Record<string, unknown> & { tool_input: Record<string, unknown> };

function payload(agentType: string, agentId: string, toolUseId = 'toolu_01ABCDEF', attemptN = 2): Payload {
  const p: Payload = {
    hook_event_name: 'PreToolUse',
    session_id: 'main-session-1',
    tool_name: 'mcp__plugin_tmb_trajectory-server__validation_record',
    tool_input: { agent: 'code-reviewer', task_id: '42', attempt_n: attemptN, verdict: 'pass', feedback: 'ok', mcp_available: true, probes: [{ target: 't', probe_cmd: 'npm test', observed: 'exit 0' }] },
  };
  if (agentType !== '') p.agent_type = agentType;
  if (agentId !== '') p.agent_id = agentId;
  if (toolUseId !== '') p.tool_use_id = toolUseId;
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

describe('reviewer-identity-observe: a code-reviewer validation_record records its caller', () => {
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
      d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (7, 'review', 'open', ?, ?)").run(NOW, NOW);
      d.prepare(
        "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, commit_sha, created_at, updated_at) VALUES (42, 7, 'fix/review', 'dev', 'd', 'closed', 'abc1234', ?, ?)",
      ).run(NOW, NOW);
      d.prepare(
        "INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out) VALUES (42, 'abc1234', 'gate', ?, ?, 0, 900, 0)",
      ).run(NOW, NOW);
    } finally {
      d.close();
    }
  });

  after(() => sb.remove());

  const projEnv = (project: string) => ({ ...sb.env, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT });
  const run = (project: string, p: Payload) => {
    const r = runGate(GATE, { cwd: project, input: JSON.stringify(p), env: projEnv(project) });
    return r.stdout + r.stderr;
  };
  const chain = (p: Payload) => runGate('PreToolUse', { cwd: proj, input: JSON.stringify(p), env: projEnv(proj) }).stdout;
  const rows = () => query(db, "SELECT COUNT(*) AS n FROM audit WHERE event_type = 'reviewer_identity_observed'");

  function server(p: Payload): string {
    const script = `
      const [, dist, dbPath, input] = process.argv;
      const { TrajectoryDB } = await import(dist + '/db.js');
      const { validationTools } = await import(dist + '/tools/validation.js');
      const db = new TrajectoryDB(dbPath);
      const res = await validationTools(db).handlers.validation_record(JSON.parse(input));
      db.close();
      process.stdout.write(res.isError ? 'error' : 'ok');
    `;
    const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', '--input-type=module', '-e', script, DIST, db, JSON.stringify(p.tool_input)], {
      cwd: proj,
      encoding: 'utf8',
      env: projEnv(proj),
    });
    return r.stdout + r.stderr;
  }

  /** consumed|superseded|superseded_by per observation row of <attemptN>, oldest first; superseded_by is the 0-based position of the superseding observation row. */
  const state = (attemptN: number) =>
    query(
      db,
      `SELECT group_concat(s, ' ') FROM (SELECT json_extract(content_json, '$.consumed') || '|' || COALESCE(json_extract(content_json, '$.superseded'), '-') || '|' ||
         CASE WHEN json_extract(content_json, '$.superseded_by') IS NULL THEN '-' ELSE (SELECT COUNT(*) FROM audit o WHERE o.event_type = 'reviewer_identity_observed'
           AND json_extract(o.content_json, '$.attempt_n') = ${attemptN} AND o.id < json_extract(audit.content_json, '$.superseded_by')) END AS s
       FROM audit WHERE event_type = 'reviewer_identity_observed' AND json_extract(content_json, '$.attempt_n') = ${attemptN} ORDER BY id)`,
    );

  it('a code-reviewer subagent payload writes the observed row', () => {
    assert.equal(decision(run(proj, payload('code-reviewer', 'a1b2c3d4e5f6a7b8c'))), 'allow', 'observe-only: allowed');
    assert.equal(rows(), '1', 'one row written');
    assert.equal(
      query(db, "SELECT issue_id || '|' || from_node || '|' || json_remove(content_json, '$.observed_at') FROM audit WHERE event_type = 'reviewer_identity_observed'"),
      '7|hook:reviewer-identity-observe|{"task_id":42,"attempt_n":2,"session_id":"main-session-1","agent_id":"a1b2c3d4e5f6a7b8c","tool_use_id":"toolu_01ABCDEF","consumed":0}',
      "row on the task's issue with the observed identity and tool_use_id",
    );
    const observedAt = query(db, "SELECT json_extract(content_json, '$.observed_at') FROM audit WHERE event_type = 'reviewer_identity_observed'");
    assert.match(observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'observed_at is a 24-char ms-ISO timestamp');
  });

  it('a plugin-prefixed agent_type normalises to code-reviewer', () => {
    assert.equal(decision(run(proj, payload('tmb:code-reviewer', 'b1b2c3d4e5f6a7b8c'))), 'allow', 'allowed');
    assert.equal(rows(), '2', 'second row written');
  });

  it('a payload without tool_use_id still writes the row with tool_use_id null', () => {
    assert.equal(decision(run(proj, payload('code-reviewer', 'd1b2c3d4e5f6a7b8c', ''))), 'allow', 'allowed');
    assert.equal(rows(), '3', 'third row written');
    assert.equal(
      query(db, "SELECT json_type(content_json, '$.tool_use_id') || '|' || json_extract(content_json, '$.consumed') FROM audit WHERE event_type = 'reviewer_identity_observed' ORDER BY id DESC LIMIT 1"),
      'null|0',
      'tool_use_id is JSON null',
    );
  });

  it('a swe subagent payload writes nothing', () => {
    assert.equal(decision(run(proj, payload('tmb:swe', 'c1b2c3d4e5f6a7b8c'))), 'allow', 'allowed');
    assert.equal(rows(), '3', 'no row for swe');
  });

  it('a bro main-loop payload (no agent_id) writes nothing', () => {
    assert.equal(decision(run(proj, payload('', ''))), 'allow', 'allowed');
    assert.equal(decision(run(proj, payload('code-reviewer', ''))), 'allow', 'allowed without agent_id');
    assert.equal(rows(), '3', 'no row without agent_id');
  });

  it('an unreadable DB denies', () => {
    const broken = join(sb.dir, 'broken');
    mkdirSync(join(broken, '.claude/tmb'), { recursive: true });
    writeFileSync(join(broken, '.claude/tmb/trajectory.db'), 'not a database');
    const out = run(broken, payload('code-reviewer', 'a1b2c3d4e5f6a7b8c'));
    assert.equal(decision(out), 'deny', 'fail closed');
    assert.ok(out.includes('trajectory DB unavailable'), `the db-unavailable reason: ${out}`);
  });

  it('a project without a trajectory DB is allowed', () => {
    const bare = join(sb.dir, 'bare');
    mkdirSync(bare);
    assert.equal(decision(run(bare, payload('code-reviewer', 'a1b2c3d4e5f6a7b8c'))), 'allow', 'unresolved DB: allowed');
  });

  it('without jq on PATH the gate needs none and records the caller', () => {
    const env = { ...projEnv(proj), PATH: noCmdPath(join(sb.dir, 'nojq'), 'jq', sb.env.PATH ?? '') };
    const r = runGate(GATE, { cwd: proj, input: JSON.stringify(payload('code-reviewer', 'e1b2c3d4e5f6a7b8c')), env });
    assert.equal(r.status, 0, 'exit 0');
    assert.equal(r.stderr, '', 'no stderr note');
    assert.equal(rows(), '4', 'the row is written');
    const d = new DatabaseSync(db);
    try {
      d.exec("DELETE FROM audit WHERE event_type = 'reviewer_identity_observed' AND json_extract(content_json, '$.agent_id') = 'e1b2c3d4e5f6a7b8c'");
    } finally {
      d.close();
    }
  });

  it('a reviewer retry through the chain leaves one consumed and one superseded row', () => {
    const bad = payload('code-reviewer', 'f1b2c3d4e5f6a7b8c', 'toolu_retry1', 3);
    bad.tool_input.verdict = 'approve';
    assert.equal(decision(chain(bad)), 'allow', 'the first call passes the chain');
    assert.equal(server(bad), 'error', 'and fails on bad args at the server');
    assert.equal(state(3), '0|-|-', 'its row is unconsumed');
    const ok = payload('code-reviewer', 'f1b2c3d4e5f6a7b8c', 'toolu_retry2', 3);
    assert.equal(decision(chain(ok)), 'allow', 'the retry passes the chain');
    assert.equal(server(ok), 'ok', 'and records the verdict');
    assert.equal(state(3), '0|1|1 1|-|-', 'the older row is superseded by the consumed retry row');
  });

  it("a main-loop validation_record(agent='code-reviewer') is denied and consumes nothing", () => {
    assert.equal(decision(chain(payload('code-reviewer', 'f2b2c3d4e5f6a7b8c', 'toolu_obs', 4))), 'allow', 'a reviewer observation for attempt 4');
    const before = rows();
    const out = chain(payload('', '', 'toolu_main', 4));
    assert.equal(decision(out), 'deny', 'agent-arg-matches-caller denies the main loop');
    assert.ok(out.includes("call with agent='bro'"), `agent-arg-matches-caller's reason: ${out}`);
    assert.equal(rows(), before, 'no row written');
    assert.equal(state(4), '0|-|-', 'the reviewer row stays unconsumed and unsuperseded');
  });
});
