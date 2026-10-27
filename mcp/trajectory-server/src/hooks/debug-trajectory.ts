/**
 * PreToolUse hook (GH 1692), the port of scripts/hooks/debug-trajectory.sh:
 * under TMB_EVAL_MODE=1 and TMB_DEBUG_TRAJECTORY=1 it records each non-MCP
 * tool call as a debug_trajectory row (session, next step_n, tool name, the
 * tool_input JSON capped at 4000 bytes). Never blocks: exit 0. Unlike the
 * .sh, it needs neither jq nor the sqlite3 CLI (decision 703).
 */
import { ALLOW, type GateResult } from './gate.js';
import { dbWrite, nowIso } from './lib/audit.js';
import { dbPathAdvisory, sqlQuote } from './lib/db.js';
import { jqAlternatives, jqCompact, jqIndex, jqLiteralNumbers, jqMap, jqOr } from './lib/jq.js';
import { commandSubstitution } from './lib/project-env.js';

export const GATE_NAME = 'debug-trajectory';
export const ARGS_MAX_BYTES = 4000;

const pad = (n: number): string => String(n).padStart(2, '0');

/** `date +%Y%m%d-%H` in local time. */
export function hourStamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}`;
}

/** `jq -c '.tool_input // {}' | head -c 4000`, as a `$(...)` capture. */
export function argsJson(input: string): string {
  const lines = jqMap(input, (value) => `${jqCompact(jqOr(jqIndex(value, 'tool_input'), {}))}\n`, jqLiteralNumbers).join('');
  return commandSubstitution(Buffer.from(lines, 'utf8').subarray(0, ARGS_MAX_BYTES).toString('utf8')) || '{}';
}

export function debugTrajectorySql(sessionId: string, tool: string, args: string, now: string): string {
  const sid = sqlQuote(sessionId);
  return `INSERT INTO debug_trajectory (session_id, step_n, kind, tool_or_mcp_name, args_json, created_at)
VALUES (
  '${sid}',
  COALESCE((SELECT MAX(step_n) FROM debug_trajectory WHERE session_id='${sid}'), 0) + 1,
  'tool_use',
  '${sqlQuote(tool)}',
  json('${sqlQuote(args)}'),
  '${sqlQuote(now)}'
);`;
}

export function debugTrajectory(payload: string, env: NodeJS.ProcessEnv): GateResult {
  try {
    if ((env.TMB_EVAL_MODE || '0') !== '1' || (env.TMB_DEBUG_TRAJECTORY || '0') !== '1') return ALLOW;
    const writeEnv = { ...env, TMB_DB_WRITE_TIMEOUT_MS: '500', TMB_DB_WRITE_RUN_BUDGET_MS: '1200' };
    const db = dbPathAdvisory(GATE_NAME, writeEnv, (line) => process.stderr.write(`${line}\n`));
    if (db === null) return ALLOW;
    const echoed = `${commandSubstitution(payload)}\n`;
    const tool = commandSubstitution(jqAlternatives(echoed, [['tool_name'], ['tool']]));
    if (tool === '' || tool.startsWith('mcp__')) return ALLOW;
    const sessionId = env.CLAUDE_SESSION_ID || hourStamp(new Date());
    const w = dbWrite(db, debugTrajectorySql(sessionId, tool, argsJson(echoed), nowIso()), { caller: GATE_NAME, env: writeEnv });
    if (!w.ok) process.stderr.write(`${w.error}\n`);
    return { stdout: w.stdout, code: 0 };
  } catch {
    return ALLOW;
  }
}
