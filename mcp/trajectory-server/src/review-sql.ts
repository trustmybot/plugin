/**
 * The review predicates shared by the close paths, the hooks and the data
 * contracts: plain SQL text over `tasks t`, in a module the hook bundle can
 * import without the tool layer.
 */

// The review anchor of a task's current commit: the earliest of the
// bro_verification_pass and task_integrated audit rows naming this task and
// this commit_sha (bro's first verification of that exact commit, or cli.js
// integrate moving the task onto it). Each row's time is its created_at,
// except that a task_integrated row from hook:integrate carries the anchor of
// the commit it rebased in $.review_anchor_at (GH 2082, Gerrit's
// TRIVIAL_REBASE copyCondition): integrate writes it only after its own
// HAS_PASS check, a matching `git patch-id --stable` list and a passing
// verification[] run on the new SHA, so the pass carries over and a chain of
// integrates collapses to the first review. Any other author's
// review_anchor_at is ignored. NULL when the commit has no anchor row.
export const REVIEW_ANCHOR_AT_SQL = `(SELECT MIN(CASE
      WHEN a.event_type = 'task_integrated' AND a.from_node = 'hook:integrate'
        AND json_type(a.content_json, '$.review_anchor_at') = 'text'
      THEN json_extract(a.content_json, '$.review_anchor_at') ELSE a.created_at END) FROM audit a
    WHERE a.event_type IN ('bro_verification_pass', 'task_integrated') AND json_valid(a.content_json)
      AND json_extract(a.content_json, '$.task_id') = t.id
      AND json_extract(a.content_json, '$.commit_sha') = t.commit_sha)`;

// A task has a passing review when a validation_attempts row with
// verdict='pass' was recorded at or after the review anchor of its current
// commit (REVIEW_ANCHOR_AT_SQL) and its newest verdict is a pass. So a pass of
// the reviewed commit covers its trivial rebase by cli.js integrate, and any
// other new head needs a fresh pass. No anchor row = no pass; completed_at is
// not an anchor because no audit row records which sha a completion carried.
// validation_attempts carries no commit_sha, so time is the only link.
// close-issue-on-merge and cleanup-worktree-on-task-close read it from here.
export const HAS_PASS_SQL = `(EXISTS (SELECT 1 FROM validation_attempts va
  WHERE va.task_id = t.id AND va.verdict = 'pass' AND va.created_at >= ${REVIEW_ANCHOR_AT_SQL})
  AND ${newestVerdictPassSql('t')})`;

// A recorded bypass or waiver for the task's current commit means the
// trajectory already says the review gate was skipped. Only bro authors a
// waiver; a bypass is bro's (a server close path) or close-issue-on-merge's.
// Rows from any other author do not count. close-issue-on-merge reads it
// through GATE_SKIP_RECORDED_SQL. trajectory_doctor's
// closed_tasks_reviewed contract trusts the same authors.
export const reviewSkipAuthoredSql = (alias: string): string =>
  `((${alias}.event_type = 'review_gate_waived' AND ${alias}.from_node = 'bro')
      OR (${alias}.event_type = 'review_gate_bypassed' AND ${alias}.from_node IN ('bro', 'hook:close-issue-on-merge')))`;

export const GATE_SKIP_RECORDED_SQL = `EXISTS (SELECT 1 FROM audit g
  WHERE ${reviewSkipAuthoredSql('g')}
    AND json_valid(g.content_json)
    AND json_extract(g.content_json, '$.task_id') = t.id
    AND COALESCE(json_extract(g.content_json, '$.commit_sha'), '') = COALESCE(t.commit_sha, ''))`;

// validation_attempts is append-only, so a task's verdict is its newest row
// (highest id): an older pass under a newer fail or escalate does not count,
// and a task with no rows has no pass.
export function newestVerdictPassSql(alias: string): string {
  return `COALESCE((SELECT v.verdict FROM validation_attempts v WHERE v.task_id = ${alias}.id ORDER BY v.id DESC LIMIT 1), '') = 'pass'`;
}
