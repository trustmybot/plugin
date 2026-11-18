// An issue closes once its work reaches the target branch (GH 3234, decision
// #245). Tasks close at bro's close step and leave the issue open; each TMB
// checkpoint that fetches a repo's target (startup catch-up, the ref-move
// hook, a world-model read, task_provision) then asks git whether every closed
// task commit of an open issue is integrated into the target, so a forge
// merge (merge queue, web-UI squash) and a local-only `git merge` close it
// alike. The remote twin follows through syncIssueCloseRemotes, gated by sync.
import type { TrajectoryDB } from './db.js';
import { nowISO } from './db.js';
import { integrated } from './hooks/clean-merged-branch.js';
import { serverLog } from './logger.js';
import type { SpawnFn } from './sync/issue_sync.js';
import { insertAudit } from './tools/audit.js';
import { syncIssueCloseRemotes } from './tools/issues.js';
import { closedTasksWithoutReview, liveTasksOfIssue, markIssueClosed } from './tools/lifecycle.js';
import { DONE, LIVE, statusIn } from './task-states.js';
import { runGit } from './utils/git-run.js';
import { targetBranchOf } from './utils/index-target.js';

interface ClosedCommit {
  task_id: number;
  commit_sha: string;
}

// Open issues of the repo with a closed, committed task and no live task:
// the one query a repo with nothing to close costs.
function candidateIssues(db: TrajectoryDB, repo: string): number[] {
  return db
    .all<{ id: number }>(
      `SELECT i.id FROM issues i
        WHERE i.repo = ? AND i.status = 'open'
          AND EXISTS (SELECT 1 FROM tasks t WHERE t.issue_id = i.id AND ${statusIn('t', DONE)} AND t.commit_sha IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.issue_id = i.id AND ${statusIn('t', LIVE)})
        ORDER BY i.id`,
      [repo],
    )
    .map((r) => r.id);
}

function closedCommitsOf(db: TrajectoryDB, issueId: number): ClosedCommit[] {
  return db.all<ClosedCommit>(
    `SELECT id AS task_id, commit_sha FROM tasks
      WHERE issue_id = ? AND status = 'closed' AND commit_sha IS NOT NULL ORDER BY id`,
    [issueId],
  );
}

function hasOrigin(repoPath: string): boolean {
  const res = runGit(repoPath, ['remote', 'get-url', 'origin']);
  return res.status === 0 && res.stdout.trim() !== '';
}

// origin/<target> when the repo has an origin, else the local target branch.
function targetRefOf(db: TrajectoryDB, repo: string, repoPath: string): string | null {
  const branch = targetBranchOf(db, repo, repoPath);
  const ref = hasOrigin(repoPath) ? `refs/remotes/origin/${branch}` : `refs/heads/${branch}`;
  return runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0 ? ref : null;
}

// Closes, in one transaction, an issue whose state still matches what git was
// asked about: open, no live task, every closed task reviewed and its commit
// among those found integrated.
function closeIfStillReached(db: TrajectoryDB, issueId: number, reached: ReadonlySet<string>, targetRef: string): boolean {
  return db.transaction(() => {
    const status = db.get<{ status: string }>(`SELECT status FROM issues WHERE id = ?`, [issueId])?.status;
    if (status !== 'open') return false;
    if (liveTasksOfIssue(db, issueId).length > 0 || closedTasksWithoutReview(db, issueId).length > 0) return false;
    const commits = closedCommitsOf(db, issueId);
    if (commits.length === 0 || commits.some((c) => !reached.has(c.commit_sha))) return false;
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
export async function closeIssuesReachedTarget(
  db: TrajectoryDB,
  repo: string,
  opts: { dbPath: string; spawnFn?: SpawnFn },
): Promise<number[]> {
  const closed: number[] = [];
  try {
    const candidates = candidateIssues(db, repo);
    if (candidates.length === 0) return closed;
    const repoPath = db.get<{ path: string | null }>(`SELECT path FROM repos WHERE name = ?`, [repo])?.path;
    if (!repoPath) return closed;
    const targetRef = targetRefOf(db, repo, repoPath);
    if (!targetRef) return closed;
    const verdicts = new Map<string, boolean>();
    for (const issueId of candidates) {
      if (closedTasksWithoutReview(db, issueId).length > 0) continue;
      let allReached = true;
      for (const { commit_sha } of closedCommitsOf(db, issueId)) {
        if (!verdicts.has(commit_sha)) verdicts.set(commit_sha, await integrated(repoPath, commit_sha, targetRef));
        if (!verdicts.get(commit_sha)) {
          allReached = false;
          break;
        }
      }
      if (!allReached) continue;
      const reached = new Set([...verdicts].filter(([, ok]) => ok).map(([sha]) => sha));
      if (!closeIfStillReached(db, issueId, reached, targetRef)) continue;
      closed.push(issueId);
      await syncIssueCloseRemotes(db, opts.dbPath, issueId, opts.spawnFn);
    }
  } catch (e) {
    serverLog({ event: 'issue_target_reach_close_error', repo, error: (e as Error).message });
  }
  return closed;
}
