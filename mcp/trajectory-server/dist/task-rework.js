/**
 * How much rework a task has taken (GH 1738), shared by `task_stats` and the
 * rework-limit and task-overrun-alert hook gates so the three count alike.
 *
 * A swe spawn is one swe `agent_runs` row of the task, minus the rows closed
 * `swept_orphan`: a spawn that never started or a duplicate row of one that
 * did. A review FAIL is one `validation_attempts` row with verdict `fail`.
 */
/** The agent_runs predicate of a swe spawn (columns unqualified). */
export const SWE_SPAWN_SQL = "agent_type = 'swe' AND COALESCE(exit_reason, '') <> 'swept_orphan'";
/** FAIL verdicts since the latest pass at which a further swe spawn needs a new decision. */
export const REWORK_FAIL_LIMIT = 2;
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