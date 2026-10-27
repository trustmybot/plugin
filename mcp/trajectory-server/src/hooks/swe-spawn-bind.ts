/**
 * PostToolUse(Agent) hook (GH 1692), the port of scripts/hooks/swe-spawn-bind.sh:
 * once CC accepts a swe spawn, the agent_runs row record-swe-spawn.sh opened
 * with spawn_id tool_use:<tool_use_id> is rebound to spawn_id =
 * tool_response.agentId, so a background spawn is bound before its first
 * task_brief. A row of the task already keyed by that agentId wins and the
 * tool_use row is left for task_brief / SubagentStop.
 *
 * Fail-open: it never blocks, prints nothing, and a failed write leaves the DB
 * unchanged. Unlike the .sh, it needs neither jq nor the sqlite3 CLI, so it
 * binds the row on a machine without them where the .sh skipped it
 * (decision 703).
 */
import { ALLOW, type GateResult, type SyncGate } from './gate.js';
import { dbWrite } from './lib/audit.js';
import { dbPath, haveSqlite, sqlQuote } from './lib/db.js';
import { jqAlternatives, jqCompact, jqIndex, jqLiteralNumbers, jsonStream, jsonValues } from './lib/jq.js';
import { commandSubstitution } from './lib/project-env.js';
import { normalizeRole } from './lib/role.js';

export const GATE_NAME = 'swe-spawn-bind';
const FIELD_SEPARATOR = '\x1f';

class FieldsError extends Error {}

/** jq's `tostring`: a string as is, anything else as its compact JSON. */
export function jqToString(value: unknown): string {
  return typeof value === 'string' ? value : jqCompact(value);
}

/** jq's `<path> // ""`, an indexing error rethrown so the whole run fails as jq's does. */
function orEmpty(value: unknown, path: readonly string[]): unknown {
  let v: unknown = value;
  try {
    for (const key of path) v = jqIndex(v, key);
  } catch {
    throw new FieldsError();
  }
  return v === null || v === undefined || v === false ? '' : v;
}

/**
 * `jq -r '[.<a> // "", .<b> // ""] | map(tostring) | join("\u001f")'` as a
 * `$(...) || exit 0` capture: null when jq would exit non-zero (a value it
 * cannot index, or a parse error ending the stream).
 */
export function joinedFields(input: string, a: readonly string[], b: readonly string[]): string | null {
  if (!jsonStream(input).complete) return null;
  try {
    return jsonValues(input, jqLiteralNumbers)
      .map((value) => `${jqToString(orEmpty(value, a))}${FIELD_SEPARATOR}${jqToString(orEmpty(value, b))}`)
      .join('\n');
  } catch (e) {
    if (e instanceof FieldsError) return null;
    throw e;
  }
}

/** `IFS=<sep> read -r first rest <<< "$text"`: the first line split at the separator. */
export function readTwo(text: string, sep: string): [string, string] {
  const line = text.split('\n')[0];
  const at = line.indexOf(sep);
  if (at < 0) return [line, ''];
  let rest = line.slice(at + 1);
  if (rest.endsWith(sep) && !rest.slice(0, -1).includes(sep)) rest = rest.slice(0, -1);
  return [line.slice(0, at), rest];
}

export function bindSql(toolUseId: string, agentId: string): string {
  const safeSpawnId = sqlQuote(`tool_use:${toolUseId}`);
  const safeAgentId = sqlQuote(agentId);
  return `
UPDATE agent_runs SET spawn_id = '${safeAgentId}'
 WHERE agent_type = 'swe' AND spawn_id = '${safeSpawnId}'
   AND NOT EXISTS (SELECT 1 FROM agent_runs b
                    WHERE b.task_id = agent_runs.task_id AND b.spawn_id = '${safeAgentId}');`;
}

export const sweSpawnBind: SyncGate = (payload, env): GateResult => {
  try {
    const input = commandSubstitution(payload);
    if (normalizeRole(commandSubstitution(jqAlternatives(input, [['tool_input', 'subagent_type']]))) !== 'swe') return ALLOW;
    const fields = joinedFields(input, ['tool_use_id'], ['tool_response', 'agentId']);
    if (fields === null) return ALLOW;
    const [toolUseId, agentId] = readTwo(commandSubstitution(fields), FIELD_SEPARATOR);
    if (toolUseId === '' || agentId === '') return ALLOW;
    const db = dbPath(env);
    if (db === null || !haveSqlite(env)) return ALLOW;
    dbWrite(db, bindSql(toolUseId, agentId), { caller: GATE_NAME, env });
  } catch {
    /* fail-open */
  }
  return ALLOW;
};
