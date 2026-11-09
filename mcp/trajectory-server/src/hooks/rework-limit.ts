/**
 * PreToolUse(Agent) gate (GH 1738, GH 2148, GH 2830), run by
 * agent-spawn-dispatch: a swe spawn for task_id=<N> is judged against an
 * inner limit and an outer ceiling, each counted since the latest Human
 * waiver (a discussions row with author 'human' and kind 'decision' on the
 * task, or on its issue with task_id NULL; a pr_monitor comment by a login
 * named 'human' is a 'note' and never counts).
 *
 * Inner limit, cleared by bro: REWORK_FAIL_LIMIT review FAILs on the task
 * since its latest pass. A spawn is admitted only when the task's latest
 * `task_rework_analysis` audit row is newer than its latest FAIL, its change
 * is spec_update or effort_raise, and a `task_spec_amended` or
 * `task_effort_raised` row for the task (that change's proof) is newer than
 * the latest FAIL too. A split, retry or re_review never admits a swe run of
 * this task: those start a new task or are no swe run. Each further FAIL needs
 * a fresh analysis.
 *
 * Outer ceiling, lifted only by the Human typing `waive task <N>`:
 *
 *   - task runs: SWE_RUN_LIMIT swe runs of the task, minus budget handbacks,
 *   - issue FAILs: ISSUE_FAIL_LIMIT review FAILs across the issue's tasks, each
 *     with no later pass on the same task,
 *   - repeated root cause: two `task_rework_analysis` rows of the task naming
 *     the same root_cause.
 *
 * No analysis or other agent-written row lifts the ceiling. Rows are compared
 * by created_at, strictly newer; analyses order among themselves by
 * created_at, then id. Only swe spawns naming task_id=<N> are judged; a missing
 * task_id is require-task-spec's. No resolvable DB or no tasks row allows, a
 * DB read failure denies.
 */
import { ALLOW, type GateResult, type SyncGate } from './gate.js';
import { dbPath, denyDbUnavailable, gateRead, GATE_READ_ERROR, haveSqlite, sqlInt } from './lib/db.js';
import { type DenyFix, denyResult } from './lib/deny.js';
import { jqAlternatives } from './lib/jq.js';
import { normalizeRole } from './lib/role.js';
import {
  ISSUE_FAIL_LIMIT,
  REWORK_FAIL_LIMIT,
  REWORK_PROOF_EVENTS,
  SWE_RUN_LIMIT,
  SWE_SPAWN_SQL,
  type ReworkChange,
} from '../task-rework.js';

export const GATE_NAME = 'rework-limit';

export interface ReworkAnalysisRow {
  id: number;
  created_at: string;
  root_cause: string;
  change: string;
}

export interface ReworkState {
  taskFails: number;
  taskRuns: number;
  issueFails: number;
  waivedAt: string | null;
  lastFailAt: string | null;
  analyses: ReworkAnalysisRow[];
  proofAt: Record<string, string | null>;
}

const PROOF_EVENT_SQL = [...new Set(Object.values(REWORK_PROOF_EVENTS))].map((e) => `'${e}'`).join(', ');

