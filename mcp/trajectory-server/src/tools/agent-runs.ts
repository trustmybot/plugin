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

// A row carrying no token usage: what the swe_runs_metered doctor contract
// counts unless usage_source is 'unmeasured'.
const NO_USAGE_SQL =
  'COALESCE(tokens_in, 0) = 0 AND COALESCE(tokens_out, 0) = 0 ' +
  'AND COALESCE(cache_read_tokens, 0) = 0 AND COALESCE(cache_creation_tokens, 0) = 0';

// The one usage rule of a closing row: no usage and no usage_source becomes
// 'unmeasured'; tokens or a source already written are kept.
const UNMEASURED_IF_NO_USAGE_SQL =
  `usage_source = COALESCE(usage_source, CASE WHEN ${NO_USAGE_SQL} THEN 'unmeasured' END)`;

// The one finalize path of the server: closes the open agent_runs rows that
// match `where` at `now` with `exitReasonSql`. A row with no measured duration
// takes its window length; a row with no usage is marked unmeasured. `params`
// binds the placeholders of `exitReasonSql`, then of `where`. Returns rows
// closed.
function finalizeOpenRuns(
  db: TrajectoryDB,
  now: string,
  exitReasonSql: string,
  where: string,
  params: unknown[],
): number {
  return db.run(
    `UPDATE agent_runs
        SET completed_at = ?,
            duration_ms = CASE WHEN duration_ms = 0 THEN ${WINDOW_MS_SQL} ELSE duration_ms END,
            exit_reason = ${exitReasonSql},
            ${UNMEASURED_IF_NO_USAGE_SQL}
      WHERE completed_at IS NULL
        AND (${where})`,
    [now, now, ...params],
  ).changes;
}

// Closes every open agent_runs row (bro and swe) of a task at `now` with
// `exitReason`. Returns rows closed.
export function closeOpenRunsForTask(
  db: TrajectoryDB,
  taskId: number,
  now: string,
  exitReason: RunExitReason,
): number {
  return finalizeOpenRuns(db, now, '?', 'task_id = ?', [exitReason, taskId]);
}

// Closes every open agent_runs row whose task is already terminal: a row that
// was never measured is swept_orphan, a measured one swept_stale. Returns rows
// closed.
export function sweepRunsOfTerminalTasks(db: TrajectoryDB, now: string): number {
  const placeholders = [...TERMINAL_TASK_STATUSES].map(() => '?').join(', ');
  return finalizeOpenRuns(
    db,
    now,
    "CASE WHEN usage_source IS NULL OR usage_source = 'unmeasured' THEN 'swept_orphan' ELSE 'swept_stale' END",
    `task_id IN (SELECT id FROM tasks WHERE status IN (${placeholders}))`,
    [...TERMINAL_TASK_STATUSES],
  );
}

// Marks unmeasured the swe/code-reviewer rows closed with no usage and no
// usage_source: rows a finalize path closed before GH 1673 applied the usage
// rule on close. Open rows, bro rows and rows with tokens or a source are
// kept. Returns rows marked.
export function markLegacyUnmeteredRuns(db: TrajectoryDB): number {
  return db.run(
    `UPDATE agent_runs
        SET usage_source = 'unmeasured'
      WHERE completed_at IS NOT NULL
        AND usage_source IS NULL
        AND agent_type IN ('swe', 'code-reviewer')
        AND ${NO_USAGE_SQL}`,
  ).changes;
}

