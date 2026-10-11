import { projectRootFromDbPath } from './containment.js';
// Task statuses after which no agent_runs row of the task stays open.
export const TERMINAL_TASK_STATUSES = new Set(['closed', 'failed', 'escalated']);
export function claudeRunContext(db, dbPath = db.dbPath) {
    return { host: 'claude', projectRoot: projectRootFromDbPath(dbPath || db.dbPath) };
}
// The exit_reason a terminal task status closes its open rows with.
export function exitReasonForStatus(status) {
    if (status === 'failed')
        return 'failed';
    if (status === 'escalated')
        return 'escalated';
    return 'completed';
}
// An open swe row older than this belongs to an earlier spawn that never
// reached SubagentStop; the next task_brief closes it as swept_orphan.
export const SWE_ORPHAN_AFTER_MS = 10 * 60 * 1000;
const WINDOW_MS_SQL = "COALESCE(CAST(ROUND((julianday(?) - julianday(started_at)) * 86400000) AS INTEGER), duration_ms)";
// Closes every open agent_runs row (bro and swe) of a task at `now` with
// `exitReason`. A row with no measured duration takes its window length.
// Returns rows closed.
export function closeOpenRunsForTask(db, taskId, now, exitReason) {
    return db.run(`UPDATE agent_runs
        SET completed_at = ?,
            duration_ms = CASE WHEN duration_ms = 0 THEN ${WINDOW_MS_SQL} ELSE duration_ms END,
            exit_reason = ?
      WHERE task_id = ?
        AND completed_at IS NULL`, [now, now, exitReason, taskId]).changes;
}
// Closes every open agent_runs row whose task is already terminal: a row that
// was never measured is swept_orphan, a measured one swept_stale. Returns rows
// closed.
export function sweepRunsOfTerminalTasks(db, now) {
    const placeholders = [...TERMINAL_TASK_STATUSES].map(() => '?').join(', ');
    return db.run(`UPDATE agent_runs
        SET completed_at = ?,
            duration_ms = CASE WHEN duration_ms = 0 THEN ${WINDOW_MS_SQL} ELSE duration_ms END,
            exit_reason = CASE WHEN usage_source IS NULL OR usage_source = 'unmeasured'
                               THEN 'swept_orphan' ELSE 'swept_stale' END
      WHERE completed_at IS NULL
        AND task_id IN (SELECT id FROM tasks WHERE status IN (${placeholders}))`, [now, now, ...TERMINAL_TASK_STATUSES]).changes;
}
const RUN_SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
// JSON-Schema of the optional session_id arg the planning tools accept: the
// caller's host session, stamped on the bro row at open.
export const RUN_SESSION_ID_SCHEMA = {
    type: 'string',
    pattern: '^[A-Za-z0-9_-]{8,64}$',
    description: "Optional: your host session id (the session_id=<id> the activation routine injects each turn). Stamps the task's bro agent_runs row so its usage is attributed to this session.",
};
// Validates the optional session_id arg. Returns null when omitted; throws on
// a value that is not 8–64 chars of [A-Za-z0-9_-].
export function parseRunSessionId(value) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== 'string' || !RUN_SESSION_ID_RE.test(value)) {
        throw new Error('session_id must be 8–64 characters of [A-Za-z0-9_-].');
    }
    return value;
}
// Opens the bro row of a task at planning time; root_dir is the project root
// and session_id the caller's session (null leaves it for the Stop hook's
// legacy claim).
export function openBroRun(db, task, now, ctx, sessionId = null) {
    db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, repo, root_dir, host, session_id)
     VALUES (?, ?, 'bro', ?, ?, ?, ?, ?)`, [task.id, task.issue_id, now, task.repo, ctx.projectRoot, ctx.host, sessionId]);
}
// Opens the swe row for a task unless one is already open; root_dir is the
// task's worktree. An open swe row older than SWE_ORPHAN_AFTER_MS is an
// earlier spawn's orphan: it is closed as swept_orphan and a fresh row opens.
// The SubagentStop hook later UPDATEs the open row with the spawn's totals.
// Returns true when a row was inserted.
export function openSweRun(db, task, now, ctx, rootDir) {
    const orphanBefore = new Date(Date.parse(now) - SWE_ORPHAN_AFTER_MS).toISOString();
    db.run(`UPDATE agent_runs
        SET completed_at = ?,
            duration_ms = CASE WHEN duration_ms = 0 THEN ${WINDOW_MS_SQL} ELSE duration_ms END,
            exit_reason = 'swept_orphan'
      WHERE task_id = ? AND agent_type = 'swe' AND completed_at IS NULL
        AND started_at IS NOT NULL AND started_at < ?`, [now, now, task.id, orphanBefore]);
    const open = db.get(`SELECT id FROM agent_runs WHERE task_id = ? AND agent_type = 'swe' AND completed_at IS NULL LIMIT 1`, [task.id]);
    if (open)
        return false;
    db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, repo, root_dir, host)
     VALUES (?, ?, 'swe', ?, ?, ?, ?)`, [task.id, task.issue_id, now, task.repo, rootDir, ctx.host]);
    return true;
}
//# sourceMappingURL=agent-runs.js.map