/**
 * Data contracts for the trajectory DB: one declarative list of invariants on
 * the rows TMB writes over time. The `trajectory_doctor` tool, the SessionStart
 * banner (via the generated `scripts/hooks/lib/data-contracts.json`) and the
 * L5/L6 gate (`scripts/maintenance/trajectory-doctor.sh`) all run this list.
 *
 * Each DB contract's `sql` is one read-only SELECT returning a single number;
 * the contract holds when `actual <op> value`. A NULL result never holds.
 * `params` are bound by name (`:name`), each read from an environment variable
 * with a numeric default. A DB contract with `skip_when` is skipped with its
 * reason when that SELECT returns a non-zero number (its reference point is
 * missing); the skip leaves the report healthy. A file contract (`source: 'files'`) reads Claude Code
 * config files instead; it runs only in `trajectory_doctor`, not in the hook
 * copy, and is skipped with a reason when its inputs are unavailable — a skip
 * that leaves the report healthy, because absent inputs are no evidence of a
 * fault.
 */
import { AUDIT_EVENT_TYPES } from './audit-events.js';
import { HAS_PASS_SQL, STALE_RUNNING_HOURS_DEFAULT, reviewSkipAuthoredSql } from './tools/lifecycle.js';
import { STRAY_DB_MAX_DEPTH, claudeProjectRootOfDb, otherClaudeDbs } from './platform.js';
import { enabledPluginCopies } from './utils/plugin-installs.js';

export type ContractSeverity = 'error' | 'warn';
export type ContractOp = '=' | '<=' | '>=';

export interface ContractExpect {
  readonly op: ContractOp;
  readonly value: number;
}

export interface ContractParam {
  readonly name: string;
  readonly env: string;
  readonly default: number;
}

export interface SqlContract {
  readonly source?: 'db';
  readonly id: string;
  readonly severity: ContractSeverity;
  readonly description: string;
  readonly sql: string;
  readonly expect: ContractExpect;
  readonly sample_sql?: string;
  readonly params?: readonly ContractParam[];
  /** The plugin_meta.schema_version that added the columns this contract reads. */
  readonly min_schema?: number;
  /** A SELECT returning one number; non-zero skips the contract with `reason`. */
  readonly skip_when?: { readonly sql: string; readonly reason: string };
}

export type FileCheckResult =
  | { readonly actual: number; readonly sample: Array<Record<string, unknown>> }
  | { readonly skipped: string };

/** The checked DB file; absent when the reader has no file behind it. */
export interface FileCheckContext {
  readonly dbPath?: string;
}

export interface FileContract {
  readonly source: 'files';
  readonly id: string;
  readonly severity: ContractSeverity;
  readonly description: string;
  readonly expect: ContractExpect;
  readonly check: (env: NodeJS.ProcessEnv, ctx: FileCheckContext) => FileCheckResult;
  readonly sql?: never;
  readonly params?: never;
  readonly min_schema?: never;
  readonly skip_when?: never;
}

export type Contract = SqlContract | FileContract;

export const isSqlContract = (c: Contract): c is SqlContract => c.source !== 'files';

export function singleTmbPluginEnabled(env: NodeJS.ProcessEnv): FileCheckResult {
  const result = enabledPluginCopies(env);
  if ('skipped' in result) return { skipped: result.skipped };
  return { actual: result.copies.length, sample: result.copies.map((c) => ({ ...c })) };
}

export function noOtherTrajectoryDbs(env: NodeJS.ProcessEnv, ctx: FileCheckContext): FileCheckResult {
  const dbPath = ctx.dbPath;
  if (dbPath === undefined || claudeProjectRootOfDb(dbPath) === null) {
    return { skipped: 'the checked DB is not a <project>/.claude/<plugin>/trajectory.db file' };
  }
  const others = otherClaudeDbs(dbPath, {
    sessionDir: env['CLAUDE_PROJECT_DIR'] || process.cwd(),
    ...(env['HOME'] ? { home: env['HOME'] } : {}),
  });
  if (others === null) return { skipped: 'the checked DB has no project root' };
  return {
    actual: others.length,
    sample: others.map((o) => ({ path: o.path, issues: o.issues, tasks: o.tasks })),
  };
}

export interface NullableColumn {
  readonly table: string;
  readonly column: string;
  readonly reason: string;
}

interface PopulatedColumn {
  readonly table: 'agent_runs' | 'tasks';
  readonly column: string;
  readonly created_column: string;
  readonly scope?: string;
  readonly scope_label?: string;
  /** Rows created before this timestamp predate the column's writer and are not counted. */
  readonly writer_since?: { readonly sql: string; readonly label: string; readonly min_schema: number };
  readonly floor: number;
  readonly min_schema: number;
}

