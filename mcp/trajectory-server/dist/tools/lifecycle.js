import { insertAudit } from './audit.js';
import { closeOpenRunsForTask } from './agent-runs.js';
import { dropTaskOverlay } from '../world-model/overlay.js';
import { batchReviewedSql, GATE_SKIP_RECORDED_SQL, HAS_PASS_SQL, waivedSql } from '../review-sql.js';
import { storedExemptSql } from '../stored-mode.js';
import { sqlText, taskStatusUpdate } from '../task-status.js';
// Task statuses that still hold work open on an issue.
export const LIVE_TASK_STATUSES = ['pending', 'running', 'needs_validation', 'completed'];
const LIVE_IN = LIVE_TASK_STATUSES.map((s) => `'${s}'`).join(', ');
export const WAIVE_REVIEW_REASON_MIN = 10;
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
// Closed tasks of an issue with neither a passing review, a batch review, an
// agile review_waived row nor a recorded bypass/waiver for their current
// commit. A task closed under exempt owes no review, so it is never listed.
export function closedTasksWithoutReview(db, issueId) {
    return db.all(`SELECT t.id, t.issue_id, t.branch_id, t.status, t.commit_sha FROM tasks t
      WHERE t.issue_id = ? AND t.status = 'closed' AND NOT ${storedExemptSql('t')}
        AND NOT ${HAS_PASS_SQL} AND NOT ${GATE_SKIP_RECORDED_SQL} AND NOT ${batchReviewedSql('t')} AND NOT ${waivedSql('t')}
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
// Call inside the transaction that closes a task under workflow_mode 'agile',
// with task.commit_sha set to the sha the close writes: when the task has no
// passing review for that commit, one bro review_queued audit row queues it
// for the grouped review (AGILE_QUEUED_SQL), at most one per (task, commit).
// Returns whether the task is queued for that commit.
export function recordReviewQueuedIfUnreviewed(db, task, now) {
    if (reviewStateAt(db, task.id, task.commit_sha).pass)
        return false;
    const queued = db.get(`SELECT COUNT(*) AS n FROM audit q
      WHERE q.event_type = 'review_queued' AND q.from_node = 'bro' AND json_valid(q.content_json)
        AND json_extract(q.content_json, '$.task_id') = ? AND json_extract(q.content_json, '$.commit_sha') = ?`, [task.id, task.commit_sha]);
    if ((queued?.n ?? 0) > 0)
        return true;
    insertAudit(db, {
        issue_id: task.issue_id,
        branch_id: task.branch_id,
        from_node: 'bro',
        event_type: 'review_queued',
        summary: `Task ${task.id} closed under agile review mode, queued for review`,
        content_json: JSON.stringify({ task_id: task.id, commit_sha: task.commit_sha }),
        created_at: now,
    });
    return true;
}
// Escalates every live task of an issue (cascade of issue_close), one
// task_escalated_by_issue_close audit row each, open runs closed issue_closed.
export function escalateLiveTasksForIssueClose(db, tasks, reason, now) {
    for (const task of tasks) {
        const escalate = taskStatusUpdate({
            status: 'escalated',
            set: { completed_at: null, updated_at: now },
            where: sqlText('id = ?', task.id),
        });
        db.run(escalate.sql, escalate.params);
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
        dropTaskOverlay(db, task.id);
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
                const sweep = taskStatusUpdate({
                    status: 'failed',
                    set: { completed_at: null, updated_at: now },
                    where: sqlText('id = ?', task.id),
                });
                db.run(sweep.sql, sweep.params);
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