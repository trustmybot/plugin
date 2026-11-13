/**
 * PreToolUse(Agent) gate (GH 1692), run by agent-spawn-dispatch: a code-reviewer spawn naming task_id=<N> is
 * allowed only for a completed or needs_validation task with a review_handoff
 * audit row for its current tasks.commit_sha (bro handed that commit to
 * review), or for a closed task (a task closed under the old close-then-review
 * order, or the integrate head review). Every other status is denied. No
 * task_id, no resolvable DB or no tasks row allows; a DB read error denies
 * with the DB-unavailable reason.
 *
 * task_id is the first `task_id[[:space:]]*=[[:space:]]*[0-9]+` of the
 * prompt, line by line as macOS grep reads it (`[:space:]` adds Unicode
 * spaces under a UTF-8 locale). It needs neither jq nor the sqlite3 CLI.
 * Bypass: TMB_SKIP_CODE_REVIEWER_CLOSE_GATE=1.
 */
import { ALLOW } from './gate.js';
import { isCodeReviewerSpawn, spawnDeny, spawnField } from './code-reviewer-no-worktree.js';
import { dbPath, denyDbUnavailable, GATE_READ_ERROR, gateRead, haveSqlite, sqlInt } from './lib/db.js';
import { grepMultibyte, grepSpace } from './lib/lint-shell.js';
export const GATE_NAME = 'code-reviewer-after-atomic-close';
export const BYPASS_ENV = 'TMB_SKIP_CODE_REVIEWER_CLOSE_GATE';
const REVIEWABLE_UNCLOSED = new Set(['completed', 'needs_validation']);
export function notHandedOffReason(taskId, status) {
    return `BLOCKED: code-reviewer spawn for task ${taskId} (status=${status}) has no review_handoff for the task's current commit.

Per tmb_planning section 6 (Verify on SWE return + review handoff):
  1. SWE returns status=completed (lifecycle answer, NOT a DB closure).
  2. bro verifies the return (task_brief + git diff, the four section-6 checks), then calls review_handoff.
  3. ONLY THEN: spawn code-reviewer with the reviewer_spawn review_handoff returned; bro_atomic_close follows its pass.

code-reviewer reviews a completed or needs_validation task handed off at its current commit, or a closed task.`;
}
export function notHandedOffFix(taskId) {
    return { allowed: `review_handoff(agent='bro', task_id=${taskId}, session_id=<your session id>) once the task is completed, then the reviewer_spawn it returns` };
}
/** `printf '%s' "$PROMPT" | grep -Eo 'task_id[[:space:]]*=[[:space:]]*[0-9]+' | head -1 | grep -Eo '[0-9]+' | head -1`. */
export function promptTaskId(prompt, multibyte) {
    const space = grepSpace(multibyte);
    const re = new RegExp(`task_id[${space}]*=[${space}]*([0-9]+)`, multibyte ? 'u' : '');
    const text = multibyte ? prompt : Buffer.from(prompt, 'utf8').toString('latin1');
    for (const line of text.split('\n')) {
        const m = re.exec(line);
        if (m)
            return m[1];
    }
    return '';
}
const reviewStateSql = (taskId) => `SELECT t.status || '|' || EXISTS (SELECT 1 FROM audit a
      WHERE a.event_type = 'review_handoff' AND json_valid(a.content_json)
        AND json_extract(a.content_json, '$.task_id') = t.id
        AND json_extract(a.content_json, '$.commit_sha') = t.commit_sha)
    FROM tasks t WHERE t.id = ${taskId};`;
export const codeReviewerAfterAtomicClose = (payload, env) => {
    if (env[BYPASS_ENV] === '1')
        return ALLOW;
    if (!isCodeReviewerSpawn(payload))
        return ALLOW;
    const taskId = sqlInt(promptTaskId(spawnField(payload, 'tool_input', 'prompt'), grepMultibyte(env)));
    if (taskId === '')
        return ALLOW;
    const db = dbPath(env);
    if (db === null || !haveSqlite(env))
        return ALLOW;
    const state = gateRead(db, reviewStateSql(taskId), env);
    if (state === GATE_READ_ERROR)
        return { stdout: `${denyDbUnavailable(GATE_NAME, env)}\n`, code: 0 };
    if (state === '')
        return ALLOW;
    const sep = state.lastIndexOf('|');
    const status = state.slice(0, sep);
    if (status === 'closed')
        return ALLOW;
    if (REVIEWABLE_UNCLOSED.has(status) && state.slice(sep + 1) === '1')
        return ALLOW;
    return spawnDeny(notHandedOffReason(taskId, status), notHandedOffFix(taskId));
};
//# sourceMappingURL=code-reviewer-after-atomic-close.js.map