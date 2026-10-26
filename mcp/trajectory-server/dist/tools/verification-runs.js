/**
 * The verification_run_commands.command a review finding's probe is recorded
 * under: `[probe <id>] <probe_cmd>`, the whole probe as one command.
 */
export function probeCommand(probe) {
    return `[probe ${probe.id}] ${probe.probe_cmd}`;
}
/** SQL ordering review_findings by the <n> of their F<task_id>-<n> id. */
export const FINDING_ORDER_SQL = "CAST(substr(id, instr(id, '-') + 1) AS INTEGER)";
/**
 * Copies every open finding of `fromTaskId` onto `toTaskId` in id order, as
 * F<toTaskId>-<n> (n from 1) with attempt_n 0, status open and created_at
 * `now`, so the retry's own reviewer attempts (from 1) never replace them.
 * The source rows stay as they are.
 */
export function carryOpenFindings(db, fromTaskId, toTaskId, now) {
    const open = db.all(`SELECT id, criterion_id, probe_cmd, expected, observed FROM review_findings
      WHERE task_id = ? AND status = 'open' ORDER BY ${FINDING_ORDER_SQL}`, [fromTaskId]);
    return open.map((f, i) => {
        const id = `F${toTaskId}-${i + 1}`;
        db.run(`INSERT INTO review_findings (id, task_id, attempt_n, criterion_id, probe_cmd, expected, observed, status, created_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, 'open', ?)`, [id, toTaskId, f.criterion_id, f.probe_cmd, f.expected, f.observed, now]);
        return { from: f.id, id };
    });
}
/**
 * The task's findings the gate probes: every status but wontfix, in id order.
 * A DB without review_findings (schema < 47) has none.
 */
export function activeFindingProbes(db, taskId) {
    const table = db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_findings'");
    if (!table)
        return [];
    return db
        .all(`SELECT id, probe_cmd FROM review_findings WHERE task_id = ? AND status <> 'wontfix' ORDER BY ${FINDING_ORDER_SQL}`, [taskId])
        .map((f) => ({ id: f.id, probe_cmd: f.probe_cmd }));
}
/**
 * The commands swe-verification-gate.sh runs for a verification[] list: every
 * non-empty line of every entry, in order, then one entry per review finding
 * probe (probeCommand) — one verification_run_commands row each.
 */
export function gateCommands(verification, probes = []) {
    return [
        ...verification.flatMap((entry) => entry.split('\n')).filter((line) => line !== ''),
        ...probes.map(probeCommand),
    ];
}
const shaMatches = (col) => `(substr(lower(${col}), 1, length(?)) = ? OR substr(?, 1, length(${col})) = lower(${col}))`;
/**
 * The newest finished passing run (exit 0, not timed out) of the task on the
 * commit (either SHA may be the other's prefix) whose recorded commands equal
 * `commands`, in order; null when none. A run of an earlier verification[]
 * does not count.
 */
export function passingRunForCommit(db, taskId, commitSha, commands) {
    const sha = commitSha.toLowerCase();
    const expected = JSON.stringify(commands);
    const row = db.get(`SELECT r.id FROM verification_runs r
      WHERE r.task_id = ? AND r.commit_sha <> '' AND ${shaMatches('r.commit_sha')}
        AND r.exit_code = 0 AND r.timed_out = 0 AND r.finished_at IS NOT NULL
        AND (SELECT COUNT(*) FROM verification_run_commands c WHERE c.run_id = r.id) = json_array_length(?)
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) e
            LEFT JOIN verification_run_commands c ON c.run_id = r.id AND c.ordinal = e.key + 1
           WHERE c.command IS NOT e.value)
      ORDER BY r.finished_at DESC, r.id DESC LIMIT 1`, [taskId, sha, sha, sha, expected, expected]);
    return row ? row.id : null;
}
/** Whether a verification_gate_waived audit row names the task and the commit (either SHA may be the other's prefix). */
export function verificationWaivedForCommit(db, taskId, commitSha) {
    const sha = commitSha.toLowerCase();
    const row = db.get(`SELECT COUNT(*) AS c FROM (
       SELECT json_extract(content_json, '$.commit_sha') AS commit_sha FROM audit
        WHERE event_type = 'verification_gate_waived' AND json_valid(content_json)
          AND CAST(json_extract(content_json, '$.task_id') AS INTEGER) = ?)
      WHERE commit_sha IS NOT NULL AND commit_sha <> '' AND ${shaMatches('commit_sha')}`, [taskId, sha, sha, sha]);
    return (row?.c ?? 0) > 0;
}
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