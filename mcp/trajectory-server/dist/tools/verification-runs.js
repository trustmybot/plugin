/**
 * The task's latest recorded verification run (written by
 * swe-verification-gate.sh), or null when none exists. With `startedBy`, only
 * runs started at or before that ISO timestamp count.
 */
export function latestVerificationRun(db, taskId, startedBy) {
    const run = db.get(`SELECT id, commit_sha, source, started_at, finished_at, exit_code, timed_out, budget_s
       FROM verification_runs
      WHERE task_id = ?${startedBy ? ' AND started_at <= ?' : ''}
      ORDER BY started_at DESC, id DESC LIMIT 1`, startedBy ? [taskId, startedBy] : [taskId]);
    if (!run)
        return null;
    const commands = db
        .all(`SELECT ordinal, command, exit_code, elapsed_s FROM verification_run_commands WHERE run_id = ? ORDER BY ordinal`, [run.id])
        .map((c) => ({ ordinal: c.ordinal, command: c.command, exit_code: c.exit_code, elapsed_s: c.elapsed_s }));
    return {
        run_id: run.id,
        commit_sha: run.commit_sha,
        source: run.source,
        started_at: run.started_at,
        finished_at: run.finished_at,
        exit_code: run.exit_code,
        timed_out: run.timed_out === 1,
        budget_s: run.budget_s,
        commands,
    };
}
//# sourceMappingURL=verification-runs.js.map