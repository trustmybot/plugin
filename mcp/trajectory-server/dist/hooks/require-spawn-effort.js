/**
 * TypeScript port of scripts/hooks/require-spawn-effort.sh (GH 1692): the
 * Agent call's `effort` must be the effort the trajectory DB holds for the
 * spawn. A swe spawn naming task_id=<N> needs tasks.effort of task N; a
 * code-reviewer spawn needs plugin_config.reviewer_effort (high when unset);
 * any other agent is allowed. A missing effort is a mismatch. No resolvable
 * DB allows; a DB read failure denies, and a DB without tasks.effort gets the
 * restart-to-migrate remedy. Unlike the .sh, it needs no jq, so it decides
 * where the .sh denies for a missing jq.
 */
import { ALLOW } from './gate.js';
import { dbPath, gateRead, GATE_READ_ERROR, haveSqlite, sqlInt, stripTrailingNewlines } from './lib/db.js';
import { effortDefaults } from './lib/effort.js';
import { jqCompact, jqIndex, jqLiteralNumbers, jqMap, jqOr } from './lib/jq.js';
import { jqRawText } from './lib/project-env.js';
import { CODE_REVIEWER_ROLE, normalizeRole } from './lib/role.js';
import { promptTaskId } from './require-task-spec.js';
import { denyPreToolUse, denyUnreadable } from './rework-limit.js';
export const GATE_NAME = 'require-spawn-effort';
/** `jq -r '.tool_input.<key> // ""'` over <payload>, as a `$(...)` capture holds it. */
function toolInputRaw(payload, key) {
    return stripTrailingNewlines(jqMap(payload, (v) => jqRawText(jqOr(jqIndex(jqIndex(v, 'tool_input'), key), ''))).join('\n'));
}
/** `jq -r '.tool_input.effort // "" | tostring'` over <payload>, as a `$(...)` capture holds it. */
function givenEffort(payload) {
    return stripTrailingNewlines(jqMap(payload, (v) => {
        const effort = jqOr(jqIndex(jqIndex(v, 'tool_input'), 'effort'), '');
        return typeof effort === 'string' ? effort : jqCompact(effort);
    }, jqLiteralNumbers).join('\n'));
}
function denyMismatch(who, expected, given, change) {
    const passed = given !== '' ? `passed effort="${given}"` : 'passed no effort';
    return denyPreToolUse(`BLOCKED: ${who} runs at effort "${expected}", but the Agent call ${passed}. Pass effort="${expected}" on the Agent call. ${change}`);
}
function sweVerdict(payload, given, env) {
    const taskId = sqlInt(promptTaskId(toolInputRaw(payload, 'prompt')));
    if (taskId === '')
        return ALLOW;
    const db = dbPath(env);
    if (db === null || !haveSqlite(env))
        return ALLOW;
    const expected = gateRead(db, `SELECT effort FROM tasks WHERE id = ${taskId};`, env);
    if (expected === GATE_READ_ERROR) {
        if (gateRead(db, "SELECT name FROM pragma_table_info('tasks') WHERE name = 'effort';", env) === '') {
            return denyPreToolUse('BLOCKED: the trajectory DB predates the typed-effort schema (tasks.effort is missing): the TMB plugin was updated but the MCP server has not migrated the DB yet. Restart Claude Code so the server migrates the DB, then retry the spawn.');
        }
        return denyUnreadable(GATE_NAME, env);
    }
    if (expected === '' || given === expected)
        return ALLOW;
    return denyMismatch(`task_id=${taskId} (tasks.effort)`, expected, given, `To run it at another effort, change the task first: task_reopen(task_id=${taskId}, effort=...) for rework, task_retry(effort=...) for a retry.`);
}
function reviewerVerdict(given, env) {
    const db = dbPath(env);
    if (db === null || !haveSqlite(env))
        return ALLOW;
    const defaults = effortDefaults(db, env);
    if (defaults === GATE_READ_ERROR || defaults === '')
        return denyUnreadable(GATE_NAME, env);
    const bar = defaults.indexOf('|');
    const expected = bar < 0 ? defaults : defaults.slice(bar + 1);
    if (given === expected)
        return ALLOW;
    return denyMismatch('code-reviewer (plugin_config.reviewer_effort, high when unset)', expected, given, 'To change it for every review, config_set(key="reviewer_effort", value=...).');
}
export const requireSpawnEffort = (payload, env) => {
    const subagent = toolInputRaw(payload, 'subagent_type');
    const given = givenEffort(payload);
    if (/(^|:)swe$/.test(subagent))
        return sweVerdict(payload, given, env);
    if (normalizeRole(subagent.slice(subagent.lastIndexOf(':') + 1)) === CODE_REVIEWER_ROLE)
        return reviewerVerdict(given, env);
    return ALLOW;
};
//# sourceMappingURL=require-spawn-effort.js.map