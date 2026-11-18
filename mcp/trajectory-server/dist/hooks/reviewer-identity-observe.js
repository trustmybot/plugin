/**
 * PreToolUse(validation_record, review_batch_record) gate of the
 * trajectory-gates chain (GH 1692, GH 2225): when a code-reviewer subagent
 * (agent_id present, agent_type normalizing to code-reviewer) calls
 * validation_record with an integer task_id and attempt_n, it writes one
 * reviewer_identity_observed audit row on the task's issue, which
 * validation_record consumes to stamp the reviewer's identity. A
 * review_batch_record call with integer task_ids and a head_sha writes one
 * such row on the first task's issue, keyed by reviewBatchKey, which
 * review_batch_record consumes the same way. Observe-only: it allows, except
 * that a DB read error or a failed write denies with the DB-unavailable reason.
 *
 * It needs neither jq nor the sqlite3 CLI.
 */
import { ALLOW } from './gate.js';
import { auditAppend, nowIso } from './lib/audit.js';
import { dbPath, dbState, denyDbUnavailable, GATE_READ_ERROR, gateRead, sqlInt } from './lib/db.js';
import { jqCompact } from './lib/jq.js';
import { jqCapture, jqInput, jqNumber } from './lib/jq-raw.js';
import { CODE_REVIEWER_ROLE, normalizeRole } from './lib/role.js';
import { reviewBatchKey } from '../review-sql.js';
export const GATE_NAME = 'reviewer-identity-observe';
const VALIDATION_RECORD_TOOL = /^mcp__[\s\S]*trajectory-server__validation_record$/;
const REVIEW_BATCH_RECORD_TOOL = /^mcp__[\s\S]*trajectory-server__review_batch_record$/;
const HEAD_SHA_RE = /^[0-9a-f]{7,64}$/i;
function denyUnavailable(env, stdout = '') {
    return { stdout: `${stdout}${denyDbUnavailable(GATE_NAME, env)}\n`, code: 0 };
}
function validationRecordObservation(input) {
    const taskId = sqlInt(jqCapture(input, ['tool_input', 'task_id']));
    const attemptN = sqlInt(jqCapture(input, ['tool_input', 'attempt_n']));
    if (taskId === '' || attemptN === '')
        return null;
    return {
        taskId,
        summary: (agentId) => `code-reviewer ${agentId} called validation_record for task ${taskId} attempt ${attemptN}`,
        content: { task_id: jqNumber(taskId), attempt_n: jqNumber(attemptN) },
    };
}
// The task ids as review_batch_record reads them: each a positive integer or
// its digit string; null when any is not, or the list is empty.
function batchTaskIds(raw) {
    if (!Array.isArray(raw) || raw.length === 0)
        return null;
    const ids = raw.map((v) => (typeof v === 'number' || (typeof v === 'string' && /^[0-9]+$/.test(v)) ? Number(v) : NaN));
    return ids.every((n) => Number.isSafeInteger(n) && n > 0) ? ids : null;
}
// The payload's numbers parse as raw-JSON literals (jqLiteralNumbers), so the
// array is read back as jq would print it and parsed as plain JSON.
function reviewBatchObservation(input) {
    let taskIds;
    try {
        taskIds = batchTaskIds(JSON.parse(jqCapture(input, ['tool_input', 'task_ids'])));
    }
    catch {
        return null;
    }
    const headSha = jqCapture(input, ['tool_input', 'head_sha']);
    if (taskIds === null || !HEAD_SHA_RE.test(headSha))
        return null;
    const sorted = [...new Set(taskIds)].sort((a, b) => a - b);
    return {
        taskId: String(sorted[0]),
        summary: (agentId) => `code-reviewer ${agentId} called review_batch_record for tasks ${sorted.join(', ')} at ${headSha}`,
        content: { tool: 'review_batch_record', task_ids: sorted, head_sha: headSha.toLowerCase(), batch_key: reviewBatchKey(sorted, headSha) },
    };
}
export const reviewerIdentityObserve = (payload, env) => {
    const input = jqInput(payload);
    const toolName = jqCapture(input, ['tool_name']);
    const isValidationRecord = VALIDATION_RECORD_TOOL.test(toolName);
    if (!isValidationRecord && !REVIEW_BATCH_RECORD_TOOL.test(toolName))
        return ALLOW;
    const agentId = jqCapture(input, ['agent_id']);
    if (agentId === '')
        return ALLOW;
    if (normalizeRole(jqCapture(input, ['agent_type'])) !== CODE_REVIEWER_ROLE)
        return ALLOW;
    const observation = isValidationRecord ? validationRecordObservation(input) : reviewBatchObservation(input);
    if (observation === null)
        return ALLOW;
    const sessionId = jqCapture(input, ['session_id']);
    const toolUseId = jqCapture(input, ['tool_use_id']);
    const db = dbPath(env, (line) => process.stderr.write(`${line}\n`));
    const state = dbState(env);
    if (state === 'unresolved' || db === null)
        return ALLOW;
    if (state === 'error')
        return denyUnavailable(env);
    const issueId = gateRead(db, `SELECT issue_id FROM tasks WHERE id = ${observation.taskId};`, env);
    if (issueId === GATE_READ_ERROR)
        return denyUnavailable(env);
    if (issueId === '')
        return ALLOW;
    const content = jqCompact({
        ...observation.content,
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
        summary: observation.summary(agentId),
        contentJson: content,
    }, { env, caller: GATE_NAME });
    if (w.ok)
        return { stdout: w.stdout, code: 0 };
    process.stderr.write(`${w.error}\n`);
    return denyUnavailable(env, w.stdout);
};
//# sourceMappingURL=reviewer-identity-observe.js.map