function readState(db: string, taskId: string, env: NodeJS.ProcessEnv): ReworkState | null | typeof GATE_READ_ERROR {
  const out = gateRead(
    db,
    `WITH t AS (SELECT id, issue_id FROM tasks WHERE id = ${taskId}),
          human AS (SELECT MAX(d.created_at) AS at FROM discussions d, t
                     WHERE (d.task_id = t.id OR (d.task_id IS NULL AND d.issue_id = t.issue_id))
                       AND d.author = 'human' AND d.kind = 'decision'),
          since AS (SELECT COALESCE(MAX(v.id), 0) AS pass_id FROM validation_attempts v, t
                     WHERE v.task_id = t.id AND v.verdict = 'pass'),
          analyses AS (SELECT a.id, a.created_at,
                              json_extract(a.content_json, '$.root_cause') AS root_cause,
                              json_extract(a.content_json, '$.change') AS change_kind
                         FROM audit a, t, human
                        WHERE a.event_type = 'task_rework_analysis' AND a.issue_id = t.issue_id
                          AND json_extract(a.content_json, '$.task_id') = t.id
                          AND (human.at IS NULL OR a.created_at > human.at)),
          proofs AS (SELECT a.event_type, MAX(a.created_at) AS at FROM audit a, t
                      WHERE a.event_type IN (${PROOF_EVENT_SQL}) AND a.issue_id = t.issue_id
                        AND json_extract(a.content_json, '$.task_id') = t.id
                      GROUP BY a.event_type)
     SELECT json_object(
       'task_fails', (SELECT COUNT(*) FROM validation_attempts v, t, since, human
                       WHERE v.task_id = t.id AND v.verdict = 'fail' AND v.id > since.pass_id
                         AND (human.at IS NULL OR v.created_at > human.at)),
       'task_runs', (SELECT COUNT(*) FROM agent_runs r, t, human
                      WHERE r.task_id = t.id AND ${SWE_SPAWN_SQL} AND COALESCE(r.stop_cause, '') <> 'budget'
                        AND (human.at IS NULL OR r.started_at > human.at)),
       'issue_fails', (SELECT COUNT(*) FROM validation_attempts v JOIN tasks x ON x.id = v.task_id, t, human
                        WHERE x.issue_id = t.issue_id AND v.verdict = 'fail'
                          AND NOT EXISTS (SELECT 1 FROM validation_attempts p
                                           WHERE p.task_id = v.task_id AND p.verdict = 'pass' AND p.id > v.id)
                          AND (human.at IS NULL OR v.created_at > human.at)),
       'waived_at', (SELECT at FROM human),
       'last_fail_at', (SELECT v.created_at FROM validation_attempts v, t
                         WHERE v.task_id = t.id AND v.verdict = 'fail' ORDER BY v.id DESC LIMIT 1),
       'analyses', json((SELECT json_group_array(json_object('id', id, 'created_at', created_at,
                                                             'root_cause', root_cause, 'change', change_kind))
                           FROM (SELECT * FROM analyses ORDER BY created_at, id))),
       'proofs', json((SELECT json_group_object(event_type, at) FROM proofs)))
     FROM t;`,
    env,
  );
  if (out === GATE_READ_ERROR) return GATE_READ_ERROR;
  if (out === '') return null;
  const row = JSON.parse(out.split('\n')[0]) as {
    task_fails: number;
    task_runs: number;
    issue_fails: number;
    waived_at: string | null;
    last_fail_at: string | null;
    analyses: ReworkAnalysisRow[];
    proofs: Record<string, string | null>;
  };
  return {
    taskFails: row.task_fails,
    taskRuns: row.task_runs,
    issueFails: row.issue_fails,
    waivedAt: row.waived_at,
    lastFailAt: row.last_fail_at,
    analyses: row.analyses,
    proofAt: row.proofs,
  };
}

const newer = (at: string | null | undefined, than: string | null): boolean =>
  typeof at === 'string' && (than === null || at > than);

/** Why the inner limit still holds, or null when it is clear: under the limit, or an analysis plus its proven change. */
function innerLimit(state: ReworkState): string | null {
  if (state.taskFails < REWORK_FAIL_LIMIT) return null;
  const count = `task FAILs: ${state.taskFails} review FAILs on the task since its last pass (limit ${REWORK_FAIL_LIMIT})`;
  const latest = state.analyses.at(-1);
  if (latest === undefined || !newer(latest.created_at, state.lastFailAt)) {
    return `${count}, with no task_rework_analysis newer than the latest FAIL`;
  }
  const proof = REWORK_PROOF_EVENTS[latest.change as ReworkChange];
  if (proof === undefined) {
    return `${count}; analysis #${latest.id} names change ${latest.change}, which admits no further swe run of this task`;
  }
  if (!newer(state.proofAt[proof], state.lastFailAt)) {
    return `${count}; analysis #${latest.id} names change ${latest.change}, with no ${proof} row newer than the latest FAIL`;
  }
  return null;
}

