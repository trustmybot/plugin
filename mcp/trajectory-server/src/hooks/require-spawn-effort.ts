/**
 * The require-spawn-effort gate (GH 1692): the
 * Agent call's `effort` must be the effort the trajectory DB holds for the
 * spawn. A swe spawn naming task_id=<N> needs tasks.effort of task N; a
 * code-reviewer spawn needs the effort bro_atomic_close assigned task N's
 * review (GH 1955), else plugin_config.reviewer_effort (medium when unset);
 * any other agent is allowed. A missing effort is a mismatch. No resolvable
 * DB allows; a DB read failure denies, and a DB without tasks.effort gets the
 * restart-to-migrate remedy. Unlike the .sh, it needs no jq, so it decides
 * where the .sh denies for a missing jq.
 */
import { ALLOW, type GateResult, type SyncGate } from './gate.js';
import { dbPath, gateRead, GATE_READ_ERROR, haveSqlite, sqlInt, stripTrailingNewlines } from './lib/db.js';
import { reviewerEffortFor } from './lib/effort.js';
import { jqCompact, jqIndex, jqLiteralNumbers, jqMap, jqOr } from './lib/jq.js';
import { jqRawText } from './lib/project-env.js';
import { CODE_REVIEWER_ROLE, normalizeRole } from './lib/role.js';
import { promptTaskId } from './require-task-spec.js';
import { denyPreToolUse, denyUnreadable } from './rework-limit.js';

export const GATE_NAME = 'require-spawn-effort';

/** `jq -r '.tool_input.<key> // ""'` over <payload>, as a `$(...)` capture holds it. */
function toolInputRaw(payload: string, key: string): string {
  return stripTrailingNewlines(
    jqMap(payload, (v) => jqRawText(jqOr(jqIndex(jqIndex(v, 'tool_input'), key), ''))).join('\n'),
  );
}

/** `jq -r '.tool_input.effort // "" | tostring'` over <payload>, as a `$(...)` capture holds it. */
function givenEffort(payload: string): string {
  return stripTrailingNewlines(
    jqMap(
      payload,
      (v) => {
        const effort = jqOr(jqIndex(jqIndex(v, 'tool_input'), 'effort'), '');
        return typeof effort === 'string' ? effort : jqCompact(effort);
      },
      jqLiteralNumbers,
    ).join('\n'),
  );
}

function denyMismatch(who: string, expected: string, given: string, change: string): GateResult {
  const passed = given !== '' ? `passed effort="${given}"` : 'passed no effort';
  return denyPreToolUse(
    `BLOCKED: ${who} runs at effort "${expected}", but the Agent call ${passed}. Pass effort="${expected}" on the Agent call. ${change}`,
  );
}

function sweVerdict(payload: string, given: string, env: NodeJS.ProcessEnv): GateResult {
  const taskId = sqlInt(promptTaskId(toolInputRaw(payload, 'prompt')));
  if (taskId === '') return ALLOW;
  const db = dbPath(env);
  if (db === null || !haveSqlite(env)) return ALLOW;
  const expected = gateRead(db, `SELECT effort FROM tasks WHERE id = ${taskId};`, env);
  if (expected === GATE_READ_ERROR) {
    if (gateRead(db, "SELECT name FROM pragma_table_info('tasks') WHERE name = 'effort';", env) === '') {
      return denyPreToolUse(
        'BLOCKED: the trajectory DB predates the typed-effort schema (tasks.effort is missing): the TMB plugin was updated but the MCP server has not migrated the DB yet. Restart Claude Code so the server migrates the DB, then retry the spawn.',
      );
    }
    return denyUnreadable(GATE_NAME, env);
  }
  if (expected === '' || given === expected) return ALLOW;
  return denyMismatch(
    `task_id=${taskId} (tasks.effort)`,
    expected,
    given,
    `To run it at another effort, change the task first: task_reopen(task_id=${taskId}, effort=...) for rework, task_retry(effort=...) for a retry.`,
  );
}

function reviewerVerdict(payload: string, given: string, env: NodeJS.ProcessEnv): GateResult {
  const db = dbPath(env);
  if (db === null || !haveSqlite(env)) return ALLOW;
  const taskId = sqlInt(promptTaskId(toolInputRaw(payload, 'prompt')));
  const expected = reviewerEffortFor(db, taskId, env);
  if (expected === null) return denyUnreadable(GATE_NAME, env);
  if (given === expected.effort) return ALLOW;
  if (expected.source === 'assigned') {
    return denyMismatch(
      `code-reviewer for task_id=${taskId} (the task's assigned reviewer effort, returned by bro_atomic_close as reviewer_effort)`,
      expected.effort,
      given,
      "The assignment is the task's newest reviewer_effort_assigned audit row; the next bro_atomic_close of the task assigns it again.",
    );
  }
  return denyMismatch(
    'code-reviewer (plugin_config.reviewer_effort, medium when unset)',
    expected.effort,
    given,
    'To change it for every review, config_set(key="reviewer_effort", value=...).',
  );
}

export const requireSpawnEffort: SyncGate = (payload, env) => {
  const subagent = toolInputRaw(payload, 'subagent_type');
  const given = givenEffort(payload);
  if (/(^|:)swe$/.test(subagent)) return sweVerdict(payload, given, env);
  if (normalizeRole(subagent.slice(subagent.lastIndexOf(':') + 1)) === CODE_REVIEWER_ROLE) return reviewerVerdict(payload, given, env);
  return ALLOW;
};
