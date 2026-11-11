/**
 * How much rework a task has taken (GH 1738), shared by `task_stats` and the
 * rework-limit and task-overrun-alert hook gates so the three count alike, and
 * the typed rework analysis bro records once a task keeps failing review
 * (GH 2830): its root causes, its changes and which of them pair.
 *
 * A swe spawn is one swe `agent_runs` row of the task, minus the rows closed
 * `swept_orphan`: a spawn that never started or a duplicate row of one that
 * did. A review FAIL is one `validation_attempts` row with verdict `fail`.
 */

/** The agent_runs predicate of a swe spawn (columns unqualified). */
export const SWE_SPAWN_SQL = "agent_type = 'swe' AND COALESCE(exit_reason, '') <> 'swept_orphan'";

/** FAIL verdicts on a task since its last passing review from which a further swe run needs a proven rework analysis. */
export const REWORK_FAIL_LIMIT = 2;

/** The highest task effort: a task at it has no effort_raise left. */
export const MAX_EFFORT = 'high';

/** The effort a swe rework runs at while its task has a review FAIL since its last passing review (GH 2866). */
export const REWORK_FLOOR_EFFORT = MAX_EFFORT;

/**
 * A scalar subquery: the review FAILs on task <taskIdSql> since its last
 * passing review, counted by the same rule as the rework-limit gate's `since`
 * CTE (validation_attempts ids after the newest pass). <taskIdSql> is a bound
 * parameter or a sanitized integer literal.
 */
export function failsSinceLastPassSql(taskIdSql: string): string {
  return `(SELECT COUNT(*) FROM validation_attempts f
            WHERE f.task_id = ${taskIdSql} AND f.verdict = 'fail'
              AND f.id > (SELECT COALESCE(MAX(p.id), 0) FROM validation_attempts p
                           WHERE p.task_id = ${taskIdSql} AND p.verdict = 'pass'))`;
}

/** Why a task kept failing review, the inputs first (spec, world model, reviewer, environment), then swe's execution; design_drift when the reality drifts from the design. */
export const REWORK_ROOT_CAUSES = [
  'spec_unclear',
  'spec_wrong',
  'world_model',
  'reviewer_disputed',
  'environment',
  'swe_execution',
  'design_drift',
] as const;
export type ReworkRootCause = (typeof REWORK_ROOT_CAUSES)[number];

/** What bro changes in answer to the analysis. */
export const REWORK_CHANGES = ['spec_update', 'world_model_fix', 'effort_raise', 'split', 'retry', 're_review', 'ask_human'] as const;
export type ReworkChange = (typeof REWORK_CHANGES)[number];

/** The audit event on the task that proves a task-scoped change was made. */
export const TASK_PROOF_EVENTS = {
  spec_update: 'task_spec_amended',
  effort_raise: 'task_effort_raised',
} as const satisfies Partial<Record<ReworkChange, string>>;

/** Audit events that prove world_model_fix: a scan or a reindex of the world model. */
export const WORLD_MODEL_PROOF_EVENTS = ['deep_scan_completed', 'wm_reindex'] as const;

/** The world-model write whose `wm_tool_called` row proves world_model_fix too. */
export const WORLD_MODEL_PROOF_TOOL = 'world_model_concept_upsert';

/** The label of an issue filed against the world model, the last proof of world_model_fix. */
export const WORLD_MODEL_ISSUE_LABEL = 'Area: World Model';

/** The changes that admit another swe run of the same task once a row dated after its latest FAIL proves them. */
export const SPAWN_ADMITTING_CHANGES: readonly ReworkChange[] = ['spec_update', 'effort_raise', 'world_model_fix'];

/** The changes left when the findings share one cause in the approach itself: a redesign, not another patch. */
export const APPROACH_CHANGES: readonly ReworkChange[] = ['split', 'retry'];

/** A drifted design takes a new task with a redesigned spec, never another run of the drifted one. */
const ONLY_CHANGES_FOR: Partial<Record<ReworkRootCause, readonly ReworkChange[]>> = {
  world_model: ['world_model_fix'],
  design_drift: APPROACH_CHANGES,
};

/** Why <change> cannot answer <rootCause> given <approachSharedCause>, or null when the pairing stands. */
export function reworkPairingError(rootCause: ReworkRootCause, change: ReworkChange, approachSharedCause: boolean): string | null {
  const onlyChanges = ONLY_CHANGES_FOR[rootCause];
  if (onlyChanges !== undefined && !onlyChanges.includes(change)) {
    return `root_cause ${rootCause} takes only change ${onlyChanges.join(' or ')} (got ${change})`;
  }
  if (approachSharedCause && !APPROACH_CHANGES.includes(change)) {
    return `approach_shared_cause true takes only change ${APPROACH_CHANGES.join(' or ')} (got ${change}): the fix is a redesign, not another patch`;
  }
  return null;
}

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
