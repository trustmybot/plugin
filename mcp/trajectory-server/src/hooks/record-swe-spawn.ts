/**
 * TypeScript port of scripts/hooks/record-swe-spawn.sh (GH 1692), the second
 * PREPARE step of agent-spawn-dispatch: a swe spawn for task_id=<N> opens
 * its agent_runs row in one transaction that first sweeps the task's open swe
 * rows older than 90 s with a NULL or tool_use spawn_id as swept_orphan, then
 * moves a pending task to running. The row's spawn_id is
 * tool_use:<tool_use_id>, else tool_use:<session_id>:<epoch ms>.
 *
 * Fail-open: it never blocks and prints nothing; a failed write leaves the DB
 * unchanged. GH 2032 (decision 703): a task whose recorded
 * tasks.worktree_path exists gets that path as root_dir, the worktree
 * ensure-swe-worktree left in place, instead of the slug path. Unlike the
 * .sh, it needs neither jq nor the sqlite3 CLI.
 */
import { ALLOW, type GateResult, type SyncGate } from './gate.js';
import { pluginVersion } from './bro-turn-usage.js';
import { cutField, prepareRepoRoot, recordedWorktree, sweSpawnTaskId } from './ensure-swe-worktree.js';
import { dbWrite, nowIso } from './lib/audit.js';
import { branchSlug, dbPath, haveSqlite, sqliteRo, sqlQuote } from './lib/db.js';
import { JqUnindexable, jqAlt, jqGet, jqInput, jqTostring, type JqInput } from './lib/jq-raw.js';
import { commandSubstitution } from './lib/project-env.js';
import { RUN_UNMEASURED_SQL } from './swe-spawn-rollback.js';

export const GATE_NAME = 'record-swe-spawn';

const UNIT_SEPARATOR = '\x1f';
const SPAWN_FIELDS: readonly (readonly string[])[] = [['session_id'], ['tool_use_id'], ['tool_input', 'effort'], ['tool_input', 'model']];

export interface SpawnFields {
  sessionId: string;
  toolUseId: string;
  effort: string;
  model: string;
}

/**
 * `FIELDS=$(jq -r '[.session_id // "", .tool_use_id // "", .tool_input.effort
 * // "", .tool_input.model // ""] | map(tostring) | join("\u001f")') || exit 0`
 * then `IFS=$'\037' read -r SESSION_ID TOOL_USE_ID EFFORT MODEL`: null when jq
 * would exit non-zero (a parse error, or the stream's last value unindexable).
 */
export function spawnFields(input: JqInput): SpawnFields | null {
  if (!input.complete) return null;
  const lines: string[] = [];
  let lastFailed = false;
  for (const value of input.values) {
    try {
      lines.push(SPAWN_FIELDS.map((keys) => jqTostring(jqAlt(jqGet(value, ...keys), ''))).join(UNIT_SEPARATOR));
      lastFailed = false;
    } catch (e) {
      if (!(e instanceof JqUnindexable)) throw e;
      lastFailed = true;
    }
  }
  if (lastFailed) return null;
  const [sessionId, toolUseId, effort, model] = readFields(commandSubstitution(lines.join('\n')).split('\n')[0], 4);
  return { sessionId, toolUseId, effort, model };
}

/** `IFS=$'\037' read -r a b c d <<< line`: <count> fields, the last taking the rest. */
function readFields(line: string, count: number): string[] {
  let rest = line;
  const fields: string[] = [];
  for (let i = 0; i < count - 1; i += 1) {
    const at = rest.indexOf(UNIT_SEPARATOR);
    if (at < 0) {
      fields.push(rest);
      rest = '';
      continue;
    }
    fields.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  if (rest.endsWith(UNIT_SEPARATOR) && !rest.slice(0, -1).includes(UNIT_SEPARATOR)) rest = rest.slice(0, -1);
  fields.push(rest);
  return fields;
}

const quoted = (value: string): string => (value === '' ? 'NULL' : `'${sqlQuote(value)}'`);

export interface SpawnRow {
  taskId: string;
  rootDir: string | null;
  fields: SpawnFields;
  spawnId: string;
  pluginVersion: string;
  now: string;
}

export function spawnSql(row: SpawnRow): string {
  const { taskId, now } = row;
  const rootDirSql = row.rootDir === null ? 'NULL' : `'${sqlQuote(row.rootDir)}'`;
  const effortSql = ['low', 'medium', 'high'].includes(row.fields.effort) ? `'${row.fields.effort}'` : 'effort';
  return `
UPDATE agent_runs
   SET completed_at = '${now}',
       exit_reason = 'swept_orphan',
       ${RUN_UNMEASURED_SQL},
       duration_ms = CASE WHEN duration_ms = 0
                          THEN COALESCE(CAST(ROUND((julianday('${now}') - julianday(started_at)) * 86400000) AS INTEGER), 0)
                          ELSE duration_ms END
 WHERE task_id = ${taskId} AND agent_type = 'swe' AND completed_at IS NULL
   AND (spawn_id IS NULL OR spawn_id GLOB 'tool_use:*')
   AND started_at IS NOT NULL AND started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 seconds');
UPDATE tasks SET status = 'running', updated_at = '${now}', completed_at = NULL
 WHERE id = ${taskId} AND status = 'pending';
INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, repo, root_dir, host,
                        session_id, effort, model, spawn_id, plugin_version)
SELECT id, issue_id, 'swe', '${now}', repo, ${rootDirSql}, 'claude',
       ${quoted(row.fields.sessionId)}, ${effortSql}, ${quoted(row.fields.model)}, '${sqlQuote(row.spawnId)}', ${quoted(row.pluginVersion)}
  FROM tasks WHERE id = ${taskId};`;
}

export const recordSweSpawn: SyncGate = (payload, env): GateResult => {
  try {
    const input = jqInput(commandSubstitution(payload));
    const taskId = sweSpawnTaskId(input);
    if (taskId === '') return ALLOW;
    const db = dbPath(env);
    if (db === null || !haveSqlite(env)) return ALLOW;
    const row = sqliteRo(db, `SELECT branch_id, COALESCE(repo, '') FROM tasks WHERE id = ${taskId};`, env);
    if (row === '') return ALLOW;
    const branch = cutField(row, 1);
    const fields = spawnFields(input);
    if (fields === null) return ALLOW;
    const spawnId = fields.toolUseId !== '' ? `tool_use:${fields.toolUseId}` : `tool_use:${fields.sessionId}:${Date.now()}`;
    let rootDir: string | null = null;
    if (branch !== '') {
      rootDir =
        recordedWorktree(db, taskId, branch, env) ||
        `${prepareRepoRoot(db, cutField(row, 2), env).replace(/\/$/, '')}/.claude/worktrees/${branchSlug(branch)}`;
    }
    const sql = spawnSql({ taskId, rootDir, fields, spawnId, pluginVersion: pluginVersion(env), now: nowIso() });
    dbWrite(db, sql, { caller: GATE_NAME, env });
  } catch {
    /* fail-open */
  }
  return ALLOW;
};
