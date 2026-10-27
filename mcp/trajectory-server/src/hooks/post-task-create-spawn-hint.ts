/**
 * PostToolUse hook on task_create_batch (GH 1692), the port of
 * scripts/hooks/post-task-create-spawn-hint.sh: after bro creates tasks it
 * adds additionalContext naming each created task with its worktree — read
 * from the trajectory DB (taskLocation), never derived from the cwd — and
 * reminding bro to spawn every task's swe in one turn. A hint, never a block:
 * an error response, a response that is not a task array, or an empty one
 * prints nothing. Bypass: TMB_DISABLE_SPAWN_HINT=1.
 *
 * Unlike the .sh, it needs neither jq nor the sqlite3 CLI: without jq it still
 * hints where the .sh printed nothing, and without the sqlite3 CLI it still
 * places each worktree where the .sh reported the DB read failed
 * (decision 703).
 */
import { ALLOW, type GateResult, type SyncGate } from './gate.js';
import { taskLocation } from './lib/agent-context.js';
import { dbPath } from './lib/db.js';
import { jqCompact, jqLiteralNumbers, jqMap, jsonValues } from './lib/jq.js';
import { commandSubstitution, jqRawText } from './lib/project-env.js';

export const GATE_NAME = 'post-task-create-spawn-hint';
export const BYPASS_ENV = 'TMB_DISABLE_SPAWN_HINT';

const CREATE_BATCH_TOOL = /^mcp__[\s\S]*trajectory-server__task_create_batch$/;

class IndexError extends Error {}

const isRawJson = (value: unknown): boolean =>
  (JSON as unknown as { isRawJSON?: (v: unknown) => boolean }).isRawJSON?.(value) ?? false;

/** jq's `.<key>` and `.[<n>]`: null on null, an error on a value of the wrong type. */
function at(value: unknown, key: string | number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || isRawJson(value)) throw new IndexError();
  if (typeof key === 'number') {
    if (!Array.isArray(value)) throw new IndexError();
    return value[key] ?? null;
  }
  if (Array.isArray(value)) throw new IndexError();
  const v = (value as Record<string, unknown>)[key];
  return v === undefined ? null : v;
}

function truthy(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false;
}

/** `$(echo "$x" | jq -r '<path> // <fallback>')`: one line per value, none for a value the path errors on. */
function rawOr(text: string, path: readonly (string | number)[], fallback: string): string {
  const lines = jqMap(text, (value) => {
    let v: unknown = value;
    try {
      for (const key of path) v = at(v, key);
    } catch {
      return null;
    }
    return truthy(v) ? jqRawText(v) : fallback;
  }).filter((line): line is string => line !== null);
  return commandSubstitution(lines.join('\n'));
}

/** jq's string interpolation `\(x)`: a string as is, anything else as its compact JSON. */
function interpolate(value: unknown): string {
  return typeof value === 'string' ? value : jqCompact(value);
}

function taskLine(task: unknown): [string, string] {
  return [interpolate(at(task, 'id')), interpolate(at(task, 'branch_id'))];
}

/**
 * `jq -r 'if type == "array" then map("  - task_id=\(.id) branch_id=\(.branch_id)") | join("\n") else "" end'`
 * as a `$(...)` capture.
 */
export function taskList(responseText: string): string {
  const out: string[] = [];
  for (const value of jsonValues(`${responseText}\n`, jqLiteralNumbers)) {
    if (!Array.isArray(value)) {
      out.push('');
      continue;
    }
    try {
      out.push(value.map((t) => taskLine(t)).map(([id, branch]) => `  - task_id=${id} branch_id=${branch}`).join('\n'));
    } catch (e) {
      if (!(e instanceof IndexError)) throw e;
    }
  }
  return commandSubstitution(out.join('\n'));
}

/** The lines of `jq -r '.[] | "\(.id)\t\(.branch_id)"'`: a value's lines up to the element that errors. */
export function taskRows(responseText: string): string[] {
  const out: string[] = [];
  for (const value of jsonValues(`${responseText}\n`, jqLiteralNumbers)) {
    if (value === null || typeof value !== 'object' || isRawJson(value)) continue;
    const items = Array.isArray(value) ? value : Object.values(value);
    try {
      for (const item of items) out.push(taskLine(item).join('\t'));
    } catch (e) {
      if (!(e instanceof IndexError)) throw e;
    }
  }
  const text = out.map((row) => `${row}\n`).join('');
  const lines = text.split('\n');
  lines.pop();
  return lines;
}

/** `IFS=$'\t' read -r id branch`: tab is IFS whitespace, so runs collapse and both ends are trimmed. */
export function readTabFields(line: string): [string, string] {
  const trimmed = line.replace(/^\t+/, '');
  const at = trimmed.indexOf('\t');
  if (at < 0) return [trimmed, ''];
  return [trimmed.slice(0, at), trimmed.slice(at).replace(/^\t+/, '').replace(/\t+$/, '')];
}

function worktreeOf(db: string | null, id: string, env: NodeJS.ProcessEnv): string {
  if (db === null) return 'unresolved (no trajectory DB)';
  const loc = taskLocation(db, id, env);
  return loc.code === 0 ? loc.worktree : `unresolved (${loc.missing})`;
}

export function hintReason(toolName: string, tasks: string): string {
  const tool = toolName.slice(toolName.lastIndexOf('__') + 2);
  return `🚀 SWE-spawn hint: ${tool} created the following tasks. Per tmb_planning Step 4, the next step is to spawn every created task's SWE in one turn — one Agent call each, all in the same message, so independent tasks run concurrently. Production sessions where this step was skipped left tasks stuck at status='pending' forever.

Tasks created:
${tasks}

For each task, run the two-step proven flow:
1. Pre-create the worktree: \`printf '{"branch":"<branch_id>"}' | bash \${CLAUDE_PLUGIN_ROOT}/scripts/hooks/worktree-create.sh\` — capture the printed path.
2. Spawn SWE (all tasks' Agent calls together in one message): \`Agent(subagent_type='swe', prompt='task_id=<N> worktree=<absolute-worktree-path>')\` — no isolation= parameter.

If you intentionally want to halt before SWE (e.g. user requested review), surface that reason explicitly so future sessions don't see this as a stuck-task bug.`;
}

export const postTaskCreateSpawnHint: SyncGate = (payload, env): GateResult => {
  try {
    if (env[BYPASS_ENV] === '1') return ALLOW;
    const input = `${commandSubstitution(payload)}\n`;
    const toolName = rawOr(input, ['tool_name'], '');
    if (!CREATE_BATCH_TOOL.test(toolName)) return ALLOW;
    if (rawOr(input, ['tool_response', 'is_error'], 'false') === 'true') return ALLOW;
    const responseText = rawOr(input, ['tool_response', 'content', 0, 'text'], '');
    if (responseText === '') return ALLOW;
    const list = taskList(responseText);
    if (list === '') return ALLOW;

    const db = dbPath(env);
    const withPaths = taskRows(responseText)
      .map(readTabFields)
      .map(([id, branch]) => `  - task_id=${id} branch_id=${branch} worktree=${worktreeOf(db, id, env)}`)
      .join('\n');
    return {
      stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: hintReason(toolName, withPaths || list) } })}\n`,
      code: 0,
    };
  } catch {
    return ALLOW;
  }
};