const RUN_SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// JSON-Schema of the optional session_id arg the planning tools still accept
// so existing callers keep working; bro usage is metered per session by the
// bro-turn-usage Stop hook, not per task.
export const RUN_SESSION_ID_SCHEMA = {
  type: 'string',
  pattern: '^[A-Za-z0-9_-]{8,64}$',
  description:
    "Optional: your host session id (the session_id=<id> the activation routine injects each turn). Validated and otherwise unused: bro usage is metered per session by the bro-turn-usage Stop hook, not per task.",
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

export const SWE_RESUME_OBSERVE_FROM_NODE = 'hook:swe-brief-gate';
export const SWE_RESUME_OBSERVATION_TTL_S = 600;

// The swe a swe_resume_observed row names, when swe-brief-gate recorded it for
// this task within SWE_RESUME_OBSERVATION_TTL_S of `now`, it is unconsumed,
// and the swe has an earlier row of the task: that latest row, its spawn_id
// and effort.
function observedResume(
  db: TrajectoryDB,
  taskId: number,
  now: string,
): { observationId: number; previous: { id: number; spawn_id: string; effort: string | null } } | null {
  const observedAfter = new Date(Date.parse(now) - SWE_RESUME_OBSERVATION_TTL_S * 1000).toISOString();
  const observation = db.get<{ id: number; agent_id: string | null }>(
    `SELECT id, json_extract(content_json, '$.agent_id') AS agent_id
       FROM audit
      WHERE event_type = 'swe_resume_observed'
        AND from_node = ?
        AND json_valid(content_json)
        AND CAST(json_extract(content_json, '$.task_id') AS INTEGER) = ?
        AND COALESCE(json_extract(content_json, '$.consumed'), 0) = 0
        AND COALESCE(json_extract(content_json, '$.observed_at'), created_at) >= ?
      ORDER BY id DESC
      LIMIT 1`,
    [SWE_RESUME_OBSERVE_FROM_NODE, taskId, observedAfter],
  );
  if (!observation || typeof observation.agent_id !== 'string' || observation.agent_id === '') return null;
  const previous = db.get<{ id: number; spawn_id: string; effort: string | null }>(
    `SELECT id, spawn_id, effort FROM agent_runs
      WHERE task_id = ? AND agent_type = 'swe' AND spawn_id = ?
      ORDER BY id DESC LIMIT 1`,
    [taskId, observation.agent_id],
  );
  return previous ? { observationId: observation.id, previous } : null;
}

// Opens the swe row for a task unless one is already open; root_dir is the
// task's worktree. The Agent spawn hook normally opened it already and
// swe-brief-gate bound it to the swe's agent_id. An open unbound swe row older
// than SWE_ORPHAN_AFTER_MS is an earlier spawn's orphan: it is closed as
// swept_orphan and a fresh row opens; a bound row is a live spawn and is kept.
// A swe resumed through SendMessage (GH 1742) reaches its task_brief with no
// open row; swe-brief-gate recorded its agent_id as swe_resume_observed, and
// the row opened for it carries that spawn_id, resumed_from = its previous
// row and that row's effort, and the observation is consumed. Any other new
// row is a fresh one (resumed_from NULL).
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
  finalizeOpenRuns(
    db,
    now,
    "'swept_orphan'",
    `task_id = ? AND agent_type = 'swe' AND ${UNBOUND_SWE_RUN_SQL} AND started_at IS NOT NULL AND started_at < ?`,
    [task.id, orphanBefore],
  );
  const open = db.get<{ id: number }>(
    `SELECT id FROM agent_runs WHERE task_id = ? AND agent_type = 'swe' AND completed_at IS NULL LIMIT 1`,
    [task.id],
  );
  if (open) return false;
  const resume = observedResume(db, task.id, now);
  if (resume) {
    db.transaction(() => {
      db.run(
        `INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, repo, root_dir, host, spawn_id, effort, resumed_from, plugin_version)
         VALUES (?, ?, 'swe', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [task.id, task.issue_id, now, task.repo, rootDir, ctx.host, resume.previous.spawn_id, resume.previous.effort, resume.previous.id, db.pluginVersion],
      );
      db.run(`UPDATE audit SET content_json = json_set(content_json, '$.consumed', 1) WHERE id = ?`, [resume.observationId]);
    });
    return true;
  }
  db.run(
    `INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, repo, root_dir, host, plugin_version)
     VALUES (?, ?, 'swe', ?, ?, ?, ?, ?)`,
    [task.id, task.issue_id, now, task.repo, rootDir, ctx.host, db.pluginVersion],
  );
  return true;
}
