import { insertAudit } from './audit.js';
import { closeOpenRunsForTask } from './agent-runs.js';
// Task statuses that still hold work open on an issue.
export const LIVE_TASK_STATUSES = ['pending', 'running', 'needs_validation', 'completed'];
const LIVE_IN = LIVE_TASK_STATUSES.map((s) => `'${s}'`).join(', ');
export const WAIVE_REVIEW_REASON_MIN = 10;
// A task has a passing review when a validation_attempts row with
// verdict='pass' was recorded at or after the review anchor of its current
// commit: the earliest bro_verification_pass audit row naming this task and
// this commit_sha (bro's first verification of that exact commit). No such
// row = no anchor = no pass; completed_at is not an anchor because no audit
// row records which sha a completion carried. validation_attempts carries no
// commit_sha, so time is the only link. close-issue-on-merge.sh
// (_CIM_HAS_PASS) and cleanup-worktree-on-task-close.sh (_CWC_HAS_PASS) hold
// byte-identical copies; a unit test pins them equal.
export const HAS_PASS_SQL = `EXISTS (SELECT 1 FROM validation_attempts va
  WHERE va.task_id = t.id AND va.verdict = 'pass' AND va.created_at >= (
    SELECT MIN(a.created_at) FROM audit a
      WHERE a.event_type = 'bro_verification_pass' AND json_valid(a.content_json)
        AND json_extract(a.content_json, '$.task_id') = t.id
        AND json_extract(a.content_json, '$.commit_sha') = t.commit_sha))`;
// A recorded bypass or waiver for the task's current commit means the
// trajectory already says the review gate was skipped. Only bro authors a
// waiver; a bypass is bro's (a server close path) or close-issue-on-merge's.
// Rows from any other author do not count. close-issue-on-merge.sh holds a
// byte-identical copy (_CIM_SKIP_RECORDED). trajectory_doctor's
// closed_tasks_reviewed contract trusts the same authors.
export const reviewSkipAuthoredSql = (alias) => `((${alias}.event_type = 'review_gate_waived' AND ${alias}.from_node = 'bro')
      OR (${alias}.event_type = 'review_gate_bypassed' AND ${alias}.from_node IN ('bro', 'hook:close-issue-on-merge')))`;
export const GATE_SKIP_RECORDED_SQL = `EXISTS (SELECT 1 FROM audit g
  WHERE ${reviewSkipAuthoredSql('g')}
    AND json_valid(g.content_json)
    AND json_extract(g.content_json, '$.task_id') = t.id
    AND COALESCE(json_extract(g.content_json, '$.commit_sha'), '') = COALESCE(t.commit_sha, ''))`;
