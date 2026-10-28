/**
 * PreToolUse(Agent) gate (GH 1738, GH 2148), run by agent-spawn-dispatch.sh:
 * a swe spawn for task_id=<N> is denied once any of three limits trips, each
 * counted since the latest Human waiver (a discussions row with author
 * 'human' on the task, or on its issue with task_id NULL):
 *
 *   - task FAILs: REWORK_FAIL_LIMIT review FAILs on the task since its latest pass,
 *   - task runs: SWE_RUN_LIMIT swe runs of the task, minus budget handbacks,
 *   - issue FAILs: ISSUE_FAIL_LIMIT review FAILs across the issue's tasks.
 *
 * Only the Human lifts a limit, by typing `waive task <N>`; no agent-written
 * row does. The rows are counted, never judged. Only swe spawns naming
 * task_id=<N> are judged; a missing task_id is require-task-spec's. No
 * resolvable DB or no tasks row allows, a DB read failure denies.
 */
import { ALLOW, type GateResult, type SyncGate } from './gate.js';
import { dbPath, denyDbUnavailable, gateRead, GATE_READ_ERROR, haveSqlite, sqlInt } from './lib/db.js';
import { jqAlternatives, jqCompact } from './lib/jq.js';
import { normalizeRole } from './lib/role.js';
import { ISSUE_FAIL_LIMIT, REWORK_FAIL_LIMIT, SWE_RUN_LIMIT, SWE_SPAWN_SQL } from '../task-rework.js';

export const GATE_NAME = 'rework-limit';

export interface ReworkState {
  taskFails: number;
  taskRuns: number;
  issueFails: number;
  waivedAt: string | null;
}

function readState(db: string, taskId: string, env: NodeJS.ProcessEnv): ReworkState | null | typeof GATE_READ_ERROR {
  const out = gateRead(
    db,
    `WITH t AS (SELECT id, issue_id FROM tasks WHERE id = ${taskId}),
          human AS (SELECT MAX(d.created_at) AS at FROM discussions d, t
                     WHERE d.author = 'human' AND (d.task_id = t.id OR (d.task_id IS NULL AND d.issue_id = t.issue_id))),
          since AS (SELECT COALESCE(MAX(v.id), 0) AS pass_id FROM validation_attempts v, t
                     WHERE v.task_id = t.id AND v.verdict = 'pass')
     SELECT json_object(
       'task_fails', (SELECT COUNT(*) FROM validation_attempts v, t, since, human
                       WHERE v.task_id = t.id AND v.verdict = 'fail' AND v.id > since.pass_id
                         AND (human.at IS NULL OR v.created_at > human.at)),
       'task_runs', (SELECT COUNT(*) FROM agent_runs r, t, human
                      WHERE r.task_id = t.id AND ${SWE_SPAWN_SQL} AND COALESCE(r.stop_cause, '') <> 'budget'
                        AND (human.at IS NULL OR r.started_at > human.at)),
       'issue_fails', (SELECT COUNT(*) FROM validation_attempts v JOIN tasks x ON x.id = v.task_id, t, human
                        WHERE x.issue_id = t.issue_id AND v.verdict = 'fail'
                          AND (human.at IS NULL OR v.created_at > human.at)),
       'waived_at', (SELECT at FROM human))
     FROM t;`,
    env,
  );
  if (out === GATE_READ_ERROR) return GATE_READ_ERROR;
  if (out === '') return null;
  const row = JSON.parse(out.split('\n')[0]) as { task_fails: number; task_runs: number; issue_fails: number; waived_at: string | null };
  return { taskFails: row.task_fails, taskRuns: row.task_runs, issueFails: row.issue_fails, waivedAt: row.waived_at };
}

function trippedLimits(state: ReworkState): string[] {
  const tripped: string[] = [];
  if (state.taskFails >= REWORK_FAIL_LIMIT) {
    tripped.push(`task FAILs: ${state.taskFails} review FAILs on the task since its last pass (limit ${REWORK_FAIL_LIMIT})`);
  }
  if (state.taskRuns >= SWE_RUN_LIMIT) {
    tripped.push(`task runs: ${state.taskRuns} swe runs of the task, budget handbacks aside (limit ${SWE_RUN_LIMIT})`);
  }
  if (state.issueFails >= ISSUE_FAIL_LIMIT) {
    tripped.push(`issue FAILs: ${state.issueFails} review FAILs across the issue's tasks (limit ${ISSUE_FAIL_LIMIT})`);
  }
  return tripped;
}

export function denyReason(taskId: string, state: ReworkState, tripped: string[] = trippedLimits(state)): string {
  const since = state.waivedAt === null ? '' : ` since the Human's last waiver at ${state.waivedAt}`;
  return (
    `BLOCKED: task ${taskId} is at the rework limit${since}: ${tripped.join('; ')}. ` +
    'A further swe run would repeat an approach that keeps failing. Stop and report the task to the Human with its findings; ' +
    `only the Human lifts this limit, by typing \`waive task ${taskId}\`. No agent action lifts it.`
  );
}

export function denyPreToolUse(reason: string): GateResult {
  return {
    stdout: `${jqCompact({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    })}\n`,
    code: 0,
  };
}

export function denyUnreadable(gate: string, env: NodeJS.ProcessEnv): GateResult {
  return { stdout: `${denyDbUnavailable(gate, env)}\n`, code: 0 };
}

// The rework-limit verdict on one more swe run of `taskId` (a spawn, or a
// resume through SendMessage, GH 1742): denied when a limit has tripped since
// the latest Human waiver, denied on a DB read failure, else allowed.
export function reworkLimitVerdict(gate: string, db: string, taskId: string, env: NodeJS.ProcessEnv): GateResult {
  const state = readState(db, taskId, env);
  if (state === GATE_READ_ERROR) return denyUnreadable(gate, env);
  if (state === null) return ALLOW;
  const tripped = trippedLimits(state);
  if (tripped.length === 0) return ALLOW;
  return denyPreToolUse(denyReason(taskId, state, tripped));
}

export const reworkLimit: SyncGate = (payload, env) => {
  if (jqAlternatives(payload, [['tool_name']]) !== 'Agent') return ALLOW;
  if (normalizeRole(jqAlternatives(payload, [['tool_input', 'subagent_type']])) !== 'swe') return ALLOW;
  const m = /task_id\s*=\s*([0-9]+)/.exec(jqAlternatives(payload, [['tool_input', 'prompt']]));
  const taskId = sqlInt(m?.[1] ?? '');
  if (taskId === '') return ALLOW;
  const db = dbPath(env);
  if (db === null) return ALLOW;
  if (!haveSqlite(env)) return denyUnreadable(GATE_NAME, env);
  return reworkLimitVerdict(GATE_NAME, db, taskId, env);
};
