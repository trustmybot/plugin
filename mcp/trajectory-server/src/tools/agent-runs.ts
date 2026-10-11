import type { TrajectoryDB } from '../db.js';
import { projectRootFromDbPath } from './containment.js';

// Task statuses after which no agent_runs row of the task stays open.
export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(['closed', 'failed', 'escalated']);

export type RunHost = 'claude' | 'codex';
export type RunExitReason =
  | 'completed'
  | 'failed'
  | 'escalated'
  | 'swept_orphan'
  | 'swept_stale'
  | 'issue_closed';

// Where a run executes: the host that runs it and the project it belongs to.
// The project root is the bro row's root_dir and the containment boundary the
// server tools enforce (null when the DB has no project, e.g. :memory:).
export interface RunContext {
  readonly host: RunHost;
  readonly projectRoot: string | null;
}

export function claudeRunContext(db: TrajectoryDB, dbPath: string = db.dbPath): RunContext {
  return { host: 'claude', projectRoot: projectRootFromDbPath(dbPath || db.dbPath) };
}

// The exit_reason a terminal task status closes its open rows with.
export function exitReasonForStatus(status: string): RunExitReason {
  if (status === 'failed') return 'failed';
  if (status === 'escalated') return 'escalated';
  return 'completed';
}

// An open swe row older than this belongs to an earlier spawn that never
// reached SubagentStop; the next task_brief closes it as swept_orphan.
export const SWE_ORPHAN_AFTER_MS = 10 * 60 * 1000;

const WINDOW_MS_SQL =
  "COALESCE(CAST(ROUND((julianday(?) - julianday(started_at)) * 86400000) AS INTEGER), duration_ms)";

// Closes every open agent_runs row (bro and swe) of a task at `now` with
// `exitReason`. A row with no measured duration takes its window length.
// Returns rows closed.
export function closeOpenRunsForTask(
  db: TrajectoryDB,
  taskId: number,
  now: string,
  exitReason: RunExitReason,
): number {
  return db.run(
    `UPDATE agent_runs
        SET completed_at = ?,
            duration_ms = CASE WHEN duration_ms = 0 THEN ${WINDOW_MS_SQL} ELSE duration_ms END,
            exit_reason = ?
      WHERE task_id = ?
        AND completed_at IS NULL`,
    [now, now, exitReason, taskId],
  ).changes;
}

// Closes every open agent_runs row whose task is already terminal: a row that
// was never measured is swept_orphan, a measured one swept_stale. Returns rows
// closed.
export function sweepRunsOfTerminalTasks(db: TrajectoryDB, now: string): number {
  const placeholders = [...TERMINAL_TASK_STATUSES].map(() => '?').join(', ');
  return db.run(
    `UPDATE agent_runs
        SET completed_at = ?,
            duration_ms = CASE WHEN duration_ms = 0 THEN ${WINDOW_MS_SQL} ELSE duration_ms END,
            exit_reason = CASE WHEN usage_source IS NULL OR usage_source = 'unmeasured'
                               THEN 'swept_orphan' ELSE 'swept_stale' END
      WHERE completed_at IS NULL
        AND task_id IN (SELECT id FROM tasks WHERE status IN (${placeholders}))`,
    [now, now, ...TERMINAL_TASK_STATUSES],
  ).changes;
}

// Opens the bro row of a task at planning time; root_dir is the project root.
export function openBroRun(
  db: TrajectoryDB,
  task: { id: number; issue_id: number; repo: string | null },
  now: string,
  ctx: RunContext,
): void {
  db.run(
    `INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, repo, root_dir, host)
     VALUES (?, ?, 'bro', ?, ?, ?, ?)`,
    [task.id, task.issue_id, now, task.repo, ctx.projectRoot, ctx.host],
  );
}

// Opens the swe row for a task unless one is already open; root_dir is the
// task's worktree. An open swe row older than SWE_ORPHAN_AFTER_MS is an
// earlier spawn's orphan: it is closed as swept_orphan and a fresh row opens.
// The SubagentStop hook later UPDATEs the open row with the spawn's totals.
// Returns true when a row was inserted.
export function openSweRun(
  db: TrajectoryDB,
  task: { id: number; issue_id: number; repo: string | null },
  now: string,
  ctx: RunContext,
  rootDir: string | null,
): boolean {
  const orphanBefore = new Date(Date.parse(now) - SWE_ORPHAN_AFTER_MS).toISOString();
  db.run(
    `UPDATE agent_runs
        SET completed_at = ?,
            duration_ms = CASE WHEN duration_ms = 0 THEN ${WINDOW_MS_SQL} ELSE duration_ms END,
            exit_reason = 'swept_orphan'
      WHERE task_id = ? AND agent_type = 'swe' AND completed_at IS NULL
        AND started_at IS NOT NULL AND started_at < ?`,
    [now, now, task.id, orphanBefore],
  );
  const open = db.get<{ id: number }>(
    `SELECT id FROM agent_runs WHERE task_id = ? AND agent_type = 'swe' AND completed_at IS NULL LIMIT 1`,
    [task.id],
  );
  if (open) return false;
  db.run(
    `INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, repo, root_dir, host)
     VALUES (?, ?, 'swe', ?, ?, ?, ?)`,
    [task.id, task.issue_id, now, task.repo, rootDir, ctx.host],
  );
  return true;
}