export function liveTasksOfIssue(db, issueId) {
    return db.all(`SELECT id, issue_id, branch_id, status, commit_sha FROM tasks
      WHERE issue_id = ? AND status IN (${LIVE_IN}) ORDER BY id`, [issueId]);
}
export function taskHasPassingReview(db, taskId) {
    const row = db.get(`SELECT ${HAS_PASS_SQL} AS ok FROM tasks t WHERE t.id = ?`, [taskId]);
    return row?.ok === 1;
}
// Judges a task as if its commit_sha were `commitSha` (the sha a close is
// about to write): a pass, or a bypass/waiver already recorded for it.
function reviewStateAt(db, taskId, commitSha) {
    const row = db.get(`SELECT ${HAS_PASS_SQL} AS pass, ${GATE_SKIP_RECORDED_SQL} AS skip
       FROM (SELECT id, ? AS commit_sha FROM tasks WHERE id = ?) t`, [commitSha, taskId]);
    return { pass: row?.pass === 1, skipRecorded: row?.skip === 1 };
}
// Closed tasks of an issue with neither a passing review nor a recorded
// bypass/waiver for their current commit.
export function closedTasksWithoutReview(db, issueId) {
    return db.all(`SELECT t.id, t.issue_id, t.branch_id, t.status, t.commit_sha FROM tasks t
      WHERE t.issue_id = ? AND t.status = 'closed'
        AND NOT ${HAS_PASS_SQL} AND NOT ${GATE_SKIP_RECORDED_SQL}
      ORDER BY t.id`, [issueId]);
}
// Call inside the transaction that moves a task to closed, with
// task.commit_sha set to the sha the close writes: when the task has no
// passing review for that commit and no bypass/waiver is recorded for it yet,
// one review_gate_bypassed audit row records who closed it anyway, so a
// (task, commit) carries at most one such row across any status hops.
// Returns whether the row was written.
export function recordReviewBypassIfUnreviewed(db, task, closedBy, fromNode, now) {
    const state = reviewStateAt(db, task.id, task.commit_sha);
    if (state.pass || state.skipRecorded)
        return false;
    insertAudit(db, {
        issue_id: task.issue_id,
        branch_id: task.branch_id,
        from_node: fromNode,
        event_type: 'review_gate_bypassed',
        summary: `Task ${task.id} closed by ${closedBy} without a passing review`,
        content_json: JSON.stringify({ task_id: task.id, commit_sha: task.commit_sha, closed_by: closedBy }),
        created_at: now,
    });
    return true;
}
// Escalates every live task of an issue (cascade of issue_close), one
// task_escalated_by_issue_close audit row each, open runs closed issue_closed.
export function escalateLiveTasksForIssueClose(db, tasks, reason, now) {
    for (const task of tasks) {
        db.run(`UPDATE tasks SET status = 'escalated', completed_at = NULL, updated_at = ? WHERE id = ?`, [now, task.id]);
        insertAudit(db, {
            issue_id: task.issue_id,
            branch_id: task.branch_id,
            from_node: 'bro',
            event_type: 'task_escalated_by_issue_close',
            summary: `Task ${task.id} escalated from ${task.status} by issue_close cascade`,
            content_json: JSON.stringify({ task_id: task.id, from_status: task.status, reason }),
            created_at: now,
        });
        closeOpenRunsForTask(db, task.id, now, 'issue_closed');
    }
}
export function markIssueClosed(db, issueId, now) {
    db.run(`UPDATE issues SET status = 'closed', updated_at = ?, closed_at = COALESCE(closed_at, ?) WHERE id = ?`, [now, now, issueId]);
}
export const STALE_RUNNING_HOURS_DEFAULT = 6;
export const STALE_PENDING_DAYS = 7;
export function staleRunningHours(env = process.env) {
    const raw = Number(env['TMB_STALE_RUNNING_HOURS']);
    return Number.isFinite(raw) && raw > 0 ? raw : STALE_RUNNING_HOURS_DEFAULT;
}
// Running tasks whose swe is gone (no open swe agent_runs row) and that have
// not moved for staleRunningHours() become failed, one task_stale_swept audit
// row each, their open runs closed swept_stale. Pending tasks untouched for
// STALE_PENDING_DAYS are reported, never changed.
export function sweepStaleTasks(db, now) {
    const nowMs = Date.parse(now);
    const hours = staleRunningHours();
    const runningCutoff = new Date(nowMs - hours * 3_600_000).toISOString();
    const pendingCutoff = new Date(nowMs - STALE_PENDING_DAYS * 86_400_000).toISOString();
    const stale = db.all(`SELECT t.id, t.issue_id, t.branch_id, t.status, t.commit_sha, t.updated_at FROM tasks t
      WHERE t.status = 'running' AND t.updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM agent_runs r
                         WHERE r.task_id = t.id AND r.agent_type = 'swe' AND r.completed_at IS NULL)
      ORDER BY t.id`, [runningCutoff]);
    let runsSwept = 0;
    if (stale.length > 0) {
        db.transaction(() => {
            for (const task of stale) {
                db.run(`UPDATE tasks SET status = 'failed', completed_at = NULL, updated_at = ? WHERE id = ?`, [now, task.id]);
                insertAudit(db, {
                    issue_id: task.issue_id,
                    branch_id: task.branch_id,
                    from_node: 'bro',
                    event_type: 'task_stale_swept',
                    summary: `Running task ${task.id} with no live swe since ${task.updated_at} swept to failed`,
                    content_json: JSON.stringify({
                        task_id: task.id,
                        from_status: 'running',
                        last_updated_at: task.updated_at,
                        stale_after_hours: hours,
                    }),
                    created_at: now,
                });
                runsSwept += closeOpenRunsForTask(db, task.id, now, 'swept_stale');
            }
        });
    }
    const reported = db.all(`SELECT id AS task_id, issue_id, status, updated_at FROM tasks
      WHERE status = 'pending' AND updated_at < ? ORDER BY id`, [pendingCutoff]);
    return { tasks_swept: stale.map((t) => t.id), runs_swept: runsSwept, reported };
}
//# sourceMappingURL=lifecycle.js.map