/**
 * PreToolUse(Agent) gate (GH 1738, GH 2148, GH 2830, GH 2857), run by
 * agent-spawn-dispatch: a swe spawn for task_id=<N> is judged by bro's typed
 * rework analysis. No swe-run or issue-wide FAIL count denies a spawn, and no
 * discussions row lifts a deny; how much rework a task gets is bro's
 * judgement, proven change by change.
 *
 * Design drift: a `task_rework_analysis` audit row of the task with
 * root_cause design_drift denies every further swe run of the task whatever
 * the FAIL count. The drifted task ends there: bro redesigns the work as a
 * new task, by `task_retry` with a redesigned spec or by a split.
 *
 * Rework limit: from REWORK_FAIL_LIMIT review FAILs on the task since its
 * last passing review, the gate is an allowlist. It admits a spawn only when the
 * task's latest analysis is newer than its latest FAIL and names a change in
 * SPAWN_ADMITTING_CHANGES that a row dated after that FAIL proves:
 *
 *   - spec_update: a `task_spec_amended` row for the task,
 *   - effort_raise: a `task_effort_raised` row for the task,
 *   - world_model_fix: a `deep_scan_completed` or `wm_reindex` row, a
 *     `wm_tool_called` row of a successful `world_model_concept_upsert`, or an
 *     issue created with the `Area: World Model` label.
 *
 * split, retry, re_review and ask_human never admit a swe run of this task:
 * split and retry start a new task, re_review is no swe run (review_handoff
 * re-hands the unchanged commit to a new code-reviewer), and ask_human
 * takes a question to the Human; a run after the answer needs a fresh
 * analysis naming a proven change. Each further FAIL needs a fresh analysis.
 *
 * No other row lifts a deny. Rows of one table order by
 * created_at, then id; a row of one table is newer than a row of another only
 * when its created_at is strictly later. Only swe spawns naming task_id=<N>
 * are judged; a missing task_id is require-task-spec's. No resolvable DB or
 * no tasks row allows, a DB read failure denies.
 */
import { ALLOW, type GateResult, type SyncGate } from './gate.js';
import { dbPath, denyDbUnavailable, gateRead, GATE_READ_ERROR, haveSqlite, sqlInt, sqlQuote } from './lib/db.js';
import { type DenyFix, denyResult } from './lib/deny.js';
import { jqAlternatives } from './lib/jq.js';
import { normalizeRole } from './lib/role.js';
import {
  MAX_EFFORT,
  REWORK_FAIL_LIMIT,
  SPAWN_ADMITTING_CHANGES,
  TASK_PROOF_EVENTS,
  WORLD_MODEL_ISSUE_LABEL,
  WORLD_MODEL_PROOF_EVENTS,
  WORLD_MODEL_PROOF_TOOL,
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
  effort: string | null;
  taskFails: number;
  lastFailAt: string | null;
  analyses: ReworkAnalysisRow[];
  proofAt: Record<string, string | null>;
}

const sqlList = (values: readonly string[]): string => values.map((v) => `'${sqlQuote(v)}'`).join(', ');

const taskProofSql = (eventType: string): string =>
  `(SELECT MAX(a.created_at) FROM audit a, t
     WHERE a.event_type = '${sqlQuote(eventType)}' AND a.issue_id = t.issue_id
       AND json_extract(a.content_json, '$.task_id') = t.id)`;

const WORLD_MODEL_PROOF_SQL = `(SELECT MAX(at) FROM (
     SELECT created_at AS at FROM audit WHERE event_type IN (${sqlList(WORLD_MODEL_PROOF_EVENTS)})
     UNION ALL
     SELECT created_at FROM audit
      WHERE event_type = 'wm_tool_called'
        AND json_extract(content_json, '$.tool') = '${sqlQuote(WORLD_MODEL_PROOF_TOOL)}'
        AND COALESCE(json_extract(content_json, '$.error'), 0) = 0
     UNION ALL
     SELECT i.created_at FROM issues i
      WHERE EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(i.labels) THEN i.labels ELSE '[]' END)
                     WHERE value = '${sqlQuote(WORLD_MODEL_ISSUE_LABEL)}')))`;

