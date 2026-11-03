/**
 * PreToolUse gate (GH 1692), the port of scripts/hooks/swe-brief-gate.sh:
 * deny-until-briefed for swe. A swe calling a trajectory-server MCP tool, or
 * Edit, Write, MultiEdit or NotebookEdit, is denied until the task_brief handler has
 * written the task's swe_brief_fetched audit row; every other tool passes. The
 * task comes from the swe's own spawn transcript, else tool_input.task_id,
 * never from the cwd (GH 1550). No task, no resolvable DB or another role
 * allows.
 *
 * On task_brief it binds the run row and allows: with no swe row of the task
 * keyed by the payload's agent_id, the task's newest open swe row whose
 * spawn_id is NULL or tool_use:* is rebound to the agent_id; with every keyed
 * row closed (a swe resumed through SendMessage, GH 1742) a
 * swe_resume_observed audit row names the agent_id. Both writes are fail-open.
 *
 * Unlike the .sh, it needs neither jq nor the sqlite3 CLI, so without them it
 * still denies an unbriefed swe where the .sh let every call through
 * (decision 703). It also denies MultiEdit, which the .sh lets through though
 * hooks.json routes MultiEdit to it (GH 2070).
 */
import { ALLOW, type GateResult, type SyncGate } from './gate.js';
import { agentTranscript } from './lib/agent-context.js';
import { auditAppend, dbWrite, nowIso } from './lib/audit.js';
import { dbPath, haveSqlite, sqlInt, sqliteRo, sqlQuote, taskIdFromTranscript } from './lib/db.js';
import { jqAlternatives, jqCompact, jqIndex, jqLiteralNumbers, jqMap, jqNumberLiteral } from './lib/jq.js';
import { commandSubstitution, jqRawText } from './lib/project-env.js';
import { normalizeRole } from './lib/role.js';

export const GATE_NAME = 'swe-brief-gate';

const BLOCKED_MUTATIONS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TRAJECTORY_TOOL = /^mcp__[\s\S]*trajectory-server__/;

export type BriefSurface = 'task_brief' | 'mutation' | 'trajectory' | 'other';

/** The .sh's `case "$TOOL_NAME"`, first match wins. */
export function briefSurface(toolName: string): BriefSurface {
  if (toolName.includes('task_brief')) return 'task_brief';
  if (BLOCKED_MUTATIONS.has(toolName)) return 'mutation';
  if (TRAJECTORY_TOOL.test(toolName)) return 'trajectory';
  return 'other';
}

/** `jq -r '.<path> // empty'` with each number printed as its literal, the lines joined. */
export function rawOrEmpty(input: string, path: readonly string[]): string {
  return jqMap(
    input,
    (value) => {
      const v = path.reduce<unknown>((acc, key) => jqIndex(acc, key), value);
      return v === null || v === undefined || v === false ? null : jqRawText(v);
    },
    jqLiteralNumbers,
  )
    .filter((line): line is string => line !== null)
    .join('\n');
}

export function denyReason(taskId: string, toolName: string): string {
  return `BLOCKED: SWE must call task_brief(agent='swe', task_id=${taskId}) before ${toolName || 'this tool'}. task_brief delivers the spec, worktree path, and decision thread in one deterministic call. Recovery: task_brief(agent='swe', task_id=${taskId})`;
}

/** The `jq -cn '{task_id:$t, agent_id:$g, observed_at:$o, consumed:0}'` object of a resumed swe. */
export function resumeJson(taskId: string, agentId: string, observedAt: string): string {
  return `{"task_id":${jqNumberLiteral(taskId)},"agent_id":${jqCompact(agentId)},"observed_at":${jqCompact(observedAt)},"consumed":0}`;
}

function bindRun(db: string, taskId: string, input: string, env: NodeJS.ProcessEnv): void {
  const agentId = commandSubstitution(jqAlternatives(input, [['agent_id']]));
  if (agentId === '') return;
  const safeAgentId = sqlQuote(agentId);
  const keyed = sqliteRo(
    db,
    `
SELECT COALESCE(MAX(completed_at IS NULL), -1) || '|' || (SELECT issue_id FROM tasks WHERE id = ${taskId})
  FROM agent_runs
 WHERE task_id = ${taskId} AND agent_type = 'swe' AND spawn_id = '${safeAgentId}';`,
    env,
  );
  if (keyed.startsWith('-1|')) {
    dbWrite(
      db,
      `
UPDATE agent_runs SET spawn_id = '${safeAgentId}'
 WHERE id = (SELECT id FROM agent_runs
              WHERE task_id = ${taskId} AND agent_type = 'swe' AND completed_at IS NULL
                AND (spawn_id IS NULL OR spawn_id GLOB 'tool_use:*')
              ORDER BY id DESC LIMIT 1);`,
      { caller: GATE_NAME, env },
    );
  } else if (keyed.startsWith('0|')) {
    auditAppend(
      db,
      {
        issueId: keyed.slice(keyed.indexOf('|') + 1),
        branchId: '',
        fromNode: `hook:${GATE_NAME}`,
        eventType: 'swe_resume_observed',
        summary: `swe ${agentId} resumed task ${taskId} and called task_brief`,
        contentJson: resumeJson(taskId, agentId, nowIso()),
      },
      { caller: GATE_NAME, env },
    );
  }
}

export const sweBriefGate: SyncGate = (payload, env): GateResult => {
  const captured = commandSubstitution(payload);
  const input = `${captured}\n`;
  const agentType = normalizeRole(
    commandSubstitution(jqAlternatives(input, [['agent_type'], ['subagent_type'], ['tool_input', 'subagent_type']])),
  );
  if (agentType !== 'swe') return ALLOW;
  const toolName = commandSubstitution(jqAlternatives(input, [['tool_name']]));

  const db = dbPath(env, (line) => process.stderr.write(`${line}\n`));
  if (db === null || !haveSqlite(env)) return ALLOW;

  let taskId = taskIdFromTranscript(agentTranscript(captured));
  if (taskId === '') taskId = sqlInt(commandSubstitution(rawOrEmpty(input, ['tool_input', 'task_id'])));
  if (taskId === '') return ALLOW;

  const surface = briefSurface(toolName);
  if (surface === 'other') return ALLOW;
  if (surface === 'task_brief') {
    bindRun(db, taskId, input, env);
    return ALLOW;
  }

  const sentinel = sqliteRo(
    db,
    `
  SELECT COUNT(*) FROM audit
   WHERE event_type = 'swe_brief_fetched'
     AND json_extract(content_json, '$.task_id') = ${taskId}
  LIMIT 1;
`,
    env,
  );
  if (Number(sentinel || '0') > 0) return ALLOW;

  return {
    stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyReason(taskId, toolName) } })}\n`,
    code: 0,
  };
};
