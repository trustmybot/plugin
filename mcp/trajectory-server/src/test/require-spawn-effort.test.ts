/**
 * require-spawn-effort (GH 1692): a swe spawn's effort must equal tasks.effort
 * of its task, naming the expected value and the fix when it does not; a
 * code-reviewer spawn's must equal its task's assigned reviewer effort (GH
 * 1955), else plugin_config.reviewer_effort (medium when unset or invalid); any other agent passes without one; and a DB from before
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
    assert.ok(out.includes('Allowed form: the same Agent call with effort=\\"high\\"'), 'names the fix');
    assert.ok(out.includes('task_reopen(task_id=2, effort=...) for rework'), "names how to change the task's effort");
  });

  it('a swe spawn with no effort is denied naming the expected value', () => {
    const out = run(payload('swe', 'task_id=1 You are swe.'));
    assert.ok(out.includes(DENY), 'deny');
    assert.ok(out.includes('passed no effort'), 'names the missing effort');
    assert.ok(out.includes('Allowed form: the same Agent call with effort=\\"medium\\"'), 'names the fix');
  });

  it('a code-reviewer spawn passes only with reviewer_effort (medium when unset, GH 2344)', () => {
    assert.equal(run(payload('code-reviewer', REVIEW_PROMPT, 'medium')), '', 'medium passes while unset');
    let out = run(payload('tmb:code-reviewer', REVIEW_PROMPT, 'high'));
    assert.ok(out.includes(DENY), 'high denied while unset');
    assert.ok(out.includes('config_set(key=\\"reviewer_effort\\"'), 'names how to change reviewer_effort');
    assert.ok(out.includes('Allowed form: the same Agent call with effort=\\"medium\\"'), 'names the fix');
    out = run(payload('code-reviewer', REVIEW_PROMPT));
    assert.ok(out.includes('passed no effort'), 'missing effort denied');
    exec(db, `INSERT INTO plugin_config (key, value_json) VALUES ('reviewer_effort', '"high"');`);
    try {
      assert.equal(run(payload('code-reviewer', REVIEW_PROMPT, 'high')), '', 'high passes once configured');
      out = run(payload('code-reviewer', REVIEW_PROMPT, 'medium'));
      assert.ok(out.includes('Allowed form: the same Agent call with effort=\\"high\\"'), 'medium denied once high is configured');
      exec(db, `UPDATE plugin_config SET value_json = '"max"' WHERE key = 'reviewer_effort';`);
      assert.equal(run(payload('code-reviewer', REVIEW_PROMPT, 'medium')), '', 'an invalid stored value reads as medium');
    } finally {
      exec(db, `DELETE FROM plugin_config WHERE key = 'reviewer_effort';`);
    }
  });

  describe("a code-reviewer spawn expects the task's assigned reviewer effort (GH 1955)", () => {
    const assign = (taskId: number, effort: string) =>
      exec(
        db,
        `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at) VALUES
          (1, 'feat/medium', 'bro', 'reviewer_effort_assigned', 's', '${JSON.stringify({ task_id: taskId, commit_sha: 'abc1234', effort, reason: 'x' })}', '${NOW}');`,
      );
    const clear = () => exec(db, `DELETE FROM audit WHERE event_type = 'reviewer_effort_assigned';`);

    it('assigned match: the newest assigned effort passes', () => {
      assign(1, 'high');
      assign(1, 'low');
      try {
        assert.equal(run(payload('code-reviewer', REVIEW_PROMPT, 'low')), '', 'the newest row (low) passes');
      } finally {
        clear();
      }
    });

    it('assigned mismatch: any other effort, or none, is denied naming the assignment as the source', () => {
      assign(1, 'high');
      try {
        for (const given of ['medium', 'low', undefined]) {
          const out = run(payload('code-reviewer', REVIEW_PROMPT, given));
          assert.ok(out.includes(DENY), `deny for ${given ?? 'no effort'}`);
          assert.ok(out.includes('Allowed form: the same Agent call with effort=\\"high\\"'), 'names the assigned value');
          assert.ok(out.includes("the task's assigned reviewer effort, returned by review_handoff"), 'names the source');
          assert.ok(!out.includes('config_set(key=\\"reviewer_effort\\"'), 'not the config remedy');
        }
      } finally {
        clear();
      }
    });

    it('no row for the task: the config effort applies, with the config remedy', () => {
      assign(2, 'high');
      try {
        assert.equal(run(payload('code-reviewer', REVIEW_PROMPT, 'medium')), '', 'task 1 has no row: medium passes');
        const out = run(payload('code-reviewer', REVIEW_PROMPT, 'high'));
        assert.ok(out.includes(DENY), 'high denied for task 1');
        assert.ok(out.includes('config_set(key=\\"reviewer_effort\\"'), 'names the config key');
      } finally {
        clear();
      }
    });

    it('a newest row with an invalid effort reads as the config', () => {
      assign(1, 'high');
      assign(1, 'max');
      try {
        assert.equal(run(payload('code-reviewer', REVIEW_PROMPT, 'medium')), '', 'invalid newest row: config medium passes');
      } finally {
        clear();
      }
    });

    it('no task id in the prompt: the config effort applies', () => {
      assign(1, 'high');
      try {
        const prompt = 'commit_sha=abc1234 branch_id=feat/medium repo=plugin';
        assert.equal(run(payload('code-reviewer', prompt, 'medium')), '', 'config medium passes');
        const out = run(payload('code-reviewer', prompt, 'high'));
        assert.ok(out.includes(DENY), 'the assigned high of task 1 does not apply');
        assert.ok(out.includes('config_set(key=\\"reviewer_effort\\"'), 'names the config key');
      } finally {
        clear();
      }
    });
  });

  describe("a code-reviewer spawn expects the task's assigned reviewer model (GH 2932)", () => {
    const assignRow = (content: Record<string, unknown>) =>
      exec(
        db,
        `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at) VALUES
          (1, 'feat/medium', 'bro', 'reviewer_effort_assigned', 's', '${JSON.stringify({ task_id: 1, commit_sha: 'abc1234', reason: 'docs_tests', ...content })}', '${NOW}');`,
      );
    const clear = () => exec(db, `DELETE FROM audit WHERE event_type = 'reviewer_effort_assigned';`);
    const spawn = (effort: string | undefined, model?: string) => {
      const input = JSON.parse(payload('code-reviewer', REVIEW_PROMPT, effort)) as { tool_input: Record<string, string> };
      if (model !== undefined) input.tool_input.model = model;
      return run(JSON.stringify(input));
    };

    it('assigned model: only the exact effort and model pass', () => {
      assignRow({ effort: 'high', model: 'sonnet' });
      try {
        assert.equal(spawn('high', 'sonnet'), '', 'exact match passes');
        for (const [effort, model, passed] of [
          ['high', undefined, 'effort=\\"high\\" and no model'],
          ['high', 'opus', 'effort=\\"high\\" and model=\\"opus\\"'],
          ['medium', 'sonnet', 'effort=\\"medium\\" and model=\\"sonnet\\"'],
          [undefined, 'sonnet', 'no effort and model=\\"sonnet\\"'],
        ] as const) {
          const out = spawn(effort, model);
          assert.ok(out.includes(DENY), `deny for ${effort}/${model}`);
          assert.ok(out.includes(`passed ${passed}`), `names what was passed: ${out}`);
          assert.ok(out.includes('runs at effort \\"high\\" with model=\\"sonnet\\"'), 'names the expected pair');
          assert.ok(out.includes('Allowed form: the same Agent call with effort=\\"high\\" and model=\\"sonnet\\"'), 'names the fix');
        }
      } finally {
        clear();
      }
    });

    it('no model assigned: a spawn naming any model is denied, naming no model as the fix', () => {
      assignRow({ effort: 'high' });
      try {
        assert.equal(spawn('high'), '', 'no model passes');
        const out = spawn('high', 'opus');
        assert.ok(out.includes(DENY), 'a model is denied');
        assert.ok(out.includes('Allowed form: the same Agent call with effort=\\"high\\" and no model'), out);
      } finally {
        clear();
      }
      const config = spawn('medium', 'sonnet');
      assert.ok(config.includes(DENY), 'the config path assigns no model either');
      assert.ok(config.includes('Allowed form: the same Agent call with effort=\\"medium\\" and no model'), config);
      assert.ok(config.includes('config_set(key=\\"reviewer_effort\\"'), 'config remedy');
    });

    it('a newest row with an unknown model reads as the config', () => {
      assignRow({ effort: 'high', model: 'gpt-x' });
      try {
        assert.equal(spawn('medium'), '', 'config medium, no model');
        assert.ok(spawn('high', 'gpt-x').includes(DENY), 'the unknown model is not admitted');
      } finally {
        clear();
      }
    });
  });

  it('a consultant or other agent passes without an effort', () => {
    assert.equal(run(payload('security-consultant', 'review the auth flow')), '', 'consultant');
    assert.equal(run(payload('general-purpose', 'task_id=2 look around')), '', 'general-purpose');
    assert.equal(run(payload('swe-helper', 'task_id=2')), '', 'a name that only starts with swe');
  });

  describe('a review FAIL since the last pass floors a swe spawn at high (GH 2866)', () => {
    before(() => {
      exec(
        db,
        `INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, spec_body, effort, created_at, updated_at) VALUES
          (30, 1, 'feat/fail-medium', 'dev', 'd', 'running', '## Success Criteria', 'medium', '${NOW}', '${NOW}'),
          (31, 1, 'feat/fail-high', 'dev', 'd', 'running', '## Success Criteria', 'high', '${NOW}', '${NOW}'),
          (32, 1, 'feat/fail-then-pass', 'dev', 'd', 'running', '## Success Criteria', 'medium', '${NOW}', '${NOW}');
        INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, created_at) VALUES
          (30, 1, 'code-reviewer', 'fail', 1, '${NOW}'),
          (31, 1, 'code-reviewer', 'fail', 1, '${NOW}'),
          (32, 1, 'code-reviewer', 'fail', 1, '${NOW}'),
          (32, 2, 'code-reviewer', 'pass', 1, '${NOW}');`,
      );
    });

    it('tasks.effort medium with a FAIL: a medium spawn is denied naming task_reopen(effort=high)', () => {
      for (const effort of ['medium', 'low', 'high']) {
        const out = run(payload('swe', 'task_id=30 You are swe.', effort));
        assert.ok(out.includes(DENY), `effort ${effort}: deny`);
        assert.ok(out.includes('review FAIL since its last passing review'), `effort ${effort}: names the FAIL`);
        assert.ok(out.includes("task_reopen(task_id=30, reason=\\\"<why>\\\", effort='high')"), `effort ${effort}: names task_reopen`);
      }
      assert.ok(run(payload('swe', 'task_id=30 You are swe.')).includes(DENY), 'no effort: deny');
    });

    it('tasks.effort high with a FAIL: only a high spawn passes', () => {
      assert.equal(run(payload('swe', 'task_id=31 You are swe.', 'high')), '');
      const out = run(payload('swe', 'task_id=31 You are swe.', 'medium'));
      assert.ok(out.includes(DENY), 'medium: deny');
      assert.ok(out.includes('Allowed form: the same Agent call with effort=\\"high\\"'), 'names the high spawn');
    });

    it('a pass after the FAIL lifts the floor: the spawn needs only tasks.effort', () => {
      assert.equal(run(payload('swe', 'task_id=32 You are swe.', 'medium')), '');
      assert.ok(run(payload('swe', 'task_id=32 You are swe.', 'high')).includes(DENY), 'high is a tasks.effort mismatch');
    });
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
    assert.ok(out.includes('a Claude Code restart lets the server migrate it. This is policy: stop and report.'), 'swe: names the remedy');
    assert.ok(!out.includes('trajectory DB unavailable'), 'swe: not the generic deny');
    out = run(payload('code-reviewer', REVIEW_PROMPT, 'medium'), old);
    assert.ok(!out.includes('tasks.effort is missing'), 'code-reviewer: not denied for the missing column');
  });
});
