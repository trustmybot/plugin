/**
 * The review predicates shared by the close paths, the hooks and the data
 * contracts: plain SQL text over `tasks t`, in a module the hook bundle can
 * import without the tool layer.
 */

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
export const reviewSkipAuthoredSql = (alias: string): string =>
  `((${alias}.event_type = 'review_gate_waived' AND ${alias}.from_node = 'bro')
      OR (${alias}.event_type = 'review_gate_bypassed' AND ${alias}.from_node IN ('bro', 'hook:close-issue-on-merge')))`;

export const GATE_SKIP_RECORDED_SQL = `EXISTS (SELECT 1 FROM audit g
  WHERE ${reviewSkipAuthoredSql('g')}
    AND json_valid(g.content_json)
    AND json_extract(g.content_json, '$.task_id') = t.id
    AND COALESCE(json_extract(g.content_json, '$.commit_sha'), '') = COALESCE(t.commit_sha, ''))`;
