/**
 * The task lifecycle as an append-only event table (GH 3224, schema v77).
 * Every status move is one task_events row; tasks.status is a cache the AFTER
 * INSERT trigger keeps equal to the newest event's to_state, and a BEFORE
 * UPDATE trigger refuses any other status write. The legal moves are the
 * task_status_edges rows, seeded from the stateDiagram in
 * docs/architecture/TASKS.md "Task lifecycle" restricted to the v77 states,
 * plus two interim moves whose event types retire when the review states land.
 *
 * schema.sql holds TASK_EVENTS_SCHEMA_SQL verbatim (a test keeps the two
 * equal); the v77 migration runs it after it rebuilds tasks. The writer that
 * builds event inserts is task-status.ts.
 */
import { STATUS_CACHE_UPDATE_SQL, type TaskStatus } from './task-status.js';

/** The kinds of record a move rests on: each names the table its record_id points into. */
export const TASK_RECORD_KINDS = ['task', 'agent_run', 'verification_run', 'audit', 'issue'] as const;
export type TaskRecordKind = (typeof TASK_RECORD_KINDS)[number];

interface Coded {
  readonly description: string;
  /** Set once the code is out of use; the guard refuses a new event that names it. */
  readonly retiredAt?: string;
}

export const TASK_EVENT_TYPES = {
  provisioned: { description: 'bro provisioned the task; the record is the task row and its spec.' },
  spawned: { description: 'Its author was spawned, or bro began a task it writes itself.' },
  spawn_rolled_back: { description: 'The spawn was rolled back before its author ran.' },
  submitted: { description: 'The author closed the task and its checks passed.' },
  submitted_unverified: {
    description: 'The author closed the task with no passing verification run for the commit: an empty verification[] or a waived gate.',
  },
  resubmitted: { description: 'bro handed an unchanged commit back for a re-review.' },
  failed: { description: 'The author stopped: a policy deny, a spec contradiction or a broken environment.' },
  run_stale: { description: "The stale sweep failed a running task whose author's process is gone." },
  bro_closed: { description: "bro closed the task on its close record. Interim: retires when the review states land." },
  merged_outside_flow: { description: "The task's branch merged outside the flow; the record is the task and its landed commit." },
  recovered: { description: 'The recovery step closed a stuck task at its landed commit.' },
  reopened: { description: 'bro reopened the task.' },
  superseded: { description: 'The task was retried as a new task; the record is the new task.' },
  issue_cancelled: { description: 'Its issue closed over it.' },
  branch_dropped: { description: 'Its feature branch was dropped. Interim: retires when review_deferred lands.' },
  backfilled: { description: 'The state the task held when the event table arrived (schema v77).' },
} as const satisfies Record<string, Coded>;

export type TaskEventType = keyof typeof TASK_EVENT_TYPES;

export const TASK_EVENT_CAUSES = {
  planned: { description: "bro provisioned the task from its plan." },
  retry: { description: 'A retry: the new task, or the task it replaces.' },
  author_spawned: { description: 'The author agent started.' },
  spawn_refused: { description: 'The spawn was refused or rolled back.' },
  checks_passed: { description: "The author's verification run passed for the commit." },
  unverified: { description: 'No verification run passed for the commit: verification[] was empty or the gate was waived.' },
  re_review: { description: 'An unchanged commit goes back to review.' },
  author_stopped: { description: 'The author ended its run failed.' },
  author_gone: { description: "The author's process is gone past the stale window." },
  bro_close: { description: "bro's close after the review step." },
  merged_outside_flow: { description: 'The branch merged outside the flow.' },
  recovery: { description: 'The recovery step closed a stuck task.' },
  rework: { description: 'bro reopened the task for more work.' },
  review_failed: { description: "code-reviewer's verdict failed the commit." },
  issue_closed: { description: 'The issue closed over the task.' },
  feature_branch_dropped: { description: 'The Human dropped the feature branch.' },
  manual: { description: "bro moved the task by hand; the event's note says why." },
  backfill: { description: 'The v77 migration recorded the state the task held.' },
} as const satisfies Record<string, Coded>;

export type TaskEventCause = keyof typeof TASK_EVENT_CAUSES;

