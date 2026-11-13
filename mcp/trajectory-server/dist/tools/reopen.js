import { REWORK_FLOOR_EFFORT, failsSinceLastPassSql } from '../task-rework.js';
import { insertAudit } from './audit.js';
import { effortRank } from './config.js';
import { insertDiscussion } from './discussions.js';
// One task_effort_raised row: a rework (task_reopen, or a code-reviewer FAIL)
// or retry (task_retry) raised the effort swe runs the task at.
export function insertEffortRaised(db, task, from, to, agent, now, failedTaskId) {
    insertAudit(db, {
        issue_id: task.issue_id,
        branch_id: task.branch_id,
        from_node: agent,
        event_type: 'task_effort_raised',
        summary: `Task ${task.task_id} effort raised: ${from} → ${to}`,
        content_json: JSON.stringify({
            task_id: task.task_id,
            from,
            to,
            ...(failedTaskId !== undefined ? { failed_task_id: failedTaskId } : {}),
        }),
        created_at: now,
    });
}
/** Sets the task running at w.effort and writes its decision, task_reopened and (on a raise) task_effort_raised rows; true when the effort was raised. */
export function applyReopenInTx(db, w) {
    const { task } = w;
    const fenceSql = w.fence ? 'files = ?, verification = ?, ' : '';
    const gateSql = w.envGate ? ', base_sha = ?, wm_commit = ?' : '';
    db.run(`UPDATE tasks SET status = 'running', ${fenceSql}effort = ?, completed_at = NULL,
            completion_report = NULL, spawn_note = ?, updated_at = ?${gateSql}
      WHERE id = ?`, [
        ...(w.fence ? [JSON.stringify(w.fence.files), JSON.stringify(w.fence.verification)] : []),
        w.effort,
        w.spawnNote,
        w.now,
        ...(w.envGate ? [w.envGate.base_sha, w.envGate.wm_commit] : []),
        task.id,
    ]);
    const bodyLines = [
        `Task ${task.id} reopened from ${task.status}: ${w.reason}`,
        ...(w.decisionLines ?? []),
        w.effort !== task.effort ? `effort: ${task.effort} → ${w.effort}` : null,
        w.envGate?.decisionNote ?? null,
    ].filter((l) => l !== null);
    insertDiscussion(db, {
        issue_id: task.issue_id,
        author: w.agent,
        kind: 'decision',
        body: bodyLines.join('\n'),
        created_at: w.now,
        task_id: task.id,
    });
    insertAudit(db, {
        issue_id: task.issue_id,
        branch_id: task.branch_id,
        from_node: w.agent,
        event_type: 'task_reopened',
        summary: `Task ${task.id} reopened from ${task.status}: ${w.reason}`.slice(0, 200),
        content_json: JSON.stringify({ task_id: task.id, from_status: task.status, reason: w.reason, ...w.auditContent }),
        created_at: w.now,
    });
    const raised = effortRank(w.effort) > effortRank(task.effort);
    if (raised) {
        insertEffortRaised(db, { issue_id: task.issue_id, branch_id: task.branch_id, task_id: task.id }, task.effort, w.effort, w.agent, w.now);
    }
    return raised;
}
/** True while task <taskId> has a review FAIL since its last passing review. */
export function hasFailSinceLastPass(db, taskId) {
    return (db.get(`SELECT ${failsSinceLastPassSql('?1')} AS n`, [taskId])?.n ?? 0) > 0;
}
/** <effort>, raised to the rework floor when below it. */
export const atLeastReworkFloor = (effort) => effortRank(effort) >= effortRank(REWORK_FLOOR_EFFORT) ? effort : REWORK_FLOOR_EFFORT;
/** The rework change whose analysis re-hands a FAILed, unchanged commit to a new code-reviewer. */
export const RE_REVIEW_CHANGE = 're_review';
// Either SHA may be the other's prefix: tasks and validation rows store short or full SHAs.
const sameCommit = (a, b) => {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x.startsWith(y) || y.startsWith(x);
};
/**
 * Whether review_handoff may re-hand running task <task>'s commit to a new
 * code-reviewer after a FAIL reopened it (GH 2866, decision 3481). An
 * allowlist: the latest verdict is a FAIL on the task's current commit, no swe
 * run of the task is live, a passing verification run is recorded for that
 * commit, and the task's latest task_rework_analysis, dated after the FAIL,
 * names re_review. Returns the re-review, with the completion report and stamp
 * the FAIL's reopen cleared, or the refusal naming the first unmet condition.
 */