const daysAgo = (days: number): string => `strftime('%Y-%m-%dT%H:%M:%fZ','now','-${days} days')`;
const hoursAgo = (hours: number): string => `strftime('%Y-%m-%dT%H:%M:%fZ','now','-${hours} hours')`;
// A stored timestamp in the one ms-ISO form, so a legacy `YYYY-MM-DD HH:MM:SS`
// value compares by time, not by its separator character.
const ts = (column: string): string => `strftime('%Y-%m-%dT%H:%M:%fZ', ${column})`;
const auditTaskId = (alias: string): string =>
  `CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.task_id') END`;
const auditCommitSha = (alias: string): string =>
  `CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.commit_sha') END`;

const SPEC_SHAPE_WAIVER_NOT_READ_BY_GATE = (alias: string): string =>
  `${alias}.event_type = 'spec_shape_gate_waived'
               AND (NOT EXISTS (SELECT 1 FROM tasks t
                                 WHERE t.id = CAST(${auditTaskId(alias)} AS INTEGER)
                                   AND CAST(CAST(${auditTaskId(alias)} AS INTEGER) AS TEXT) = CAST(${auditTaskId(alias)} AS TEXT))
                    OR COALESCE(CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.gate') END, '') <> 'spec_shape')`;

export const REVIEW_GRACE_HOURS_DEFAULT = 24;

// A run's commit_sha is the full HEAD the gate tested; tasks.commit_sha may be
// the short form task_update_status was given.
const runMatchesTaskCommit = (run: string, task: string): string =>
  `${run}.task_id = ${task}.id AND substr(${run}.commit_sha, 1, length(${task}.commit_sha)) = ${task}.commit_sha`;

// The v36 migration keeps no applied-at timestamp (plugin_meta holds only the
// schema version), so the first recorded verification run stands in for it:
// tasks closed before it predate the recorder.
const V36_RECORDING_SINCE = `(SELECT MIN(${ts('started_at')}) FROM verification_runs)`;

const VERIFIED_CLOSE_SCOPE = `t.status = 'closed' AND ${ts('t.updated_at')} >= ${daysAgo(7)}
               AND ${ts('t.updated_at')} >= ${V36_RECORDING_SINCE}
               AND COALESCE(t.commit_sha, '') <> '' AND COALESCE(t.verification, '[]') NOT IN ('', '[]')
               AND NOT EXISTS (SELECT 1 FROM audit w WHERE w.event_type = 'verification_gate_waived' AND ${auditTaskId('w')} = t.id)`;

const UNCONSUMED_STALE_OBSERVATION = (alias: string): string =>
  `${alias}.event_type = 'reviewer_identity_observed' AND ${ts(`${alias}.created_at`)} < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hours')
               AND COALESCE(CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.consumed') END, 0) = 0
               AND COALESCE(CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.superseded') END, 0) = 0`;

const LIVE_TASK_STATUSES = "'pending','running','needs_validation','completed'";

// The L2 concept tables (GH 1680) arrived in v45, tasks.completion_report in v48.
const CONCEPTS_SCHEMA = 45;
const COMPLETION_REPORT_SCHEMA = 48;
const PENDING_PROPOSAL_DAYS = 7;
const CONCEPTS_MIN_SYMBOLS = 100;

const auditField = (alias: string, field: string): string =>
  `CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.${field}') END`;

// One row per concept a closed, reviewed task proposed (report.concepts) that
// applyConceptProposals has neither applied nor rejected, closed over
// PENDING_PROPOSAL_DAYS days ago.
const PENDING_PROPOSALS = `tasks t,
               json_each(CASE WHEN json_valid(t.completion_report) THEN t.completion_report ELSE '{}' END, '$.concepts') c
             WHERE t.status = 'closed' AND ${ts('t.updated_at')} < ${daysAgo(PENDING_PROPOSAL_DAYS)}
               AND ${HAS_PASS_SQL}
               AND NOT EXISTS (SELECT 1 FROM audit p
                                WHERE p.event_type IN ('concept_proposal_applied','concept_proposal_rejected')
                                  AND ${auditField('p', 'task_id')} = t.id
                                  AND ${auditField('p', 'name')} = json_extract(c.value, '$.name'))`;