function repeatedRootCause(analyses: readonly ReworkAnalysisRow[]): string | null {
  const seen = new Set<string>();
  for (const a of analyses) {
    if (seen.has(a.root_cause)) return a.root_cause;
    seen.add(a.root_cause);
  }
  return null;
}

function ceilingLimits(state: ReworkState): string[] {
  const tripped: string[] = [];
  if (state.taskRuns >= SWE_RUN_LIMIT) {
    tripped.push(`task runs: ${state.taskRuns} swe runs of the task, budget handbacks aside (limit ${SWE_RUN_LIMIT})`);
  }
  if (state.issueFails >= ISSUE_FAIL_LIMIT) {
    tripped.push(`issue FAILs: ${state.issueFails} review FAILs across the issue's tasks (limit ${ISSUE_FAIL_LIMIT})`);
  }
  const repeated = repeatedRootCause(state.analyses);
  if (repeated !== null) {
    tripped.push(`repeated root cause: two task_rework_analysis rows of the task name root_cause ${repeated}`);
  }
  return tripped;
}

function analysisList(analyses: readonly ReworkAnalysisRow[]): string {
  if (analyses.length === 0) return 'none';
  return analyses.map((a) => `#${a.id} (root_cause ${a.root_cause}, change ${a.change})`).join(', ');
}

export interface ReworkDeny {
  reason: string;
  fix: DenyFix;
}

export function reworkDeny(taskId: string, state: ReworkState): ReworkDeny | null {
  const inner = innerLimit(state);
  const ceiling = ceilingLimits(state);
  if (inner === null && ceiling.length === 0) return null;
  const since = state.waivedAt === null ? '' : ` since the Human's last waiver at ${state.waivedAt}`;
  const head = `BLOCKED: task ${taskId} is at the rework limit${since}: ${[...(inner === null ? [] : [inner]), ...ceiling].join('; ')}. `;
  if (ceiling.length > 0) {
    return {
      reason:
        head +
        `This is the outer ceiling, which no task_rework_analysis lifts. Analyses since the last waiver: ${analysisList(state.analyses)}. ` +
        'Report the task to the Human with these analyses and concrete options (redesign, split, or stop). ' +
        `Only the Human lifts the ceiling, by typing \`waive task ${taskId}\`. No agent action lifts it.`,
      fix: 'policy',
    };
  }
  return {
    reason:
      head +
      'Analyze both FAILs with `task_rework_analysis`, then make the change it names: change=spec_update with `task_update_spec`, ' +
      'or change=effort_raise with `task_reopen(effort=...)`; the analysis plus that change admits the next swe run. ' +
      'A split or `task_retry` starts a new task with its own count instead. ' +
      'The Human is needed only for a product decision the spec cannot settle.',
    fix: {
      allowed:
        `task_rework_analysis(agent='bro', task_id=${taskId}, fail_validation_ids=[<FAIL ids>], finding_ids=['F${taskId}-<n>'], root_cause, change, rationale), ` +
        `then task_update_spec(task_id=${taskId}, ...) or task_reopen(task_id=${taskId}, effort=...)`,
    },
  };
}

export const denyPreToolUse: (reason: string, fix: DenyFix) => GateResult = denyResult;

export function denyUnreadable(gate: string, env: NodeJS.ProcessEnv): GateResult {
  return { stdout: `${denyDbUnavailable(gate, env)}\n`, code: 0 };
}

// The rework-limit verdict on one more swe run of `taskId` (a spawn, or a
// resume through SendMessage, GH 1742): denied at the inner limit without a
// proven analysis, denied at the outer ceiling until a Human waiver, denied on
// a DB read failure, else allowed.
export function reworkLimitVerdict(gate: string, db: string, taskId: string, env: NodeJS.ProcessEnv): GateResult {
  const state = readState(db, taskId, env);
  if (state === GATE_READ_ERROR) return denyUnreadable(gate, env);
  if (state === null) return ALLOW;
  const deny = reworkDeny(taskId, state);
  return deny === null ? ALLOW : denyPreToolUse(deny.reason, deny.fix);
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