export function reReviewAdmission(db, task) {
    if (!task.commit_sha)
        return { refusal: `task ${task.id} records no commit_sha to re-review` };
    const fail = db.get('SELECT id, verdict, reviewed_sha, created_at FROM validation_attempts WHERE task_id = ? ORDER BY id DESC LIMIT 1', [task.id]);
    if (!fail || fail.verdict !== 'fail') {
        return { refusal: `task ${task.id}'s latest review verdict is ${fail ? `'${fail.verdict}' (validation ${fail.id})` : 'missing'}, not a FAIL` };
    }
    // reviewed_sha is NULL when no reviewer spawn was observed; the handoff the FAIL answered names the commit then.
    const reviewed = fail.reviewed_sha ??
        db.get(`SELECT json_extract(content_json, '$.commit_sha') AS sha FROM audit
        WHERE event_type = 'review_handoff' AND issue_id = ? AND json_valid(content_json)
          AND json_extract(content_json, '$.task_id') = ? AND created_at <= ?
        ORDER BY created_at DESC, id DESC LIMIT 1`, [task.issue_id, task.id, fail.created_at])?.sha ??
        null;
    if (!reviewed || !sameCommit(reviewed, task.commit_sha)) {
        return { refusal: `FAIL validation ${fail.id} reviewed ${reviewed ?? 'no recorded commit'}, not the task's current commit ${task.commit_sha}` };
    }
    const live = db.get("SELECT id FROM agent_runs WHERE task_id = ? AND agent_type = 'swe' AND completed_at IS NULL ORDER BY id LIMIT 1", [task.id]);
    if (live)
        return { refusal: `swe run ${live.id} of task ${task.id} is live` };
    const passing = db
        .all(`SELECT commit_sha FROM verification_runs
        WHERE task_id = ? AND commit_sha <> '' AND exit_code = 0 AND timed_out = 0 AND finished_at IS NOT NULL`, [task.id])
        .some((r) => sameCommit(r.commit_sha, task.commit_sha));
    if (!passing)
        return { refusal: `no passing verification run is recorded for commit ${task.commit_sha}` };
    const analysis = db.get(`SELECT id, created_at, json_extract(content_json, '$.change') AS change_kind FROM audit
      WHERE event_type = 'task_rework_analysis' AND issue_id = ? AND json_valid(content_json)
        AND json_extract(content_json, '$.task_id') = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`, [task.issue_id, task.id]);
    if (!analysis || analysis.created_at <= fail.created_at || analysis.change_kind !== RE_REVIEW_CHANGE) {
        return {
            refusal: `task ${task.id}'s latest task_rework_analysis ` +
                (analysis ? `(audit ${analysis.id}, change ${analysis.change_kind})` : '(none)') +
                ` is not a ${RE_REVIEW_CHANGE} analysis dated after FAIL validation ${fail.id}`,
        };
    }
    const reopened = db.get(`SELECT content_json FROM audit
      WHERE event_type = 'task_reopened' AND json_valid(content_json)
        AND json_extract(content_json, '$.task_id') = ? AND json_extract(content_json, '$.validation_id') = ?
      ORDER BY id DESC LIMIT 1`, [task.id, fail.id]);
    const cleared = reopened ? JSON.parse(reopened.content_json) : {};
    return {
        failValidationId: fail.id,
        completionReport: cleared.completion_report ?? task.completion_report,
        completedAt: cleared.completed_at ?? null,
    };
}
/** Moves a re-reviewed task back to completed with the completion its FAIL's reopen cleared. */
export function restoreForReReviewInTx(db, taskId, reReview, now) {
    db.run(`UPDATE tasks SET status = 'completed', completion_report = ?, completed_at = ?, updated_at = ? WHERE id = ?`, [reReview.completionReport, reReview.completedAt ?? now, now, taskId]);
}
//# sourceMappingURL=reopen.js.map