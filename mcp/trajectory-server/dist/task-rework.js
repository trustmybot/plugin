/**
 * How much rework a task has taken (GH 1738), shared by `task_stats` and the
 * rework-limit and task-overrun-alert hook gates so the three count alike,
 * and the limits past which rework-limit denies a further swe run until the
 * Human waives them (GH 2148).
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
/** Spawns after the first. */
export function reworkCount(sweSpawnCount) {
    return Math.max(0, sweSpawnCount - 1);
}
/** Milliseconds from <createdAt> to <endedAt>, never negative; null when either does not parse. */
export function elapsedMs(createdAt, endedAt) {
    const start = Date.parse(createdAt);
    const end = endedAt.getTime();
    if (Number.isNaN(start) || Number.isNaN(end))
        return null;
    return Math.max(0, end - start);
}
//# sourceMappingURL=task-rework.js.map