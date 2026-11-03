/**
 * PreToolUse(validation_record) gate of the trajectory-gates chain (GH 1692),
 * the port of scripts/hooks/reviewer-identity-observe.sh: when a code-reviewer
 * subagent (agent_id present, agent_type normalizing to code-reviewer) calls
 * validation_record with an integer task_id and attempt_n, it writes one
 * reviewer_identity_observed audit row on the task's issue, which
 * validation_record consumes to stamp the reviewer's identity. Observe-only:
 * it allows, except that a DB read error or a failed write denies with the
 * DB-unavailable reason.
 *
 * Unlike the .sh, it needs neither jq nor the sqlite3 CLI, so it records the
 * caller on a machine without them where the .sh recorded nothing
 * (decision 703).
 */
import { ALLOW } from './gate.js';
import { auditAppend, nowIso } from './lib/audit.js';
import { dbPath, dbState, denyDbUnavailable, GATE_READ_ERROR, gateRead, sqlInt } from './lib/db.js';
import { jqCompact } from './lib/jq.js';
import { jqCapture, jqInput, jqNumber } from './lib/jq-raw.js';
import { CODE_REVIEWER_ROLE, normalizeRole } from './lib/role.js';
export const GATE_NAME = 'reviewer-identity-observe';
const VALIDATION_RECORD_TOOL = /^mcp__[\s\S]*trajectory-server__validation_record$/;
function denyUnavailable(env, stdout = '') {
    return { stdout: `${stdout}${denyDbUnavailable(GATE_NAME, env)}\n`, code: 0 };
}
export const reviewerIdentityObserve = (payload, env) => {
    const input = jqInput(payload);
    if (!VALIDATION_RECORD_TOOL.test(jqCapture(input, ['tool_name'])))
        return ALLOW;
    const agentId = jqCapture(input, ['agent_id']);
    if (agentId === '')
        return ALLOW;
    if (normalizeRole(jqCapture(input, ['agent_type'])) !== CODE_REVIEWER_ROLE)
        return ALLOW;
    const taskId = sqlInt(jqCapture(input, ['tool_input', 'task_id']));
    const attemptN = sqlInt(jqCapture(input, ['tool_input', 'attempt_n']));
    if (taskId === '' || attemptN === '')
        return ALLOW;
    const sessionId = jqCapture(input, ['session_id']);
    const toolUseId = jqCapture(input, ['tool_use_id']);
    const db = dbPath(env, (line) => process.stderr.write(`${line}\n`));
    const state = dbState(env);
    if (state === 'unresolved' || db === null)
        return ALLOW;
    if (state === 'error')
        return denyUnavailable(env);
    const issueId = gateRead(db, `SELECT issue_id FROM tasks WHERE id = ${taskId};`, env);
    if (issueId === GATE_READ_ERROR)
        return denyUnavailable(env);
    if (issueId === '')
        return ALLOW;
    const content = jqCompact({
        task_id: jqNumber(taskId),
        attempt_n: jqNumber(attemptN),
        session_id: sessionId,
        agent_id: agentId,
        tool_use_id: toolUseId === '' ? null : toolUseId,
        observed_at: nowIso(),
        consumed: 0,
    });
    const w = auditAppend(db, {
        issueId,
        branchId: '',
        fromNode: `hook:${GATE_NAME}`,
        eventType: 'reviewer_identity_observed',
        summary: `code-reviewer ${agentId} called validation_record for task ${taskId} attempt ${attemptN}`,
        contentJson: content,
    }, { env, caller: GATE_NAME });
    if (w.ok)
        return { stdout: w.stdout, code: 0 };
    process.stderr.write(`${w.error}\n`);
    return denyUnavailable(env, w.stdout);
};
//# sourceMappingURL=reviewer-identity-observe.js.map