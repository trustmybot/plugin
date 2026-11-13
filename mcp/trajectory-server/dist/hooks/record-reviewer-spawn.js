/**
 * The record-reviewer-spawn gate (GH 2684), the last PREPARE step of
 * agent-spawn-dispatch, so it runs only once every spawn gate allowed: a
 * code-reviewer spawn whose prompt carries integer task_id= and attempt_n=
 * and a 7-40 hex commit_sha= writes one reviewer_spawn_observed audit row
 * {task_id, attempt_n, commit_sha} on the task's issue. validation_record
 * copies the newest row's commit_sha for (task_id, attempt_n) into
 * validation_attempts.reviewed_sha.
 *
 * Fail-open: it always allows and prints nothing; a missing DB, an unknown
 * task or a failed write records nothing.
 */
import { ALLOW } from './gate.js';
import { isCodeReviewerSpawn, spawnField } from './code-reviewer-no-worktree.js';
import { auditAppend } from './lib/audit.js';
import { dbPath, dbState, GATE_READ_ERROR, gateRead } from './lib/db.js';
import { jqCompact } from './lib/jq.js';
export const GATE_NAME = 'record-reviewer-spawn';
export const FROM_NODE = `hook:${GATE_NAME}`;
function anchor(prompt, name, value) {
    const re = new RegExp(`(?<![A-Za-z0-9_])${name}\\s*=\\s*(['"\`]?)(${value})\\1(?![A-Za-z0-9_])`);
    return re.exec(prompt)?.[2] ?? null;
}
/** The prompt's task_id, attempt_n and commit_sha anchors, or null when any is missing or malformed. */
export function reviewerSpawnAnchors(prompt) {
    const taskId = anchor(prompt, 'task_id', '[0-9]+');
    const attemptN = anchor(prompt, 'attempt_n', '[0-9]+');
    const commitSha = anchor(prompt, 'commit_sha', '[0-9a-fA-F]{7,40}');
    if (taskId === null || attemptN === null || commitSha === null)
        return null;
    const t = Number(taskId);
    const a = Number(attemptN);
    if (!Number.isSafeInteger(t) || !Number.isSafeInteger(a))
        return null;
    return { taskId: t, attemptN: a, commitSha: commitSha.toLowerCase() };
}
export const recordReviewerSpawn = (payload, env) => {
    if (!isCodeReviewerSpawn(payload))
        return ALLOW;
    const anchors = reviewerSpawnAnchors(spawnField(payload, 'tool_input', 'prompt'));
    if (anchors === null)
        return ALLOW;
    const db = dbPath(env);
    if (db === null || dbState(env) !== 'ok')
        return ALLOW;
    const issueId = gateRead(db, `SELECT issue_id FROM tasks WHERE id = ${anchors.taskId};`, env).split('\n')[0];
    if (issueId === GATE_READ_ERROR || issueId === '')
        return ALLOW;
    auditAppend(db, {
        issueId,
        branchId: '',
        fromNode: FROM_NODE,
        eventType: 'reviewer_spawn_observed',
        summary: `code-reviewer spawned for task ${anchors.taskId} attempt ${anchors.attemptN} at ${anchors.commitSha}`,
        contentJson: jqCompact({ task_id: anchors.taskId, attempt_n: anchors.attemptN, commit_sha: anchors.commitSha }),
    }, { env, caller: GATE_NAME });
    return ALLOW;
};
//# sourceMappingURL=record-reviewer-spawn.js.map