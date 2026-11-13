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
 * Copies every open blocking finding of `fromTaskId` onto `toTaskId` in id
 * order, with its severity and class, as F<toTaskId>-<n> (n from 1) with
 * attempt_n 0, status open and created_at `now`, so the retry's own reviewer
 * attempts (from 1) never replace them. The source rows stay as they are.
 */
export function carryOpenFindings(db, fromTaskId, toTaskId, now) {
    const open = db.all(`SELECT id, criterion_id, probe_cmd, expected, observed, severity, class FROM review_findings
      WHERE task_id = ? AND status = 'open' AND severity = 'blocking' ORDER BY ${FINDING_ORDER_SQL}`, [fromTaskId]);
    return open.map((f, i) => {
        const id = `F${toTaskId}-${i + 1}`;
        db.run(`INSERT INTO review_findings (id, task_id, attempt_n, criterion_id, probe_cmd, expected, observed, status, created_at, severity, class)
       VALUES (?, ?, 0, ?, ?, ?, ?, 'open', ?, ?, ?)`, [id, toTaskId, f.criterion_id, f.probe_cmd, f.expected, f.observed, now, f.severity, f.class]);
        return { from: f.id, id };
    });
}
/**
 * The task's findings the gate probes, the rows reviewFindingsActive in
 * hooks/swe-verification-gate.ts selects: every blocking finding not wontfix,
 * in id order; every finding not wontfix on a DB without the severity column
 * (schema < 57). A DB without review_findings (schema < 47) has none.
 */
export function activeFindingProbes(db, taskId) {
    const table = db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_findings'");
    if (!table)
        return [];
    const severity = db.get("SELECT COUNT(*) AS n FROM pragma_table_info('review_findings') WHERE name = 'severity'");
    const blockingOnly = severity?.n === 1 ? " AND severity = 'blocking'" : '';
    return db
        .all(`SELECT id, probe_cmd FROM review_findings WHERE task_id = ? AND status <> 'wontfix'${blockingOnly} ORDER BY ${FINDING_ORDER_SQL}`, [taskId])
        .map((f) => ({ id: f.id, probe_cmd: f.probe_cmd }));
}
/**
 * The commands swe-verification-gate runs for a verification[] list: every
 * non-empty line of every entry, in order, then one entry per review finding
 * probe (probeCommand) — one verification_run_commands row each.
 */
export function gateCommands(verification, probes = []) {
    return [
        ...verification.flatMap((entry) => entry.split('\n')).filter((line) => line !== ''),
        ...probes.map(probeCommand),
    ];
}
/** The last `chars` characters of a stored output_tail; null stays null. */
export function clipOutputTail(tail, chars) {
    return tail === null || tail.length <= chars ? tail : tail.slice(-chars);
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
 * The run a pass verdict is judged by: the task's newest verification run on
 * the commit (?2, lowercased; either SHA may be the other's prefix), else its
 * newest run on any commit, which at_sha = 0 marks. ?1 is the task id.
 */
export const PASS_RUN_SQL = `
  SELECT commit_sha, exit_code, timed_out,
         CASE WHEN ?2 <> '' AND commit_sha <> ''
                   AND (substr(lower(commit_sha), 1, length(?2)) = ?2 OR substr(?2, 1, length(commit_sha)) = lower(commit_sha))
              THEN 1 ELSE 0 END AS at_sha
    FROM verification_runs
   WHERE task_id = ?1
   ORDER BY at_sha DESC, started_at DESC, id DESC
   LIMIT 1`;
export const VERIFICATION_RUN_REQUIRED = 'verification_run_required';
/**
 * Why a pass verdict for the task at `commitSha` is refused (the detail of a
 * VERIFICATION_RUN_REQUIRED error), or null when the
 * run PASS_RUN_SQL found passed on that commit (exit 0, not timed out). The
 * code-reviewer preflight checks the same before the spawn, but it has a
 * bypass, so validation_record and its fallback refuse here too.
 */
export function passRunRefusal(taskId, commitSha, run) {
    if (run && run.at_sha === 1 && run.exit_code === 0 && run.timed_out === 0)
        return null;
    let found;
    if (commitSha === null || commitSha === '')
        found = 'no commit recorded for the task';
    else if (!run)
        found = 'no verification run for the task';
    else if (run.at_sha !== 1)
        found = `only a run at another commit (${run.commit_sha || 'none recorded'})`;
    else if (run.timed_out !== 0)
        found = 'a run that timed out';
    else
        found = `a failed run (exit_code=${run.exit_code ?? 'null'})`;
    return `a pass needs the gate's passing verification run (exit_code 0, not timed out) for task ${taskId} at ${commitSha || 'its commit'}; found ${found}.`;
}
/**
 * The task's latest recorded verification run (written by
 * swe-verification-gate), or null when none exists. With `startedBy`, only
 * runs started at or before that ISO timestamp count. With `withOutputTail`,
 * each command carries its stored output_tail; without, it has none.
 */
export function latestVerificationRun(db, taskId, opts = {}) {
    const { startedBy, withOutputTail = false } = opts;
    const run = db.get(`SELECT id, commit_sha, source, started_at, finished_at, exit_code, timed_out, budget_s
       FROM verification_runs
      WHERE task_id = ?${startedBy ? ' AND started_at <= ?' : ''}
      ORDER BY started_at DESC, id DESC LIMIT 1`, startedBy ? [taskId, startedBy] : [taskId]);
    if (!run)
        return null;
    const commands = db
        .all(`SELECT ordinal, command, exit_code, elapsed_s, output_tail FROM verification_run_commands WHERE run_id = ? ORDER BY ordinal`, [run.id])
        .map((c) => {
        const command = { ordinal: c.ordinal, command: c.command, exit_code: c.exit_code, elapsed_s: c.elapsed_s };
        if (withOutputTail)
            command.output_tail = c.output_tail ?? null;
        return command;
    });
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