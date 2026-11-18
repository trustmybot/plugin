import { nowISO } from './db.js';
import { integrated } from './hooks/clean-merged-branch.js';
import { serverLog } from './logger.js';
import { insertAudit } from './tools/audit.js';
import { syncIssueCloseRemotes } from './tools/issues.js';
import { closedTasksWithoutReview, LIVE_TASK_STATUSES, liveTasksOfIssue, markIssueClosed } from './tools/lifecycle.js';
import { runGit } from './utils/git-run.js';
import { targetBranchOf } from './utils/index-target.js';
const LIVE_IN = LIVE_TASK_STATUSES.map((s) => `'${s}'`).join(', ');
// Open issues of the repo with a closed, committed task and no live task:
// the one query a repo with nothing to close costs.
function candidateIssues(db, repo) {
    return db
        .all(`SELECT i.id FROM issues i
        WHERE i.repo = ? AND i.status = 'open'
          AND EXISTS (SELECT 1 FROM tasks t WHERE t.issue_id = i.id AND t.status = 'closed' AND t.commit_sha IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.issue_id = i.id AND t.status IN (${LIVE_IN}))
        ORDER BY i.id`, [repo])
        .map((r) => r.id);
}
function closedCommitsOf(db, issueId) {
    return db.all(`SELECT id AS task_id, commit_sha FROM tasks
      WHERE issue_id = ? AND status = 'closed' AND commit_sha IS NOT NULL ORDER BY id`, [issueId]);
}
function hasOrigin(repoPath) {
    const res = runGit(repoPath, ['remote', 'get-url', 'origin']);
    return res.status === 0 && res.stdout.trim() !== '';
}
// origin/<target> when the repo has an origin, else the local target branch.
function targetRefOf(db, repo, repoPath) {
    const branch = targetBranchOf(db, repo, repoPath);
    const ref = hasOrigin(repoPath) ? `refs/remotes/origin/${branch}` : `refs/heads/${branch}`;
    return runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0 ? ref : null;
}
// Closes, in one transaction, an issue whose state still matches what git was
// asked about: open, no live task, every closed task reviewed and its commit
// among those found integrated.
function closeIfStillReached(db, issueId, reached, targetRef) {
    return db.transaction(() => {
        const status = db.get(`SELECT status FROM issues WHERE id = ?`, [issueId])?.status;
        if (status !== 'open')
            return false;
        if (liveTasksOfIssue(db, issueId).length > 0 || closedTasksWithoutReview(db, issueId).length > 0)
            return false;
        const commits = closedCommitsOf(db, issueId);
        if (commits.length === 0 || commits.some((c) => !reached.has(c.commit_sha)))
            return false;
        const now = nowISO();
        markIssueClosed(db, issueId, now);
        insertAudit(db, {
            issue_id: issueId,
            from_node: 'trajectory-server',
            writer: 'server',
            event_type: 'issue_closed_on_target_reach',
            summary: `issue ${issueId} closed: every closed task commit reached ${targetRef}`,
            content_json: JSON.stringify({
                target_ref: targetRef,
                task_ids: commits.map((c) => c.task_id),
                commit_shas: commits.map((c) => c.commit_sha),
            }),
            created_at: now,
        });
        return true;
    });
}
// Run after a checkpoint's target fetch, whatever its result (a local-only
// repo's fetch is skipped). Never throws; returns the issues it closed.
export async function closeIssuesReachedTarget(db, repo, opts) {
    const closed = [];
    try {
        const candidates = candidateIssues(db, repo);
        if (candidates.length === 0)
            return closed;
        const repoPath = db.get(`SELECT path FROM repos WHERE name = ?`, [repo])?.path;
        if (!repoPath)
            return closed;
        const targetRef = targetRefOf(db, repo, repoPath);
        if (!targetRef)
            return closed;
        const verdicts = new Map();
        for (const issueId of candidates) {
            if (closedTasksWithoutReview(db, issueId).length > 0)
                continue;
            let allReached = true;
            for (const { commit_sha } of closedCommitsOf(db, issueId)) {
                if (!verdicts.has(commit_sha))
                    verdicts.set(commit_sha, await integrated(repoPath, commit_sha, targetRef));
                if (!verdicts.get(commit_sha)) {
                    allReached = false;
                    break;
                }
            }
            if (!allReached)
                continue;
            const reached = new Set([...verdicts].filter(([, ok]) => ok).map(([sha]) => sha));
            if (!closeIfStillReached(db, issueId, reached, targetRef))
                continue;
            closed.push(issueId);
            await syncIssueCloseRemotes(db, opts.dbPath, issueId, opts.spawnFn);
        }
    }
    catch (e) {
        serverLog({ event: 'issue_target_reach_close_error', repo, error: e.message });
    }
    return closed;
}
//# sourceMappingURL=issue-merge-close.js.map