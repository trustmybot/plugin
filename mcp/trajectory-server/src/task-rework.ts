/**
 * How much rework a task has taken (GH 1738), shared by `task_stats` and the
 * rework-limit and task-overrun-alert hook gates so the three count alike,
 * the limits past which rework-limit denies a further swe run (GH 2148), and
 * the typed rework analysis that clears the inner one (GH 2830).
 *
 * A swe spawn is one swe `agent_runs` row of the task, minus the rows closed
 * `swept_orphan`: a spawn that never started or a duplicate row of one that
 * did. A review FAIL is one `validation_attempts` row with verdict `fail`.
 */

/** The agent_runs predicate of a swe spawn (columns unqualified). */
export const SWE_SPAWN_SQL = "agent_type = 'swe' AND COALESCE(exit_reason, '') <> 'swept_orphan'";

/** FAIL verdicts on a task since its latest pass and Human waiver at which a further swe run is denied. */
export const REWORK_FAIL_LIMIT = 2;

/** swe runs of a task, budget handbacks aside, since its latest Human waiver at which a further run is denied. */
export const SWE_RUN_LIMIT = 6;

/** FAIL verdicts across an issue's tasks, each with no later pass on the same task, since the latest Human waiver at which a further swe run on any of them is denied. */
export const ISSUE_FAIL_LIMIT = 4;

/** Why a task kept failing review, as bro's `task_rework_analysis` names it (GH 2830). */
export const REWORK_ROOT_CAUSES = ['spec_unclear', 'spec_wrong', 'swe_execution', 'reviewer_disputed', 'environment'] as const;
export type ReworkRootCause = (typeof REWORK_ROOT_CAUSES)[number];

/** What bro changes in answer to the analysis; only spec_update and effort_raise admit another swe run of the same task. */
export const REWORK_CHANGES = ['spec_update', 'effort_raise', 'split', 'retry', 're_review'] as const;
export type ReworkChange = (typeof REWORK_CHANGES)[number];

/** The audit event that proves each spawn-admitting change was made. */
export const REWORK_PROOF_EVENTS: Readonly<Partial<Record<ReworkChange, string>>> = {
  spec_update: 'task_spec_amended',
  effort_raise: 'task_effort_raised',
};

export const REWORK_RATIONALE_MIN_CHARS = 20;

/** Spawns after the first. */
export function reworkCount(sweSpawnCount: number): number {
  return Math.max(0, sweSpawnCount - 1);
}

/** Milliseconds from <createdAt> to <endedAt>, never negative; null when either does not parse. */
export function elapsedMs(createdAt: string, endedAt: Date): number | null {
  const start = Date.parse(createdAt);
  const end = endedAt.getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}