export interface TaskStatusEdge {
  readonly from: TaskStatus | null;
  readonly to: TaskStatus;
  readonly eventType: TaskEventType;
  readonly recordKind: TaskRecordKind;
  /** The one cause the move admits; null admits any cause. */
  readonly requiredCause: TaskEventCause | null;
}

const edge = (
  from: TaskStatus | null,
  to: TaskStatus,
  eventType: TaskEventType,
  recordKind: TaskRecordKind,
  requiredCause: TaskEventCause | null = null,
): TaskStatusEdge => ({ from, to, eventType, recordKind, requiredCause });

const SUPERSEDABLE: readonly TaskStatus[] = ['pending', 'running', 'submitted', 'failed', 'closed'];
const CANCELLABLE_BY_ISSUE: readonly TaskStatus[] = ['pending', 'running', 'submitted'];

/** The moves the DB accepts: one row per (from, to, event type), with the record kind each rests on. */
export const TASK_STATUS_EDGES: readonly TaskStatusEdge[] = [
  edge(null, 'pending', 'provisioned', 'task'),
  edge('pending', 'running', 'spawned', 'agent_run'),
  edge('running', 'pending', 'spawn_rolled_back', 'agent_run'),
  edge('running', 'submitted', 'submitted', 'verification_run'),
  edge('running', 'submitted', 'submitted_unverified', 'task', 'unverified'),
  edge('running', 'submitted', 'resubmitted', 'audit'),
  edge('running', 'failed', 'failed', 'agent_run'),
  edge('running', 'failed', 'run_stale', 'audit'),
  edge('submitted', 'closed', 'bro_closed', 'audit'),
  edge('pending', 'closed', 'merged_outside_flow', 'task'),
  edge('running', 'closed', 'merged_outside_flow', 'task'),
  edge('submitted', 'closed', 'merged_outside_flow', 'task'),
  edge('pending', 'closed', 'recovered', 'audit'),
  edge('submitted', 'closed', 'recovered', 'audit'),
  edge('submitted', 'running', 'reopened', 'audit'),
  edge('failed', 'running', 'reopened', 'audit'),
  edge('closed', 'running', 'reopened', 'audit'),
  ...SUPERSEDABLE.map((from) => edge(from, 'superseded', 'superseded', 'task')),
  ...CANCELLABLE_BY_ISSUE.map((from) => edge(from, 'cancelled', 'issue_cancelled', 'issue')),
  edge('closed', 'cancelled', 'branch_dropped', 'audit', 'feature_branch_dropped'),
];

/** The states with an edge into `to`, each once, in edge order. */
export function sourcesInto(to: TaskStatus): TaskStatus[] {
  return [...new Set(TASK_STATUS_EDGES.flatMap((e) => (e.to === to && e.from !== null ? [e.from] : [])))];
}

/** The edge a move takes, or undefined when the DB would refuse it. */
export function findEdge(from: TaskStatus | null, to: TaskStatus, eventType: TaskEventType): TaskStatusEdge | undefined {
  return TASK_STATUS_EDGES.find((e) => e.from === from && e.to === to && e.eventType === eventType);
}

const literal = (value: string | null): string => (value === null ? 'NULL' : `'${value.replace(/'/g, "''")}'`);
const listSql = (values: readonly string[]): string => values.map((v) => literal(v)).join(',');
const codeRows = (codes: Record<string, Coded>): string =>
  Object.entries(codes)
    .map(([code, c]) => `    (${literal(code)}, ${literal(c.description)}, ${literal(c.retiredAt ?? null)})`)
    .join(',\n');

/** The tasks.status CHECK list of the v77 shape. */
export function taskStatusCheckSql(states: readonly string[]): string {
  return `CHECK (status IN (${listSql(states)}))`;
}

// task_retry_attempted audit rows name the retried task and its retry.
const RETRY_ROW = `audit r WHERE r.event_type = 'task_retry_attempted' AND json_valid(r.content_json)`;

/**
 * The v77 state of a pre-v77 task row (alias `tasks`): completed and
 * needs_validation become submitted; an escalated task becomes superseded when
 * a task_retry_attempted row names it as failed_task_id, else failed, which
 * bro can still reopen. `withAudit` false (no audit table) maps escalated to failed.
 */