const UNCONCEPTUALIZED_REPOS = `(SELECT repo, COUNT(*) AS symbols FROM wm_symbols GROUP BY repo HAVING COUNT(*) >= ${CONCEPTS_MIN_SYMBOLS}) s
             WHERE NOT EXISTS (SELECT 1 FROM wm_concepts k WHERE k.repo = s.repo AND k.status <> 'retired')`;

// The plugin / MCP-server names the scan fixtures in src/test/ register.
const FIXTURE_INVENTORY_ROW = (alias: string): string =>
  `${alias}.kind IN ('plugin','mcp')
               AND (${alias}.name IN ('alpha','beta','alpha-server')
                    OR ${alias}.name GLOB 'fixture-*' OR ${alias}.name GLOB 'test-plugin*'
                    OR COALESCE(${alias}.source_url, '') LIKE '%@tmb-test-market')`;

// The writers stamp root_dir and session_id on a run and meter its model; rows
// opened before those writers shipped (v1.1.0-rc.1) carry NULLs nothing fills.
// plugin_meta keeps no applied-at timestamp, so the first run carrying a
// root_dir stands in for that date.
const V33_RUN_WRITERS_SINCE = {
  sql: `(SELECT MIN(${ts('started_at')}) FROM agent_runs WHERE root_dir IS NOT NULL)`,
  label: 'the first run carrying a root_dir',
  min_schema: 33,
} as const;

/** Columns added in v29–v33 that stay NULL by design; they get no contract. */
export const NULLABLE_COLUMNS: readonly NullableColumn[] = [
  { table: 'discussions', column: 'remote_comment_id', reason: 'set only on discussions ingested from a PR/MR comment; NULL for every local discussion' },
  { table: 'agent_runs', column: 'spawn_id', reason: 'set only on swe rows (one per Agent-tool spawn); bro rows have no spawn' },
];

// bro is metered per session (one bro row per session, task_id NULL); the
// per-task bro rows older versions opened are history no writer fills, so no
// agent_runs contract counts them.
const NOT_PER_TASK_BRO_ROW = "NOT (agent_type = 'bro' AND task_id IS NOT NULL)";
const BRO_SESSION_ROW = "agent_type = 'bro' AND task_id IS NULL";

/**
 * Columns added in v29–v33 that have a writer: the NULL rate over rows created
 * in the last 30 days (within `scope`; agent_runs without per-task bro rows)
 * must stay at or under `floor`.
 */
const POPULATED_COLUMNS: readonly PopulatedColumn[] = [
  { table: 'agent_runs', column: 'session_id', created_column: 'started_at', writer_since: V33_RUN_WRITERS_SINCE, floor: 0.2, min_schema: 30 },
  { table: 'agent_runs', column: 'usage_source', created_column: 'started_at', scope: 'completed_at IS NOT NULL', scope_label: 'completed rows', floor: 0.05, min_schema: 30 },
  { table: 'agent_runs', column: 'model', created_column: 'started_at', scope: "usage_source IN ('transcript','subagent_stop','backfill')", scope_label: 'measured rows', writer_since: V33_RUN_WRITERS_SINCE, floor: 0.1, min_schema: 33 },
  { table: 'agent_runs', column: 'host', created_column: 'started_at', floor: 0, min_schema: 33 },
  { table: 'agent_runs', column: 'root_dir', created_column: 'started_at', writer_since: V33_RUN_WRITERS_SINCE, floor: 0.05, min_schema: 33 },
  { table: 'agent_runs', column: 'exit_reason', created_column: 'started_at', scope: 'completed_at IS NOT NULL', scope_label: 'completed rows', floor: 0.05, min_schema: 33 },
  { table: 'tasks', column: 'prompt_bearing', created_column: 'created_at', floor: 0, min_schema: 0 },
  // The v37 migration keeps no applied-at timestamp, so the first run carrying
  // an effort anchors the window: runs metered before v37 stay NULL by design.
  {
    table: 'agent_runs',
    column: 'effort',
    created_column: 'started_at',
    scope: `agent_type IN ('swe','pr-reviewer') AND usage_source = 'subagent_stop'
               AND ${ts('started_at')} >= (SELECT MIN(${ts('started_at')}) FROM agent_runs WHERE effort IS NOT NULL)`,
    scope_label: 'SubagentStop-metered swe/pr-reviewer rows since the first run carrying an effort',
    floor: 0.05,
    min_schema: 37,
  },
];

