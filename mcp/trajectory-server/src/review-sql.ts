/**
 * The review predicates shared by the close paths, the hooks and the data
 * contracts: plain SQL text over `tasks t`, in a module the hook bundle can
 * import without the tool layer.
 */
import { storedAgileSql } from './stored-mode.js';
import { DONE, LIVE, statusIn } from './task-states.js';

// The review anchor of a task's current commit: the earliest of the
// review_handoff, bro_verification_pass and task_integrated audit rows naming
// this task and this commit_sha (bro handing that exact commit to
// code-reviewer, a close under the old close-then-review order, or cli.js
// integrate moving the task onto it). Each row's time is its created_at,
// except that a task_integrated row from hook:integrate carries the anchor of
// the commit it rebased in $.review_anchor_at (GH 2082, Gerrit's
// TRIVIAL_REBASE copyCondition): integrate writes it only after its own
// HAS_PASS check, a matching `git patch-id --stable` list and a passing
// verification[] run on the new SHA, so the pass carries over and a chain of
// integrates collapses to the first review. A hook:integrate row written
// before GH 2082 has a text reviewed_sha and no text review_anchor_at (GH
// 2546): it takes the anchor of its reviewed_sha instead, found by walking
// back through such legacy rows of the task (each row's reviewed_sha is the
// previous row's commit_sha, at most LEGACY_CHAIN_HOPS hops) to the earliest
// bro_verification_pass or carried review_anchor_at on the chain, and keeps
// its created_at when the chain has none. Any other author's row anchors at
// its created_at. NULL when the commit has no anchor row.
const LEGACY_CHAIN_HOPS = 10;

// The planner may evaluate a join term before the json_valid term beside it
// (an automatic index keys on it, or it is hoisted to the outer loop), so
// every JSON read inside the chain walk guards itself with a CASE.
const jsonSql = (fn: 'json_extract' | 'json_type', alias: string, path: string): string =>
  `CASE WHEN json_valid(${alias}.content_json) THEN ${fn}(${alias}.content_json, '${path}') END`;

const integrateRowSql = (alias: string): string =>
  `${alias}.event_type = 'task_integrated' AND ${alias}.from_node = 'hook:integrate'`;

const carriesAnchorSql = (alias: string): string =>
  `${integrateRowSql(alias)} AND ${jsonSql('json_type', alias, '$.review_anchor_at')} = 'text'`;

const legacyIntegrateSql = (alias: string): string =>
  `${integrateRowSql(alias)} AND ${jsonSql('json_type', alias, '$.review_anchor_at')} IS NOT 'text'
          AND ${jsonSql('json_type', alias, '$.reviewed_sha')} = 'text'`;

const LEGACY_CHAIN_ANCHOR_SQL = `(WITH RECURSIVE chain(sha, hops) AS (
          SELECT ${jsonSql('json_extract', 'a', '$.reviewed_sha')}, 1
          UNION
          SELECT ${jsonSql('json_extract', 'c', '$.reviewed_sha')}, chain.hops + 1 FROM chain JOIN audit c
            ON json_valid(c.content_json) AND ${legacyIntegrateSql('c')}
              AND ${jsonSql('json_extract', 'c', '$.task_id')} = t.id
              AND ${jsonSql('json_extract', 'c', '$.commit_sha')} = chain.sha
          WHERE chain.hops < ${LEGACY_CHAIN_HOPS})
        SELECT MIN(CASE WHEN p.event_type = 'bro_verification_pass' THEN p.created_at
          ELSE ${jsonSql('json_extract', 'p', '$.review_anchor_at')} END)
        FROM chain JOIN audit p
          ON json_valid(p.content_json)
            AND (p.event_type = 'bro_verification_pass' OR (${carriesAnchorSql('p')}))
            AND ${jsonSql('json_extract', 'p', '$.task_id')} = t.id
            AND ${jsonSql('json_extract', 'p', '$.commit_sha')} = chain.sha)`;

