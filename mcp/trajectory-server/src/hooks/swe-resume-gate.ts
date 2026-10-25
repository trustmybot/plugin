/**
 * PreToolUse(SendMessage) gate (GH 1742): a message to a swe resumes it on its
 * task, so it is judged like a fresh swe spawn of that task.
 *
 * The target is a swe when an agent_runs row of agent_type swe has spawn_id =
 * tool_input.to; its task is that row's task_id (the latest such row). Denied:
 *
 *   - the task is at the rework limit (rework-limit's verdict and reason), or
 *   - the swe's latest run has an effort other than the task's current one: a
 *     resumed swe keeps the effort it was spawned at, so a fresh spawn at the
 *     task's effort is the way on.
 *
 * Any other target, a swe of a closed task, or no resolvable DB allows with no
 * output; a DB read failure denies.
 */
import { ALLOW, type SyncGate } from './gate.js';
import { dbPath, gateRead, GATE_READ_ERROR, haveSqlite, sqlQuote } from './lib/db.js';
import { jqAlternatives } from './lib/jq.js';
import { denyPreToolUse, denyUnreadable, reworkLimitVerdict } from './rework-limit.js';

export const GATE_NAME = 'swe-resume-gate';

interface SweTarget {
  task_id: number;
  status: string;
  run_effort: string | null;
  task_effort: string | null;
}

export function effortMismatchReason(agentId: string, target: SweTarget): string {
  return (
    `BLOCKED: swe ${agentId} ran task ${target.task_id} at effort ${target.run_effort}; the task's effort is now ${target.task_effort}. ` +
    'A resumed swe keeps the effort it was spawned at, so resuming it would ignore the change. ' +
    `Spawn a fresh swe at the task's effort instead: Agent(subagent_type='swe', effort='${target.task_effort}', prompt starting 'task_id=${target.task_id}').`
  );
}

export const sweResumeGate: SyncGate = (payload, env) => {
  if (jqAlternatives(payload, [['tool_name']]) !== 'SendMessage') return ALLOW;
  const to = jqAlternatives(payload, [['tool_input', 'to']]);
  if (to === '') return ALLOW;
  const db = dbPath(env);
  if (db === null) return ALLOW;
  if (!haveSqlite(env)) return denyUnreadable(GATE_NAME, env);
  const out = gateRead(
    db,
    `SELECT json_object('task_id', r.task_id, 'status', t.status, 'run_effort', r.effort, 'task_effort', t.effort)
       FROM agent_runs r JOIN tasks t ON t.id = r.task_id
      WHERE r.agent_type = 'swe' AND r.spawn_id = '${sqlQuote(to)}'
      ORDER BY r.id DESC LIMIT 1;`,
    env,
  );
  if (out === GATE_READ_ERROR) return denyUnreadable(GATE_NAME, env);
  if (out === '') return ALLOW;
  const target = JSON.parse(out.split('\n')[0]) as SweTarget;
  if (target.status === 'closed') return ALLOW;
  const verdict = reworkLimitVerdict(GATE_NAME, db, String(target.task_id), env);
  if (verdict !== ALLOW) return verdict;
  if (target.run_effort !== null && target.task_effort !== null && target.run_effort !== target.task_effort) {
    return denyPreToolUse(effortMismatchReason(to, target));
  }
  return ALLOW;
};
