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

// An open swe row older than this that no subagent ever bound (spawn_id NULL
// or tool_use:*) belongs to a spawn that never started or never reached
// SubagentStop; the next task_brief closes it as swept_orphan.
export const SWE_ORPHAN_AFTER_MS = 10 * 60 * 1000;

// A swe row no subagent has bound yet: opened by task_brief without a spawn
// (spawn_id NULL) or by the Agent spawn hook (spawn_id tool_use:<id>). The
// swe's first task_brief rebinds it to spawn_id = its agent_id.
const UNBOUND_SWE_RUN_SQL = "(spawn_id IS NULL OR spawn_id GLOB 'tool_use:*')";

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

const RUN_SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// JSON-Schema of the optional session_id arg the planning tools accept: the
// caller's host session, stamped on the bro row at open.
export const RUN_SESSION_ID_SCHEMA = {
  type: 'string',
  pattern: '^[A-Za-z0-9_-]{8,64}$',
  description:
    "Optional: your host session id (the session_id=<id> the activation routine injects each turn). Stamps the task's bro agent_runs row so its usage is attributed to this session.",
} as const;

// Validates the optional session_id arg. Returns null when omitted; throws on
// a value that is not 8–64 chars of [A-Za-z0-9_-].
export function parseRunSessionId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !RUN_SESSION_ID_RE.test(value)) {
    throw new Error('session_id must be 8–64 characters of [A-Za-z0-9_-].');
  }
  return value;
}

// Opens the bro row of a task at planning time; root_dir is the project root
// and session_id the caller's session (null leaves it for the Stop hook's
// legacy claim).
export function openBroRun(
  db: TrajectoryDB,
  task: { id: number; issue_id: number; repo: string | null },
  now: string,
  ctx: RunContext,
  sessionId: string | null = null,
): void {
  db.run(
    `INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, repo, root_dir, host, session_id)
     VALUES (?, ?, 'bro', ?, ?, ?, ?, ?)`,
    [task.id, task.issue_id, now, task.repo, ctx.projectRoot, ctx.host, sessionId],
  );
}

// Opens the swe row for a task unless one is already open; root_dir is the
// task's worktree. The Agent spawn hook normally opened it already and
// swe-brief-gate bound it to the swe's agent_id. An open unbound swe row older
// than SWE_ORPHAN_AFTER_MS is an earlier spawn's orphan: it is closed as
// swept_orphan and a fresh row opens; a bound row is a live spawn and is kept.
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
        AND ${UNBOUND_SWE_RUN_SQL}
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