function populatedContract(c: PopulatedColumn): SqlContract {
  const where = [
    `${ts(c.created_column)} >= ${daysAgo(30)}`,
    ...(c.writer_since ? [`${ts(c.created_column)} >= ${c.writer_since.sql}`] : []),
    ...(c.table === 'agent_runs' ? [NOT_PER_TASK_BRO_ROW] : []),
    ...(c.scope ? [c.scope] : []),
  ].join(' AND ');
  const since = c.writer_since ? ` and not before ${c.writer_since.label}` : '';
  const excluded = c.table === 'agent_runs' ? ', per-task bro rows excluded' : '';
  const minSchema = Math.max(c.min_schema, c.writer_since?.min_schema ?? 0);
  return {
    id: `populated_${c.table}_${c.column}`,
    severity: 'warn',
    description: `${c.table}.${c.column} NULL rate over ${c.scope_label ?? 'rows'} created in the last 30 days${since}${excluded} stays at or under ${c.floor}`,
    sql: `SELECT COALESCE(AVG(CASE WHEN ${c.column} IS NULL THEN 1.0 ELSE 0.0 END), 0) FROM ${c.table} WHERE ${where}`,
    expect: { op: '<=', value: c.floor },
    sample_sql: `SELECT id FROM ${c.table} WHERE ${where} AND ${c.column} IS NULL ORDER BY id DESC LIMIT 5`,
    ...(minSchema > 0 ? { min_schema: minSchema } : {}),
  };
}

function eventTypeList(types: readonly string[]): string {
  for (const t of types) {
    if (!/^[a-z][a-z0-9_]*$/.test(t)) throw new Error(`data-contracts: invalid documented event type '${t}'`);
  }
  return types.map((t) => `'${t}'`).join(',');
}