function readState(db: string, taskId: string, env: NodeJS.ProcessEnv): ReworkState | null | typeof GATE_READ_ERROR {
  const out = gateRead(
    db,
    `WITH t AS (SELECT id, issue_id, effort FROM tasks WHERE id = ${taskId}),
          since AS (SELECT COALESCE(MAX(v.id), 0) AS pass_id FROM validation_attempts v, t
                     WHERE v.task_id = t.id AND v.verdict = 'pass'),
          analyses AS (SELECT a.id, a.created_at,
                              json_extract(a.content_json, '$.root_cause') AS root_cause,
                              json_extract(a.content_json, '$.change') AS change_kind
                         FROM audit a, t
                        WHERE a.event_type = 'task_rework_analysis' AND a.issue_id = t.issue_id
                          AND json_extract(a.content_json, '$.task_id') = t.id)
     SELECT json_object(
       'effort', t.effort,
       'task_fails', (SELECT COUNT(*) FROM validation_attempts v, t, since
                       WHERE v.task_id = t.id AND v.verdict = 'fail' AND v.id > since.pass_id),
       'last_fail_at', (SELECT v.created_at FROM validation_attempts v, t
                         WHERE v.task_id = t.id AND v.verdict = 'fail' ORDER BY v.id DESC LIMIT 1),
       'analyses', json((SELECT json_group_array(json_object('id', id, 'created_at', created_at,
                                                             'root_cause', root_cause, 'change', change_kind))
                           FROM (SELECT * FROM analyses ORDER BY created_at, id))),
       'proofs', json_object('spec_update', ${taskProofSql(TASK_PROOF_EVENTS.spec_update)},
                             'effort_raise', ${taskProofSql(TASK_PROOF_EVENTS.effort_raise)},
                             'world_model_fix', ${WORLD_MODEL_PROOF_SQL}))
     FROM t;`,
    env,
  );
  if (out === GATE_READ_ERROR) return GATE_READ_ERROR;
  if (out === '') return null;
  const row = JSON.parse(out.split('\n')[0]) as {
    effort: string | null;
    task_fails: number;
    last_fail_at: string | null;
    analyses: ReworkAnalysisRow[];
    proofs: Record<string, string | null>;
  };
  return {
    effort: row.effort,
    taskFails: row.task_fails,
    lastFailAt: row.last_fail_at,
    analyses: row.analyses,
    proofAt: row.proofs,
  };
}

const newer = (at: string | null | undefined, than: string | null): boolean =>
  typeof at === 'string' && (than === null || at > than);

const PROOF_NAMES: Readonly<Record<string, string>> = {
  spec_update: `a ${TASK_PROOF_EVENTS.spec_update} row`,
  effort_raise: `a ${TASK_PROOF_EVENTS.effort_raise} row`,
  world_model_fix: `a world-model scan, reindex, ${WORLD_MODEL_PROOF_TOOL} or \`${WORLD_MODEL_ISSUE_LABEL}\` issue`,
};

/** Why the rework limit still holds, or null when it is clear: under the limit, or the latest analysis plus its proven change. */
function reworkLimitHolds(state: ReworkState): string | null {
  if (state.taskFails < REWORK_FAIL_LIMIT) return null;
  const count = `task FAILs: ${state.taskFails} review FAILs on the task since its last passing review (limit ${REWORK_FAIL_LIMIT})`;
  const latest = state.analyses.at(-1);
  if (latest === undefined || !newer(latest.created_at, state.lastFailAt)) {
    return `${count}, with no task_rework_analysis newer than the latest FAIL`;
  }
  if (!SPAWN_ADMITTING_CHANGES.includes(latest.change as ReworkChange)) {
    return `${count}; analysis #${latest.id} names change ${latest.change}, which admits no further swe run of this task`;
  }
  if (!newer(state.proofAt[latest.change], state.lastFailAt)) {
    return `${count}; analysis #${latest.id} names change ${latest.change}, with no proof dated after the latest FAIL (${PROOF_NAMES[latest.change]})`;
  }
  return null;
}