export function v77StatusSql(withAudit: boolean): string {
  const retried = withAudit
    ? `EXISTS (SELECT 1 FROM ${RETRY_ROW} AND json_extract(r.content_json, '$.failed_task_id') = tasks.id)`
    : '0';
  return `CASE status WHEN 'completed' THEN 'submitted' WHEN 'needs_validation' THEN 'submitted'
                 WHEN 'escalated' THEN CASE WHEN ${retried} THEN 'superseded' ELSE 'failed' END
                 ELSE status END`;
}

/** tasks.retry_of of a pre-v77 row: the failed_task_id of the first task_retry_attempted row naming it as new_task_id. */
export const V77_RETRY_OF_SQL = `(SELECT json_extract(r.content_json, '$.failed_task_id') FROM ${RETRY_ROW}
                   AND json_extract(r.content_json, '$.new_task_id') = tasks.id
                   AND EXISTS (SELECT 1 FROM tasks f WHERE f.id = json_extract(r.content_json, '$.failed_task_id'))
                 ORDER BY r.id LIMIT 1)`;

/**
 * The v77 backfill: one event per task with none, stating its state, with
 * occurred_at the task's updated_at and recorded_at the migration time.
 */
export const TASK_EVENTS_BACKFILL_SQL = `INSERT INTO task_events (task_id, seq, event_type, from_state, to_state, role, cause, idempotency_key, backfilled, occurred_at, recorded_at)
SELECT t.id, 1, 'backfilled', NULL, t.status, 'system', 'backfill', 'backfill:' || t.id, 1,
       COALESCE(NULLIF(t.updated_at, ''), strftime('%Y-%m-%dT%H:%M:%fZ','now')), strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM tasks t
 WHERE NOT EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = t.id)
 ORDER BY t.id`;

// An edge matches the event when its three keys match and its event type is in use.
const EDGE_MATCH =
  's.from_state IS NEW.from_state AND s.to_state = NEW.to_state AND s.event_type = NEW.event_type' +
  ' AND (SELECT y.retired_at FROM task_event_types y WHERE y.code = s.event_type) IS NULL';

/**
 * The lifecycle tables, their guard, cache and status-lock triggers and the
 * seed rows. Every statement is idempotent; the seeds upsert so a changed
 * description or retirement reaches an existing DB on the next open.
 */
export const TASK_EVENTS_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS task_event_types (
    code         TEXT PRIMARY KEY,
    description  TEXT NOT NULL,
    retired_at   TEXT
);

CREATE TABLE IF NOT EXISTS task_event_causes (
    code         TEXT PRIMARY KEY,
    description  TEXT NOT NULL,
    retired_at   TEXT
);

CREATE TABLE IF NOT EXISTS task_status_edges (
    from_state      TEXT,
    to_state        TEXT NOT NULL,
    event_type      TEXT NOT NULL REFERENCES task_event_types(code),
    record_kind     TEXT NOT NULL CHECK (record_kind IN (${listSql(TASK_RECORD_KINDS)})),
    required_cause  TEXT REFERENCES task_event_causes(code)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_status_edges_move
    ON task_status_edges(IFNULL(from_state, ''), to_state, event_type);

CREATE TABLE IF NOT EXISTS task_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id          INTEGER NOT NULL REFERENCES tasks(id),
    seq              INTEGER NOT NULL,
    event_type       TEXT    NOT NULL REFERENCES task_event_types(code),
    from_state       TEXT,
    to_state         TEXT    NOT NULL,
    role             TEXT    NOT NULL,
    agent_run_id     INTEGER REFERENCES agent_runs(id),
    cause            TEXT    NOT NULL REFERENCES task_event_causes(code),
    note             TEXT,
    record_kind      TEXT    CHECK (record_kind IS NULL OR record_kind IN (${listSql(TASK_RECORD_KINDS)})),
    record_id        INTEGER,
    idempotency_key  TEXT    UNIQUE,
    backfilled       INTEGER NOT NULL DEFAULT 0 CHECK (backfilled IN (0,1)),
    occurred_at      TEXT    NOT NULL,
    recorded_at      TEXT    NOT NULL,
    UNIQUE (task_id, seq)
);