export function buildDataContracts(documentedEventTypes: readonly string[]): readonly Contract[] {
  const events = eventTypeList(documentedEventTypes);
  return [
    {
      id: 'fk_check_empty',
      severity: 'error',
      description: 'PRAGMA foreign_key_check reports no dangling foreign key',
      sql: 'SELECT COUNT(*) FROM pragma_foreign_key_check',
      expect: { op: '=', value: 0 },
      sample_sql: 'SELECT "table" AS child_table, rowid, parent FROM pragma_foreign_key_check LIMIT 5',
    },
    {
      id: 'event_type_documented',
      severity: 'error',
      min_schema: 38,
      description: 'every audit.event_type is in the documented event set',
      sql: `SELECT COUNT(*) FROM audit WHERE event_type NOT IN (${events})`,
      expect: { op: '=', value: 0 },
      sample_sql: `SELECT event_type, COUNT(*) AS n FROM audit WHERE event_type NOT IN (${events}) GROUP BY event_type ORDER BY n DESC LIMIT 5`,
    },
    {
      id: 'swe_runs_metered',
      severity: 'error',
      min_schema: 30,
      description: 'swe/pr-reviewer agent_runs completed in the last 7 days and not marked unmeasured carry tokens',
      sql: `SELECT COUNT(*) FROM agent_runs
             WHERE agent_type IN ('swe','pr-reviewer') AND completed_at IS NOT NULL AND ${ts('completed_at')} >= ${daysAgo(7)}
               AND (usage_source IS NULL OR usage_source <> 'unmeasured')
               AND COALESCE(tokens_in, 0) = 0 AND COALESCE(tokens_out, 0) = 0
               AND COALESCE(cache_read_tokens, 0) = 0 AND COALESCE(cache_creation_tokens, 0) = 0`,
      expect: { op: '=', value: 0 },
      sample_sql: `SELECT id, task_id, agent_type, usage_source, completed_at FROM agent_runs
             WHERE agent_type IN ('swe','pr-reviewer') AND completed_at IS NOT NULL AND ${ts('completed_at')} >= ${daysAgo(7)}
               AND (usage_source IS NULL OR usage_source <> 'unmeasured')
               AND COALESCE(tokens_in, 0) = 0 AND COALESCE(tokens_out, 0) = 0
               AND COALESCE(cache_read_tokens, 0) = 0 AND COALESCE(cache_creation_tokens, 0) = 0
             ORDER BY id DESC LIMIT 5`,
    },
    {
      id: 'bro_session_runs_metered',
      severity: 'error',
      min_schema: 33,
      description: 'bro session agent_runs (task_id NULL) started in the last 7 days carry session_id, model, tokens_out and usage_source',
      sql: `SELECT COUNT(*) FROM agent_runs
             WHERE ${BRO_SESSION_ROW} AND ${ts('started_at')} >= ${daysAgo(7)}
               AND (session_id IS NULL OR model IS NULL OR COALESCE(tokens_out, 0) = 0 OR usage_source IS NULL)`,
      expect: { op: '=', value: 0 },
      sample_sql: `SELECT id, session_id, model, tokens_out, usage_source, started_at FROM agent_runs
             WHERE ${BRO_SESSION_ROW} AND ${ts('started_at')} >= ${daysAgo(7)}
               AND (session_id IS NULL OR model IS NULL OR COALESCE(tokens_out, 0) = 0 OR usage_source IS NULL)
             ORDER BY id DESC LIMIT 5`,
    },
    {
      id: 'closed_tasks_reviewed',
      severity: 'error',
      description: 'tasks closed in the last 30 days and more than TMB_REVIEW_GRACE_HOURS (default 24) ago have a passing pr-reviewer verdict, a bro-written review_gate_waived row, or a review_gate_bypassed row from bro or hook:close-issue-on-merge (bro_atomic_close closes before pr-reviewer runs; tasks has no closed_at, so the close time is updated_at)',
      sql: `SELECT COUNT(*) FROM tasks t
             WHERE t.status = 'closed' AND ${ts('t.updated_at')} >= ${daysAgo(30)}
               AND ${ts('t.updated_at')} < strftime('%Y-%m-%dT%H:%M:%fZ','now', '-' || :grace_hours || ' hours')
               AND NOT EXISTS (SELECT 1 FROM validation_attempts v WHERE v.task_id = t.id AND v.verdict = 'pass')
               AND NOT EXISTS (SELECT 1 FROM audit a WHERE ${reviewSkipAuthoredSql('a')}
                                AND ${auditTaskId('a')} = t.id)`,
      expect: { op: '=', value: 0 },
      sample_sql: `SELECT t.id, t.issue_id, t.branch_id, t.updated_at FROM tasks t
             WHERE t.status = 'closed' AND ${ts('t.updated_at')} >= ${daysAgo(30)}
               AND ${ts('t.updated_at')} < strftime('%Y-%m-%dT%H:%M:%fZ','now', '-' || :grace_hours || ' hours')
               AND NOT EXISTS (SELECT 1 FROM validation_attempts v WHERE v.task_id = t.id AND v.verdict = 'pass')
               AND NOT EXISTS (SELECT 1 FROM audit a WHERE ${reviewSkipAuthoredSql('a')}
                                AND ${auditTaskId('a')} = t.id)
             ORDER BY t.id DESC LIMIT 5`,
      params: [{ name: 'grace_hours', env: 'TMB_REVIEW_GRACE_HOURS', default: REVIEW_GRACE_HOURS_DEFAULT }],
    },
    {
      id: 'no_stale_running',
      severity: 'warn',
      description: 'no running task has gone TMB_STALE_RUNNING_HOURS (default 6) without an update and without an open swe agent_runs row',
      sql: `SELECT COUNT(*) FROM tasks t
             WHERE t.status = 'running' AND ${ts('t.updated_at')} < strftime('%Y-%m-%dT%H:%M:%fZ','now', '-' || :stale_hours || ' hours')
               AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.task_id = t.id AND r.agent_type = 'swe' AND r.completed_at IS NULL)`,
      expect: { op: '=', value: 0 },
      sample_sql: `SELECT t.id, t.issue_id, t.updated_at FROM tasks t
             WHERE t.status = 'running' AND ${ts('t.updated_at')} < strftime('%Y-%m-%dT%H:%M:%fZ','now', '-' || :stale_hours || ' hours')
               AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.task_id = t.id AND r.agent_type = 'swe' AND r.completed_at IS NULL)
             ORDER BY t.id LIMIT 5`,
      params: [{ name: 'stale_hours', env: 'TMB_STALE_RUNNING_HOURS', default: STALE_RUNNING_HOURS_DEFAULT }],
    },
    {
      id: 'scan_fresh',
      severity: 'warn',
      description: 'some repo was scanned in the last 7 days (1 when fresh; passes with no repo row)',
      sql: `SELECT CASE WHEN COUNT(*) = 0 THEN 1 WHEN MAX(${ts('last_scanned_at')}) >= ${daysAgo(7)} THEN 1 ELSE 0 END FROM repos`,
      expect: { op: '>=', value: 1 },
      sample_sql: `SELECT name, last_scanned_at FROM repos ORDER BY last_scanned_at DESC LIMIT 5`,
    },
    {
      id: 'waiver_not_duplicated',
      severity: 'warn',
      description: 'no (task_id, commit_sha) carries more than one verification_gate_waived row',
      sql: `SELECT COUNT(*) FROM (SELECT 1 FROM audit a WHERE a.event_type = 'verification_gate_waived'
             GROUP BY ${auditTaskId('a')}, COALESCE(${auditCommitSha('a')}, '') HAVING COUNT(*) > 1)`,
      expect: { op: '=', value: 0 },
      sample_sql: `SELECT ${auditTaskId('a')} AS task_id, ${auditCommitSha('a')} AS commit_sha, COUNT(*) AS n FROM audit a
             WHERE a.event_type = 'verification_gate_waived'
             GROUP BY ${auditTaskId('a')}, COALESCE(${auditCommitSha('a')}, '') HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 5`,
    },
    {
      id: 'spec_shape_waived_rows_name_a_task',
      severity: 'warn',
      description: 'every spec_shape_gate_waived row names an existing task with gate spec_shape: content_json.task_id is a positive integer (or its decimal string) matching a tasks row and content_json.gate is spec_shape, the only shape require-task-spec reads as a spawn waiver',
      sql: `SELECT COUNT(*) FROM audit a
             WHERE ${SPEC_SHAPE_WAIVER_NOT_READ_BY_GATE('a')}`,
      expect: { op: '=', value: 0 },
      sample_sql: `SELECT a.id, a.issue_id, a.from_node, a.created_at, a.content_json FROM audit a
             WHERE ${SPEC_SHAPE_WAIVER_NOT_READ_BY_GATE('a')}
             ORDER BY a.id DESC LIMIT 5`,
    },
    {
      id: 'no_unconsumed_reviewer_observations',
      severity: 'warn',
      description: 'no reviewer_identity_observed row older than 1 hour is still unconsumed and unsuperseded (a pr-reviewer validation_record call that never recorded a verdict)',
      sql: `SELECT COUNT(*) FROM audit o
             WHERE ${UNCONSUMED_STALE_OBSERVATION('o')}`,
      expect: { op: '=', value: 0 },
      sample_sql: `SELECT o.id, o.issue_id, o.created_at, o.content_json FROM audit o
             WHERE ${UNCONSUMED_STALE_OBSERVATION('o')}
             ORDER BY o.id DESC LIMIT 5`,
    },
    {
      id: 'embeddings_not_degraded',
      severity: 'warn',
      min_schema: 33,
      description: 'no embeddings_degraded audit row from the last 24 hours lacks a later embeddings_recovered row (semantic search is falling back to FTS)',
      sql: `SELECT COUNT(*) FROM audit d
             WHERE d.event_type = 'embeddings_degraded' AND ${ts('d.created_at')} >= ${daysAgo(1)}
               AND NOT EXISTS (SELECT 1 FROM audit r WHERE r.event_type = 'embeddings_recovered' AND r.id > d.id)`,
      expect: { op: '=', value: 0 },
      sample_sql: `SELECT d.id, d.created_at, d.content_json FROM audit d
             WHERE d.event_type = 'embeddings_degraded' AND ${ts('d.created_at')} >= ${daysAgo(1)}
               AND NOT EXISTS (SELECT 1 FROM audit r WHERE r.event_type = 'embeddings_recovered' AND r.id > d.id)
             ORDER BY d.id DESC LIMIT 5`,
    },
    {
      id: 'verification_recorded_for_closed_tasks',
      severity: 'warn',
      min_schema: 36,
      description: 'tasks closed in the last 7 days, and not before the first recorded verification run, with a commit_sha, a non-empty verification[] and no verification_gate_waived row have a verification_runs row for that commit (the close gate records one per run); skipped while no run is recorded',
      skip_when: { sql: 'SELECT COUNT(*) = 0 FROM verification_runs', reason: 'no_verification_runs_recorded' },
      sql: `SELECT COUNT(*) FROM tasks t
             WHERE ${VERIFIED_CLOSE_SCOPE}
               AND NOT EXISTS (SELECT 1 FROM verification_runs r WHERE ${runMatchesTaskCommit('r', 't')})`,
      expect: { op: '=', value: 0 },
      sample_sql: `SELECT t.id, t.issue_id, t.commit_sha, t.updated_at FROM tasks t
             WHERE ${VERIFIED_CLOSE_SCOPE}
               AND NOT EXISTS (SELECT 1 FROM verification_runs r WHERE ${runMatchesTaskCommit('r', 't')})
             ORDER BY t.id DESC LIMIT 5`,
    },
    {
      id: 'no_unfinished_verification_runs',
      severity: 'warn',
      min_schema: 36,
      description: 'no verification_runs row started more than 2 hours ago is still unfinished (finished_at NULL: the gate was killed, or its finish write failed after its retries)',
      sql: `SELECT COUNT(*) FROM verification_runs
             WHERE finished_at IS NULL AND ${ts('started_at')} < ${hoursAgo(2)}`,
      expect: { op: '=', value: 0 },
      sample_sql: `SELECT id, task_id, commit_sha, source, started_at FROM verification_runs
             WHERE finished_at IS NULL AND ${ts('started_at')} < ${hoursAgo(2)}
             ORDER BY id DESC LIMIT 5`,
    },
    {
      id: 'review_findings_resolved_at_matches_status',
      severity: 'warn',
      min_schema: 47,
      description: 'every fixed review_findings row has resolved_at and no open one does (the verification gate sets both when an open finding\'s probe passes)',
      sql: `SELECT COUNT(*) FROM review_findings
             WHERE (status = 'fixed' AND resolved_at IS NULL) OR (status = 'open' AND resolved_at IS NOT NULL)`,
      expect: { op: '=', value: 0 },
      sample_sql: `SELECT id, task_id, attempt_n, status, resolved_at FROM review_findings
             WHERE (status = 'fixed' AND resolved_at IS NULL) OR (status = 'open' AND resolved_at IS NOT NULL)
             ORDER BY created_at DESC LIMIT 5`,
    },
    {
      id: 'no_fixture_rows_in_inventory',
      severity: 'warn',
      description: 'no plugin or MCP-server cheatcodes row carries a scan test-fixture name (alpha, beta, alpha-server, fixture-*, test-plugin*, or a <name>@tmb-test-market ref): such a row means a test\'s scan.sh run reached this DB; report only — agents never delete these rows, the Human decides',
      sql: `SELECT COUNT(*) FROM cheatcodes c
             WHERE ${FIXTURE_INVENTORY_ROW('c')}`,
      expect: { op: '=', value: 0 },
      sample_sql: `SELECT c.id, c.name, c.kind, c.source_url, c.created_at FROM cheatcodes c
             WHERE ${FIXTURE_INVENTORY_ROW('c')}
             ORDER BY c.id DESC LIMIT 5`,
    },
    ...POPULATED_COLUMNS.map(populatedContract),
    {
      id: 'issues_closed_no_live_tasks',
      severity: 'error',
      description: 'no closed issue still has a pending/running/needs_validation/completed task',
      sql: `SELECT COUNT(DISTINCT i.id) FROM issues i JOIN tasks t ON t.issue_id = i.id
             WHERE i.status = 'closed' AND t.status IN (${LIVE_TASK_STATUSES})`,
      expect: { op: '=', value: 0 },
      sample_sql: `SELECT i.id AS issue_id, t.id AS task_id, t.status FROM issues i JOIN tasks t ON t.issue_id = i.id
             WHERE i.status = 'closed' AND t.status IN (${LIVE_TASK_STATUSES}) ORDER BY i.id DESC, t.id LIMIT 5`,
    },
    {
      id: 'concepts_trusted',
      severity: 'warn',
      min_schema: CONCEPTS_SCHEMA,
      description: 'no L2 concept is suspect or broken (a scan found an anchored step changed or gone, or a claim failing): re-verify it with world_model_concept_upsert or retire it',
      sql: `SELECT COUNT(*) FROM wm_concepts WHERE status IN ('suspect','broken')`,
      expect: { op: '=', value: 0 },
      sample_sql: `SELECT id, repo, name, status, status_reason FROM wm_concepts WHERE status IN ('suspect','broken') ORDER BY id DESC LIMIT 5`,
    },
    {
      id: 'concept_proposals_not_stale',
      severity: 'warn',
      min_schema: COMPLETION_REPORT_SCHEMA,
      description: `no concept a closed, reviewed task proposed in its completion report (report.concepts) is still pending — no concept_proposal_applied or concept_proposal_rejected row for its task and name — ${PENDING_PROPOSAL_DAYS} days after the close (tasks has no closed_at, so the close time is updated_at): scan_run applies a proposal once its anchors are in the scanned checkout's index`,
      sql: `SELECT COUNT(*) FROM ${PENDING_PROPOSALS}`,
      expect: { op: '=', value: 0 },
      sample_sql: `SELECT t.id AS task_id, json_extract(c.value, '$.name') AS name, t.updated_at FROM ${PENDING_PROPOSALS} ORDER BY t.id DESC LIMIT 5`,
    },
    {
      id: 'concept_proposals_not_rejected',
      severity: 'warn',
      description: 'no concept_proposal_rejected row from the last 30 days (a reviewed task\'s concept proposal still failed to upsert 14 days after its close; content_json.error names why)',
      sql: `SELECT COUNT(*) FROM audit a WHERE a.event_type = 'concept_proposal_rejected' AND ${ts('a.created_at')} >= ${daysAgo(30)}`,
      expect: { op: '=', value: 0 },
      sample_sql: `SELECT a.id, a.issue_id, a.created_at, a.content_json FROM audit a
             WHERE a.event_type = 'concept_proposal_rejected' AND ${ts('a.created_at')} >= ${daysAgo(30)}
             ORDER BY a.id DESC LIMIT 5`,
    },
    {
      id: 'concepts_cover_indexed_repos',
      severity: 'warn',
      min_schema: CONCEPTS_SCHEMA,
      description: `no repo with ${CONCEPTS_MIN_SYMBOLS} or more wm_symbols rows has no live (non-retired) wm_concepts row: the L1 index is there but nobody has written its L2 concepts`,
      sql: `SELECT COUNT(*) FROM ${UNCONCEPTUALIZED_REPOS}`,
      expect: { op: '=', value: 0 },
      sample_sql: `SELECT s.repo, s.symbols FROM ${UNCONCEPTUALIZED_REPOS} ORDER BY s.symbols DESC LIMIT 5`,
    },
    {
      source: 'files',
      id: 'single_tmb_plugin_enabled',
      severity: 'error',
      description: 'at most one enabled copy of this plugin applies to CLAUDE_PROJECT_DIR (installed_plugins.json + enabledPlugins in the project settings.local.json / settings.json and the user settings.json, read-only); Claude Code registers the hooks of only one copy per manifest name, so a second copy silently drops TMB\'s gates — from the project root, run `claude plugin disable <plugin>@<marketplace> --scope <scope>` for the extra copy, then fully quit and relaunch Claude Code. Skipped when CLAUDE_PROJECT_DIR is unset or installed_plugins.json is unreadable', // cli-config-scope: printed
      expect: { op: '<=', value: 1 },
      check: singleTmbPluginEnabled,
    },
    {
      source: 'files',
      id: 'no_other_trajectory_dbs',
      severity: 'warn',
      description: `no other live trajectory DB sits on the walk from CLAUDE_PROJECT_DIR up to the project root, or below the project root within ${STRAY_DB_MAX_DEPTH} levels; a nested DB splits the project's issues and tasks — each sample names the DB path with its issue and task counts, and /onboard offers to remove an empty one. A DB marked standalone is its own project and is not counted. Skipped when the checked DB is not a <project>/.claude/<plugin>/trajectory.db file`,
      expect: { op: '=', value: 0 },
      check: noOtherTrajectoryDbs,
    },
  ];
}

