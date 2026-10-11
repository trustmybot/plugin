// Task statuses after which no agent_runs row of the task stays open.
export const TERMINAL_TASK_STATUSES = new Set(['closed', 'failed', 'escalated']);
const WINDOW_MS_SQL = "COALESCE(CAST(ROUND((julianday(?) - julianday(started_at)) * 86400000) AS INTEGER), duration_ms)";
// Closes every open agent_runs row (bro and swe) of a task at `now`. A row
// with no measured duration takes its window length. Returns rows closed.
export function closeOpenRunsForTask(db, taskId, now) {
    return db.run(`UPDATE agent_runs
        SET completed_at = ?,
            duration_ms = CASE WHEN duration_ms = 0 THEN ${WINDOW_MS_SQL} ELSE duration_ms END
      WHERE task_id = ?
        AND completed_at IS NULL`, [now, now, taskId]).changes;
}
// Closes every open agent_runs row whose task is already terminal. Returns
// rows closed.
export function sweepRunsOfTerminalTasks(db, now) {
    const placeholders = [...TERMINAL_TASK_STATUSES].map(() => '?').join(', ');
    return db.run(`UPDATE agent_runs
        SET completed_at = ?,
            duration_ms = CASE WHEN duration_ms = 0 THEN ${WINDOW_MS_SQL} ELSE duration_ms END
      WHERE completed_at IS NULL
        AND task_id IN (SELECT id FROM tasks WHERE status IN (${placeholders}))`, [now, now, ...TERMINAL_TASK_STATUSES]).changes;
}
// Opens the swe row for a task unless one is already open. The SubagentStop
// hook later UPDATEs it with the spawn's totals. Returns true when a row was
// inserted.
export function openSweRun(db, task, now) {
    const open = db.get(`SELECT id FROM agent_runs WHERE task_id = ? AND agent_type = 'swe' AND completed_at IS NULL LIMIT 1`, [task.id]);
    if (open)
        return false;
    db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, repo)
     VALUES (?, ?, 'swe', ?, ?)`, [task.id, task.issue_id, now, task.repo]);
    return true;
}
//# sourceMappingURL=agent-runs.js.map