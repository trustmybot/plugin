/**
 * require-spawn-effort (GH 1692): a swe spawn's effort must equal tasks.effort
 * of its task, naming the expected value and the fix when it does not; a
 * code-reviewer spawn's must equal plugin_config.reviewer_effort (medium when
 * unset or invalid); any other agent passes without one; and a DB from before
 * tasks.effort gets the restart-to-migrate remedy. Each case runs
 * `node dist/hooks.js require-spawn-effort` in a sandbox with its own HOME.
 * The no-task-id, missing-row, corrupt-DB, absent-DB and no-jq cases are the
 * hook-corpus payloads hooks-spawn-gates-parity runs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { makeSandbox, PLUGIN_ROOT, runGate, type Sandbox } from './hook-sandbox.js';

const GATE = 'require-spawn-effort';
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const NOW = '2026-10-17T12:00:00.000Z';
const DENY = '"permissionDecision":"deny"';
const REVIEW_PROMPT = 'task_id=1 commit_sha=abc1234 branch_id=feat/medium repo=plugin attempt_n=1 subagent_session_id=s';

function payload(subagent_type: string, prompt: string, effort?: string): string {
  const tool_input: Record<string, string> = { subagent_type, prompt };
  if (effort !== undefined) tool_input.effort = effort;
  return JSON.stringify({ tool_name: 'Agent', hook_event_name: 'PreToolUse', tool_input });
}

function exec(path: string, sql: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

const MEDIUM_TASK = `INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'effort', 'open', '${NOW}', '${NOW}');
  INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, spec_body, created_at, updated_at) VALUES
    (1, 1, 'feat/medium', 'dev', 'd', 'pending', '## Success Criteria', '${NOW}', '${NOW}');`;

describe('require-spawn-effort: the Agent call carries the effort the DB holds', () => {
  let sb: Sandbox;
  let db: string;

  before(() => {
    sb = makeSandbox(GATE);
    db = join(sb.dir, 'trajectory.db');
    exec(db, SCHEMA);
    exec(
      db,
      `${MEDIUM_TASK}
      INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, spec_body, effort, created_at, updated_at) VALUES
        (2, 1, 'feat/high', 'dev', 'd', 'pending', '## Success Criteria', 'high', '${NOW}', '${NOW}');`,
    );
  });

  after(() => sb.remove());

  const run = (input: string, dbPath = db) => runGate(GATE, { cwd: sb.dir, input, env: { ...sb.env, TRAJECTORY_DB_PATH: dbPath } }).stdout;

  it('a swe spawn whose effort matches tasks.effort passes', () => {
    assert.equal(run(payload('swe', 'task_id=1 You are swe.', 'medium')), '', 'medium task, effort medium');
    assert.equal(run(payload('tmb:swe', 'task_id=2 You are swe.', 'high')), '', 'plugin-prefixed swe, high task, effort high');
  });

  it('a swe spawn with a mismatched effort is denied naming the expected value and the fix', () => {
    const out = run(payload('swe', 'task_id=2 You are swe.', 'medium'));
    assert.ok(out.includes(DENY), 'deny');
    assert.ok(out.includes('task_id=2 (tasks.effort) runs at effort \\"high\\"'), 'names the task and the expected value');
    assert.ok(out.includes('passed effort=\\"medium\\"'), 'names what was passed');
    assert.ok(out.includes('Pass effort=\\"high\\" on the Agent call'), 'names the fix');
    assert.ok(out.includes('task_reopen(task_id=2, effort=...) for rework'), "names how to change the task's effort");
  });

  it('a swe spawn with no effort is denied naming the expected value', () => {
    const out = run(payload('swe', 'task_id=1 You are swe.'));
    assert.ok(out.includes(DENY), 'deny');
    assert.ok(out.includes('passed no effort'), 'names the missing effort');
    assert.ok(out.includes('Pass effort=\\"medium\\" on the Agent call'), 'names the fix');
  });

  it('a code-reviewer spawn passes only with reviewer_effort (medium when unset, GH 2344)', () => {
    assert.equal(run(payload('code-reviewer', REVIEW_PROMPT, 'medium')), '', 'medium passes while unset');
    let out = run(payload('tmb:code-reviewer', REVIEW_PROMPT, 'high'));
    assert.ok(out.includes(DENY), 'high denied while unset');
    assert.ok(out.includes('config_set(key=\\"reviewer_effort\\"'), 'names how to change reviewer_effort');
    assert.ok(out.includes('Pass effort=\\"medium\\" on the Agent call'), 'names the fix');
    out = run(payload('code-reviewer', REVIEW_PROMPT));
    assert.ok(out.includes('passed no effort'), 'missing effort denied');
    exec(db, `INSERT INTO plugin_config (key, value_json) VALUES ('reviewer_effort', '"high"');`);
    try {
      assert.equal(run(payload('code-reviewer', REVIEW_PROMPT, 'high')), '', 'high passes once configured');
      out = run(payload('code-reviewer', REVIEW_PROMPT, 'medium'));
      assert.ok(out.includes('Pass effort=\\"high\\" on the Agent call'), 'medium denied once high is configured');
      exec(db, `UPDATE plugin_config SET value_json = '"max"' WHERE key = 'reviewer_effort';`);
      assert.equal(run(payload('code-reviewer', REVIEW_PROMPT, 'medium')), '', 'an invalid stored value reads as medium');
    } finally {
      exec(db, `DELETE FROM plugin_config WHERE key = 'reviewer_effort';`);
    }
  });

  it('a consultant or other agent passes without an effort', () => {
    assert.equal(run(payload('security-consultant', 'review the auth flow')), '', 'consultant');
    assert.equal(run(payload('general-purpose', 'task_id=2 look around')), '', 'general-purpose');
    assert.equal(run(payload('swe-helper', 'task_id=2')), '', 'a name that only starts with swe');
  });

  it('a pre-v37 DB (no tasks.effort) is denied with the restart-to-migrate remedy', () => {
    const old = join(sb.dir, 'v36.db');
    exec(old, SCHEMA);
    const d = new DatabaseSync(old);
    let cols: string;
    try {
      const rows = d.prepare("SELECT name FROM pragma_table_info('tasks') WHERE name <> 'effort'").all() as { name: string }[];
      cols = rows.map((r) => r.name).join(', ');
    } finally {
      d.close();
    }
    exec(old, `PRAGMA foreign_keys = OFF; CREATE TABLE tasks_v36 AS SELECT ${cols} FROM tasks; DROP TABLE tasks; ALTER TABLE tasks_v36 RENAME TO tasks;`);
    exec(old, MEDIUM_TASK);
    let out = run(payload('swe', 'task_id=1', 'medium'), old);
    assert.ok(out.includes(DENY), 'swe: deny');
    assert.ok(out.includes('tasks.effort is missing'), 'swe: names the missing column');
    assert.ok(out.includes('Restart Claude Code'), 'swe: names the remedy');
    assert.ok(!out.includes('trajectory DB unavailable'), 'swe: not the generic deny');
    out = run(payload('code-reviewer', REVIEW_PROMPT, 'medium'), old);
    assert.ok(!out.includes('tasks.effort is missing'), 'code-reviewer: not denied for the missing column');
  });
});