export const DATA_CONTRACTS: readonly Contract[] = buildDataContracts(AUDIT_EVENT_TYPES.map((e) => e.type));

/** The schema version every contract can run against: the highest min_schema. */
export const DATA_CONTRACTS_SCHEMA_VERSION: number = Math.max(0, ...DATA_CONTRACTS.map((c) => c.min_schema ?? 0));

export function schemaTooOldReason(stored: number, required: number): string {
  return `schema v${stored} < v${required} — start the trajectory server to migrate`;
}

export function contractHolds(actual: number | null, expect: ContractExpect): boolean {
  if (actual === null || !Number.isFinite(actual)) return false;
  switch (expect.op) {
    case '=':
      return actual === expect.value;
    case '<=':
      return actual <= expect.value;
    case '>=':
      return actual >= expect.value;
  }
}

/** The named parameter values for a contract, each from its env var when that is a positive number. */
export function contractParamValues(
  contract: Contract,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, number> {
  const values: Record<string, number> = {};
  for (const p of contract.params ?? []) {
    const raw = Number(env[p.env]);
    values[p.name] = Number.isFinite(raw) && raw > 0 ? raw : p.default;
  }
  return values;
}

/** The hook-side copy of the DB contracts: `scripts/hooks/lib/data-contracts.json`. */
export function dataContractsJson(all: readonly Contract[] = DATA_CONTRACTS): string {
  const contracts = all.filter(isSqlContract);
  const schema_version = Math.max(0, ...contracts.map((c) => c.min_schema ?? 0));
  return `${JSON.stringify({ generated_from: 'mcp/trajectory-server/src/data-contracts.ts', schema_version, contracts }, null, 2)}\n`;
}