CREATE TRIGGER IF NOT EXISTS task_events_guard BEFORE INSERT ON task_events
BEGIN
    SELECT RAISE(ABORT, 'task_events: no such task')
     WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.task_id);
    SELECT RAISE(ABORT, 'task_events: seq must be the next seq of the task')
     WHERE NEW.seq IS NOT (SELECT COALESCE(MAX(seq), 0) + 1 FROM task_events WHERE task_id = NEW.task_id);
    SELECT RAISE(ABORT, 'task_events: from_state must be the task status, or NULL on its first event')
     WHERE NEW.from_state IS NOT (SELECT status FROM tasks WHERE id = NEW.task_id)
       AND (NEW.from_state IS NOT NULL OR NEW.seq > 1);
    SELECT RAISE(ABORT, 'task_events: cause must be a task_event_causes code in use')
     WHERE NOT EXISTS (SELECT 1 FROM task_event_causes c WHERE c.code = NEW.cause AND c.retired_at IS NULL);
    SELECT RAISE(ABORT, 'task_events: a backfilled event is the first event of its task and states its status')
     WHERE NEW.backfilled = 1
       AND (NEW.seq <> 1 OR NEW.from_state IS NOT NULL OR NEW.event_type IS NOT 'backfilled'
            OR NEW.to_state IS NOT (SELECT status FROM tasks WHERE id = NEW.task_id));
    SELECT RAISE(ABORT, 'task_events: the move is not a task_status_edges edge')
     WHERE NEW.backfilled = 0
       AND NOT EXISTS (SELECT 1 FROM task_status_edges s WHERE ${EDGE_MATCH});
    SELECT RAISE(ABORT, 'task_events: the move admits only the cause its edge names')
     WHERE NEW.backfilled = 0
       AND EXISTS (SELECT 1 FROM task_status_edges s WHERE ${EDGE_MATCH}
                      AND s.required_cause IS NOT NULL AND s.required_cause IS NOT NEW.cause);
    SELECT RAISE(ABORT, 'task_events: a manual move carries a note')
     WHERE NEW.cause = 'manual' AND length(trim(COALESCE(NEW.note, ''))) = 0;
    SELECT RAISE(ABORT, 'task_events: the move rests on its edge record kind, or on the manual cause with a note')
     WHERE NEW.backfilled = 0 AND NEW.cause IS NOT 'manual'
       AND (NEW.record_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM task_status_edges s WHERE ${EDGE_MATCH}
                              AND s.record_kind = NEW.record_kind));
END;

CREATE TRIGGER IF NOT EXISTS task_events_no_update BEFORE UPDATE ON task_events
BEGIN
    SELECT RAISE(ABORT, 'task_events is append-only: an event is never updated');
END;

CREATE TRIGGER IF NOT EXISTS task_events_no_delete BEFORE DELETE ON task_events
BEGIN
    SELECT RAISE(ABORT, 'task_events is append-only: an event is never deleted');
END;

CREATE TRIGGER IF NOT EXISTS task_events_status_cache AFTER INSERT ON task_events
BEGIN
    ${STATUS_CACHE_UPDATE_SQL};
END;

CREATE TRIGGER IF NOT EXISTS tasks_status_follows_events BEFORE UPDATE OF status ON tasks
WHEN NEW.status IS NOT OLD.status
BEGIN
    SELECT RAISE(ABORT, 'tasks.status follows task_events: insert a task_events row to move a task')
     WHERE NEW.status IS NOT (SELECT e.to_state FROM task_events e WHERE e.task_id = NEW.id ORDER BY e.seq DESC LIMIT 1);
END;

INSERT INTO task_event_types (code, description, retired_at) VALUES
${codeRows(TASK_EVENT_TYPES)}
ON CONFLICT(code) DO UPDATE SET description = excluded.description, retired_at = excluded.retired_at;

INSERT INTO task_event_causes (code, description, retired_at) VALUES
${codeRows(TASK_EVENT_CAUSES)}
ON CONFLICT(code) DO UPDATE SET description = excluded.description, retired_at = excluded.retired_at;

INSERT OR IGNORE INTO task_status_edges (from_state, to_state, event_type, record_kind, required_cause) VALUES
${TASK_STATUS_EDGES.map((e) => `    (${literal(e.from)}, ${literal(e.to)}, ${literal(e.eventType)}, ${literal(e.recordKind)}, ${literal(e.requiredCause)})`).join(',\n')};
`;
