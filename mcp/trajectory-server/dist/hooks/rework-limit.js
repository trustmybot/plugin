/**
 * PreToolUse(Agent) gate (GH 1738), run by agent-spawn-dispatch.sh: a swe
 * spawn for task_id=<N> is denied once the task has REWORK_FAIL_LIMIT (2) or
 * more review FAILs since its latest pass, unless something newer than the
 * latest FAIL changes the plan:
 *
 *   - a `kind='decision'` discussion on the task, or an issue-level one
 *     (task_id NULL) on its issue, or
 *   - any discussion row on its issue authored by the Human (the waiver).
 *
 * The rows are counted, never judged. Only swe spawns naming task_id=<N> are
 * judged; a missing task_id is require-task-spec's. No resolvable DB or no
 * tasks row allows, a DB read failure denies.
 */
import { ALLOW } from './gate.js';
import { dbPath, denyDbUnavailable, gateRead, GATE_READ_ERROR, haveSqlite, sqlInt } from './lib/db.js';
import { jqAlternatives, jqCompact } from './lib/jq.js';
import { normalizeRole } from './lib/role.js';
import { REWORK_FAIL_LIMIT } from '../task-rework.js';
export const GATE_NAME = 'rework-limit';
function readState(db, taskId, env) {
    const out = gateRead(db, `WITH t AS (SELECT id, issue_id FROM tasks WHERE id = ${taskId}),
          since AS (SELECT COALESCE(MAX(v.id), 0) AS pass_id FROM validation_attempts v, t
                     WHERE v.task_id = t.id AND v.verdict = 'pass'),
          fails AS (SELECT v.id, v.created_at FROM validation_attempts v, t, since
                     WHERE v.task_id = t.id AND v.verdict = 'fail' AND v.id > since.pass_id),
          latest AS (SELECT created_at FROM fails ORDER BY id DESC LIMIT 1)
     SELECT json_object(
       'fails', (SELECT COUNT(*) FROM fails),
       'last_fail_at', (SELECT created_at FROM latest),
       'waived', EXISTS (SELECT 1 FROM discussions d, t, latest
                          WHERE d.issue_id = t.issue_id AND d.created_at > latest.created_at
                            AND ((d.kind = 'decision' AND (d.task_id = t.id OR d.task_id IS NULL)) OR d.author = 'human')))
     FROM t;`, env);
    if (out === GATE_READ_ERROR)
        return GATE_READ_ERROR;
    if (out === '')
        return null;
    const row = JSON.parse(out.split('\n')[0]);
    return { fails: row.fails, lastFailAt: row.last_fail_at, waived: row.waived === 1 };
}
export function denyReason(taskId, state) {
    return (`BLOCKED: task ${taskId} has ${state.fails} review FAILs since its last pass (the latest at ${state.lastFailAt}) ` +
        'and no decision since, so a further swe spawn would repeat the approach that failed. Before spawning swe again, do one of: ' +
        `write a decision naming the change of approach (discussion_append kind='decision' task_id=${taskId}); ` +
        'task_retry with a redesigned spec; split the task into smaller tasks; or ask the Human (a Human comment on the issue waives this).');
}
function deny(reason) {
    return {
        stdout: `${jqCompact({
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
        })}\n`,
        code: 0,
    };
}
export const reworkLimit = (payload, env) => {
    if (jqAlternatives(payload, [['tool_name']]) !== 'Agent')
        return ALLOW;
    if (normalizeRole(jqAlternatives(payload, [['tool_input', 'subagent_type']])) !== 'swe')
        return ALLOW;
    const m = /task_id\s*=\s*([0-9]+)/.exec(jqAlternatives(payload, [['tool_input', 'prompt']]));
    const taskId = sqlInt(m?.[1] ?? '');
    if (taskId === '')
        return ALLOW;
    const db = dbPath(env);
    if (db === null)
        return ALLOW;
    if (!haveSqlite(env))
        return { stdout: `${denyDbUnavailable(GATE_NAME, env)}\n`, code: 0 };
    const state = readState(db, taskId, env);
    if (state === GATE_READ_ERROR)
        return { stdout: `${denyDbUnavailable(GATE_NAME, env)}\n`, code: 0 };
    if (state === null || state.fails < REWORK_FAIL_LIMIT || state.waived)
        return ALLOW;
    return deny(denyReason(taskId, state));
};
//# sourceMappingURL=rework-limit.js.map