export const REVIEW_ANCHOR_AT_SQL = `(SELECT MIN(CASE
      WHEN ${carriesAnchorSql('a')}
      THEN json_extract(a.content_json, '$.review_anchor_at')
      WHEN ${legacyIntegrateSql('a')}
      THEN COALESCE(${LEGACY_CHAIN_ANCHOR_SQL}, a.created_at)
      ELSE a.created_at END) FROM audit a
    WHERE a.event_type IN ('review_handoff', 'bro_verification_pass', 'task_integrated') AND json_valid(a.content_json)
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

// A task closed under workflow_mode 'agile' without a pass is queued for a
// later grouped review: bro_atomic_close records one review_queued row for
// the commit it closed. The push guard admits such a commit to any branch but
// the repo's pr_target. As with skips, only bro's rows count. A batch-reviewed
// or waived task (batchReviewedSql, waivedSql) keeps its row, so the push
// guard still admits it.
export const AGILE_QUEUED_SQL = `(${statusIn('t', DONE)} AND ${storedAgileSql('t')} AND EXISTS (SELECT 1 FROM audit q
  WHERE q.event_type = 'review_queued' AND q.from_node = 'bro'
    AND json_valid(q.content_json)
    AND json_extract(q.content_json, '$.task_id') = t.id
    AND json_extract(q.content_json, '$.commit_sha') = t.commit_sha))`;

// The key a review_batch_record call's reviewer_identity_observed row carries
// ($.batch_key) and the tool looks it up by: the distinct task ids ascending
// and the lowercased head_sha, so the hook and the tool agree on one call.
export function reviewBatchKey(taskIds: readonly number[], headSha: string): string {
  return `${[...new Set(taskIds)].sort((a, b) => a - b).join(',')}@${headSha.toLowerCase()}`;
}

// A queued agile task is batch-reviewed once a code-reviewer
// review_batch_recorded row with verdict 'pass' names it at its current
// commit: task_ids[i] is the task and commit_shas[i] the commit reviewed. Only
// review_batch_record writes the row, so only code-reviewer's rows count.
// json_each raises on malformed JSON whichever term the planner runs first,
// so it reads '{}' in place of an invalid row.
export const batchReviewedSql = (alias: string): string => `EXISTS (SELECT 1 FROM audit b,
    json_each(CASE WHEN json_valid(b.content_json) THEN b.content_json ELSE '{}' END, '$.task_ids') bt
  WHERE b.event_type = 'review_batch_recorded' AND b.from_node = 'code-reviewer'
    AND ${jsonSql('json_extract', 'b', '$.verdict')} = 'pass'
    AND bt.value = ${alias}.id
    AND CASE WHEN json_valid(b.content_json) THEN json_extract(b.content_json, '$.commit_shas[' || bt.key || ']') END = ${alias}.commit_sha)`;

// A queued agile task is waived once a bro review_waived row names it at its
// current commit, the same task_ids[i]/commit_shas[i] shape: the Human chose
// to merge the feature branch without the grouped review. Only
// review_waive_record writes the row, so only bro's rows count, and a task
// whose commit moves after the waiver is queued again.
export const waivedSql = (alias: string): string => `EXISTS (SELECT 1 FROM audit w,
    json_each(CASE WHEN json_valid(w.content_json) THEN w.content_json ELSE '{}' END, '$.task_ids') wt
  WHERE w.event_type = 'review_waived' AND w.from_node = 'bro'
    AND wt.value = ${alias}.id
    AND CASE WHEN json_valid(w.content_json) THEN json_extract(w.content_json, '$.commit_shas[' || wt.key || ']') END = ${alias}.commit_sha)`;

// An agile task cli.js feature-merge folded onto a feature branch (a bro
// feature_branch_merged row names it) and later reopened for rework: its fold
// no longer holds the commit the feature branch will ship, so no earlier
// review, waiver or pass settles it until it closes and is queued again.
const AGILE_REOPENED_SQL = `(${storedAgileSql('t')} AND ${statusIn('t', LIVE)}
  AND EXISTS (SELECT 1 FROM audit f
    WHERE f.event_type = 'feature_branch_merged' AND f.from_node = 'bro'
      AND ${jsonSql('json_extract', 'f', '$.task_id')} = t.id))`;

// The one set of agile tasks still awaiting review, which review_queue, the
// batch hand-off and record, the waiver and the feature-branch merge gate all
// select: a queued agile task neither batch-reviewed nor waived at its current
// commit and without a per-task pass (HAS_PASS_SQL: a code-reviewer pass after
// review_handoff handed that commit over), or a folded task reopened since.
export const AGILE_PENDING_REVIEW_SQL = `((${AGILE_QUEUED_SQL} AND NOT ${batchReviewedSql('t')} AND NOT ${waivedSql('t')} AND NOT ${HAS_PASS_SQL})
  OR ${AGILE_REOPENED_SQL})`;

// The tasks a feature branch of one repo carries: those cli.js feature-merge
// moved onto it, each named by a bro feature_branch_merged row, whose repo
// (the task's, else its issue's, as review_queue places it, else the row's) is
// repoSql. Two repos may hold a same-named feature branch. branchSql and
// repoSql are SQL expressions, already quoted; a NULL repoSql matches every
// repo, and a task none of the three places matches every repoSql, so no
// reader loses a task it cannot place.
export const featureBranchTaskSql = (alias: string, branchSql: string, repoSql: string): string => `EXISTS (SELECT 1 FROM audit m
  WHERE m.event_type = 'feature_branch_merged' AND m.from_node = 'bro'
    AND ${jsonSql('json_extract', 'm', '$.task_id')} = ${alias}.id
    AND ${jsonSql('json_extract', 'm', '$.feature_branch')} = ${branchSql}
    AND (${repoSql} IS NULL OR COALESCE(${alias}.repo, (SELECT i.repo FROM issues i WHERE i.id = ${alias}.issue_id), m.repo, ${repoSql}) = ${repoSql}))`;

// validation_attempts is append-only, so a task's verdict is its newest row
// (highest id): an older pass under a newer fail or escalate does not count,
// and a task with no rows has no pass.
export function newestVerdictPassSql(alias: string): string {
  return `COALESCE((SELECT v.verdict FROM validation_attempts v WHERE v.task_id = ${alias}.id ORDER BY v.id DESC LIMIT 1), '') = 'pass'`;
}