export interface ReworkDeny {
  reason: string;
  fix: DenyFix;
}

function designDriftDeny(taskId: string, drift: ReworkAnalysisRow): ReworkDeny {
  return {
    reason:
      `BLOCKED: task ${taskId}: analysis #${drift.id} names root_cause design_drift, so the reality has drifted from the design and no further swe run of this task goes on. ` +
      'Redesign the work as a new task: `task_retry` this task with a spec redesigned for the reality the analysis found, ' +
      'or split it into new tasks with `task_create_batch`, each with its own spec and swe runs.',
    fix: {
      allowed:
        `task_update_status(agent='bro', task_id=${taskId}, status='escalated'), then task_retry(agent='bro', failed_task_id=${taskId}, new_branch_id, corrected_spec_body, retry_rationale, description), ` +
        'or the split tasks through task_create_batch',
    },
  };
}

/**
 * The rework-limit deny. A review FAIL already raises its task to the top
 * effort (GH 2866), so a task at MAX_EFFORT is offered no effort_raise.
 */
function reworkLimitDeny(taskId: string, holds: string, effort: string | null): ReworkDeny {
  const canRaise = effort !== MAX_EFFORT;
  const effortChange = canRaise ? 'effort_raise with `task_reopen(effort=...)`, ' : '';
  const atMaxEffort = canRaise ? '' : `The task already runs at effort "${MAX_EFFORT}", so no effort_raise is left. `;
  return {
    reason:
      `BLOCKED: task ${taskId} is at the rework limit: ${holds}. ` +
      'Debug the root cause before another swe run: check the inputs first (the spec, the world model, the reviewer, the environment), then swe\'s execution. ' +
      'Answer the approach question: do the findings share one cause in the approach itself, each round patching the same mechanism? ' +
      atMaxEffort +
      `Record it with \`task_rework_analysis\`, then make the change it names: spec_update with \`task_update_spec\`, ${effortChange}` +
      `world_model_fix with \`scan_run\`, \`${WORLD_MODEL_PROOF_TOOL}\` or an issue labeled \`${WORLD_MODEL_ISSUE_LABEL}\`; the analysis plus that change admits the next swe run. ` +
      'A shared approach cause takes a redesign: a split or `task_retry`, each starting a new task, ' +
      'and so does a reality drifted from the design (root_cause design_drift, change split or retry).',
    fix: {
      allowed:
        `task_rework_analysis(agent='bro', task_id=${taskId}, fail_validation_ids=[<FAIL ids>], finding_ids=['F${taskId}-<n>'], root_cause, change, approach_shared_cause, rationale), ` +
        `then task_update_spec(task_id=${taskId}, ...)${canRaise ? `, task_reopen(task_id=${taskId}, effort=...)` : ''} or the world-model fix`,
    },
  };
}

export function reworkDeny(taskId: string, state: ReworkState): ReworkDeny | null {
  const drift = state.analyses.find((a) => a.root_cause === 'design_drift');
  if (drift !== undefined) return designDriftDeny(taskId, drift);
  const holds = reworkLimitHolds(state);
  return holds === null ? null : reworkLimitDeny(taskId, holds, state.effort);
}

export const denyPreToolUse: (reason: string, fix: DenyFix) => GateResult = denyResult;

export function denyUnreadable(gate: string, env: NodeJS.ProcessEnv): GateResult {
  return { stdout: `${denyDbUnavailable(gate, env)}\n`, code: 0 };
}

// The rework-limit verdict on one more swe run of `taskId` (a spawn, or a
// resume through SendMessage, GH 1742): denied on design drift, denied at the
// rework limit without a proven analysis, denied on a DB read failure, else
// allowed.
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
