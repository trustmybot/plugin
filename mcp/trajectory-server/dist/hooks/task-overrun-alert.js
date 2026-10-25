/**
 * UserPromptSubmit and PostToolUse(trajectory-server) gate (GH 1738), born in
 * TypeScript: tells bro, once per task, that a `running` task passed
 * TMB_TASK_OVERRUN_MIN minutes (default 60) since its created_at. One
 * additionalContext line per task: its id, the minutes elapsed, its attempts
 * (swe spawns) and its current blocker (the first line of its latest FAIL
 * feedback, else its status).
 *
 * The once-marker is a `task_overrun_alerted` audit row per task, claimed
 * before the line is emitted: an insert guarded on no row for that task_id,
 * so two hook runs racing on one task alert once. When the claim cannot be
 * written the lines are emitted anyway (an advisory may repeat, never stay
 * silent). Acts only for bro; never denies; no DB or a read failure is silent.
 */
import { ALLOW } from './gate.js';
import { auditSql, dedupeGuard, dbWrite, nowIso } from './lib/audit.js';
import { dbPath, gateRead, GATE_READ_ERROR, haveSqlite, sqlInt } from './lib/db.js';
import { jqAlternatives, jqCompact } from './lib/jq.js';
import { agentRole } from './lib/role.js';
import { elapsedMs, SWE_SPAWN_SQL } from '../task-rework.js';
export const GATE_NAME = 'task-overrun-alert';
export const OVERRUN_ENV = 'TMB_TASK_OVERRUN_MIN';
export const DEFAULT_OVERRUN_MIN = 60;
const EVENT = 'task_overrun_alerted';
const FROM_NODE = `hook:${GATE_NAME}`;
const MS_PER_MIN = 60_000;
function thresholdMin(env) {
    const raw = env[OVERRUN_ENV] ?? '';
    return /^[0-9]+$/.test(raw) ? Number(raw) : DEFAULT_OVERRUN_MIN;
}
function overruns(db, now, limitMin, env) {
    const out = gateRead(db, `SELECT COALESCE(json_group_array(json_object(
         'id', t.id, 'issue_id', t.issue_id, 'branch_id', t.branch_id, 'status', t.status, 'created_at', t.created_at,
         'attempts', (SELECT COUNT(*) FROM agent_runs WHERE task_id = t.id AND ${SWE_SPAWN_SQL}),
         'fail', (SELECT feedback FROM validation_attempts v WHERE v.task_id = t.id AND v.verdict = 'fail' ORDER BY v.id DESC LIMIT 1))), '[]')
       FROM tasks t
      WHERE t.status = 'running'
        AND NOT EXISTS (SELECT 1 FROM audit a WHERE a.event_type = 'task_overrun_alerted' AND json_valid(a.content_json)
                         AND json_extract(a.content_json, '$.task_id') = t.id);`, env);
    if (out === GATE_READ_ERROR || out === '')
        return null;
    const rows = JSON.parse(out);
    const found = [];
    for (const r of rows) {
        const ms = elapsedMs(r.created_at, now);
        if (ms === null || ms <= limitMin * MS_PER_MIN)
            continue;
        const firstLine = (r.fail ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
        found.push({
            taskId: r.id,
            issueId: r.issue_id,
            branchId: r.branch_id,
            minutes: Math.floor(ms / MS_PER_MIN),
            attempts: r.attempts,
            blocker: firstLine === '' ? `status ${r.status}` : firstLine,
        });
    }
    return found.sort((a, b) => a.taskId - b.taskId);
}
/** Writes the once-markers; the task ids actually claimed, or null when the write failed. */
function claim(db, found, now, env) {
    const statements = [];
    for (const o of found) {
        const content = jqCompact({ task_id: o.taskId, minutes: o.minutes, attempts: o.attempts, blocker: o.blocker });
        const guard = dedupeGuard(EVENT, content, ['$.task_id'], { caller: GATE_NAME });
        const row = auditSql({
            issueId: String(o.issueId),
            branchId: o.branchId,
            fromNode: FROM_NODE,
            eventType: EVENT,
            summary: `task ${o.taskId} running ${o.minutes} min`,
            contentJson: content,
        }, guard.sql, { caller: GATE_NAME, env, now: nowIso(now) });
        if (guard.code !== 0 || row.code !== 0)
            return null;
        statements.push(row.sql, `SELECT ${o.taskId} WHERE changes() = 1;`);
    }
    const w = dbWrite(db, statements.join('\n'), { caller: GATE_NAME, env });
    if (!w.ok)
        return null;
    return new Set(w.stdout.split('\n').map((l) => sqlInt(l.trim())).filter((id) => id !== '').map(Number));
}
export function alertLine(o) {
    return `TMB: task ${o.taskId} has been running ${o.minutes} min (attempts: ${o.attempts} swe spawns; blocker: ${o.blocker}). Decide with the Human whether to continue, redesign the spec or split the task.`;
}
export function makeTaskOverrunAlert(clock = () => new Date()) {
    return (payload, env) => {
        if (agentRole(payload) !== 'bro')
            return ALLOW;
        const db = dbPath(env);
        if (db === null || !haveSqlite(env))
            return ALLOW;
        const now = clock();
        const found = overruns(db, now, thresholdMin(env), env);
        if (found === null || found.length === 0)
            return ALLOW;
        const claimed = claim(db, found, now, env);
        const emit = claimed === null ? found : found.filter((o) => claimed.has(o.taskId));
        if (emit.length === 0)
            return ALLOW;
        const event = jqAlternatives(payload, [['hook_event_name']]) || 'UserPromptSubmit';
        return {
            stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: event, additionalContext: emit.map(alertLine).join('\n') } })}\n`,
            code: 0,
        };
    };
}
export const taskOverrunAlert = makeTaskOverrunAlert();
//# sourceMappingURL=task-overrun-alert.js.map