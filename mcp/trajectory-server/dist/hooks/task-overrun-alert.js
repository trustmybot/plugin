/**
 * UserPromptSubmit and PostToolUse(trajectory-server) gate (GH 1738), born in
 * TypeScript: tells bro, once per running stint, that a `running` task passed
 * TMB_TASK_OVERRUN_MIN minutes (default 60) since the stint began: its newest
 * `task_reopened` audit row, else its created_at. A task reopened after a
 * review FAIL or long after its close is timed from the reopen, so the review
 * wait and the closed time never count. One additionalContext line per task:
 * its id, the minutes elapsed, its attempts (swe spawns) and its current
 * blocker (the first line of its latest FAIL feedback, else its status).
 *
 * It also tells bro, once per spawn, that a live swe run of bro's session
 * (an `agent_runs` row with a spawn_id and no completed_at) started past the
 * same threshold while its task is missing or no longer `running` (GH 2190).
 * A run on a `running` task is left to the task line.
 *
 * The once-markers are a `task_overrun_alerted` audit row per task and stint
 * start (`since`) and an
 * `agent_run_overrun_alerted` row per spawn_id, claimed before the line is
 * emitted: an insert guarded on no row for that key, so two hook runs racing
 * alert once. When the claim cannot be written the lines are emitted anyway
 * (an advisory may repeat, never stay silent). Acts only for bro; never
 * denies; no DB or a read failure is silent.
 */
import { ALLOW } from './gate.js';
import { auditSql, dedupeGuard, dbWrite, nowIso } from './lib/audit.js';
import { dbPath, gateRead, GATE_READ_ERROR, haveSqlite, sqlQuote } from './lib/db.js';
import { jqAlternatives, jqCompact } from './lib/jq.js';
import { agentRole } from './lib/role.js';
import { elapsedMs, SWE_SPAWN_SQL } from '../task-rework.js';
export const GATE_NAME = 'task-overrun-alert';
export const OVERRUN_ENV = 'TMB_TASK_OVERRUN_MIN';
export const DEFAULT_OVERRUN_MIN = 60;
const EVENT = 'task_overrun_alerted';
const RUN_EVENT = 'agent_run_overrun_alerted';
const FROM_NODE = `hook:${GATE_NAME}`;
const MS_PER_MIN = 60_000;
const SYSTEM_ISSUE = '-1';
function thresholdMin(env) {
    const raw = env[OVERRUN_ENV] ?? '';
    return /^[0-9]+$/.test(raw) ? Number(raw) : DEFAULT_OVERRUN_MIN;
}
function overMinutes(at, now, limitMin) {
    const ms = at === null ? null : elapsedMs(at, now);
    if (ms === null || ms <= limitMin * MS_PER_MIN)
        return null;
    return Math.floor(ms / MS_PER_MIN);
}
function overruns(db, now, limitMin, env) {
    const out = gateRead(db, `WITH live AS (
       SELECT t.*, COALESCE((SELECT MAX(r.created_at) FROM audit r
                              WHERE r.event_type = 'task_reopened' AND json_valid(r.content_json)
                                AND json_extract(r.content_json, '$.task_id') = t.id), t.created_at) AS since
         FROM tasks t
        WHERE t.status = 'running')
     SELECT COALESCE(json_group_array(json_object(
         'id', l.id, 'issue_id', l.issue_id, 'branch_id', l.branch_id, 'status', l.status, 'since', l.since,
         'attempts', (SELECT COUNT(*) FROM agent_runs WHERE task_id = l.id AND ${SWE_SPAWN_SQL}),
         'fail', (SELECT feedback FROM validation_attempts v WHERE v.task_id = l.id AND v.verdict = 'fail' ORDER BY v.id DESC LIMIT 1))), '[]')
       FROM live l
      WHERE NOT EXISTS (SELECT 1 FROM audit a WHERE a.event_type = 'task_overrun_alerted' AND json_valid(a.content_json)
                         AND json_extract(a.content_json, '$.task_id') = l.id
                         AND julianday(a.created_at) >= julianday(l.since));`, env);
    if (out === GATE_READ_ERROR || out === '')
        return null;
    const rows = JSON.parse(out);
    const found = [];
    for (const r of rows) {
        const minutes = overMinutes(r.since, now, limitMin);
        if (minutes === null)
            continue;
        const firstLine = (r.fail ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
        found.push({
            taskId: r.id,
            issueId: r.issue_id,
            branchId: r.branch_id,
            since: r.since,
            minutes,
            attempts: r.attempts,
            blocker: firstLine === '' ? `status ${r.status}` : firstLine,
        });
    }
    return found.sort((a, b) => a.taskId - b.taskId);
}
function runOverruns(db, sessionId, now, limitMin, env) {
    const out = gateRead(db, `SELECT COALESCE(json_group_array(json_object(
         'spawn_id', r.spawn_id, 'task_id', r.task_id, 'issue_id', COALESCE(t.issue_id, r.issue_id),
         'branch_id', t.branch_id, 'status', t.status, 'started_at', r.started_at)), '[]')
       FROM agent_runs r LEFT JOIN tasks t ON t.id = r.task_id
      WHERE r.agent_type = 'swe' AND r.completed_at IS NULL AND r.spawn_id IS NOT NULL
        AND r.session_id = '${sqlQuote(sessionId)}'
        AND (t.id IS NULL OR t.status <> 'running')
        AND NOT EXISTS (SELECT 1 FROM audit a WHERE a.event_type = 'agent_run_overrun_alerted' AND json_valid(a.content_json)
                         AND json_extract(a.content_json, '$.spawn_id') = r.spawn_id);`, env);
    if (out === GATE_READ_ERROR || out === '')
        return null;
    const rows = JSON.parse(out);
    const found = [];
    const seen = new Set();
    for (const r of rows) {
        const minutes = overMinutes(r.started_at, now, limitMin);
        if (minutes === null || seen.has(r.spawn_id))
            continue;
        seen.add(r.spawn_id);
        found.push({
            spawnId: r.spawn_id,
            taskId: r.task_id,
            issueId: r.issue_id,
            branchId: r.branch_id ?? '',
            status: r.status ?? 'missing',
            minutes,
        });
    }
    return found.sort((a, b) => b.minutes - a.minutes || a.spawnId.localeCompare(b.spawnId));
}
function taskMark(o) {
    return {
        key: `task:${o.taskId}`,
        event: EVENT,
        dedupePaths: ['$.task_id', '$.since'],
        issueId: String(o.issueId),
        branchId: o.branchId,
        summary: `task ${o.taskId} running ${o.minutes} min`,
        content: jqCompact({ task_id: o.taskId, since: o.since, minutes: o.minutes, attempts: o.attempts, blocker: o.blocker }),
    };
}
function runMark(r, index) {
    return {
        key: `run:${index}`,
        event: RUN_EVENT,
        dedupePaths: ['$.spawn_id'],
        issueId: r.issueId === null ? SYSTEM_ISSUE : String(r.issueId),
        branchId: r.branchId,
        summary: `swe run ${r.spawnId} live ${r.minutes} min on task status ${r.status}`,
        content: jqCompact({ spawn_id: r.spawnId, task_id: r.taskId, minutes: r.minutes }),
    };
}
/** Writes the once-markers; the keys actually claimed, or null when the write failed. */
function claim(db, marks, now, env) {
    const statements = [];
    for (const m of marks) {
        const guard = dedupeGuard(m.event, m.content, m.dedupePaths, { caller: GATE_NAME });
        const row = auditSql({ issueId: m.issueId, branchId: m.branchId, fromNode: FROM_NODE, eventType: m.event, summary: m.summary, contentJson: m.content }, guard.sql, { caller: GATE_NAME, env, now: nowIso(now) });
        if (guard.code !== 0 || row.code !== 0)
            return null;
        statements.push(row.sql, `SELECT '${m.key}' WHERE changes() = 1;`);
    }
    const w = dbWrite(db, statements.join('\n'), { caller: GATE_NAME, env });
    if (!w.ok)
        return null;
    return new Set(w.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== ''));
}
export function alertLine(o) {
    return `TMB: task ${o.taskId} has been running ${o.minutes} min (attempts: ${o.attempts} swe spawns; blocker: ${o.blocker}). Decide whether to continue, redesign the spec or split the task, record the decision on the issue, and tell the Human without waiting for a reply.`;
}
export function runAlertLine(r) {
    return `TMB: swe run ${r.spawnId} (task ${r.taskId ?? 'none'}, task status ${r.status}) started ${r.minutes} min ago and has not stopped. Check whether it is stuck and stop it if so.`;
}
export function makeTaskOverrunAlert(clock = () => new Date()) {
    return (payload, env) => {
        if (agentRole(payload) !== 'bro')
            return ALLOW;
        const db = dbPath(env);
        if (db === null || !haveSqlite(env))
            return ALLOW;
        const now = clock();
        const limitMin = thresholdMin(env);
        const tasks = overruns(db, now, limitMin, env) ?? [];
        const sessionId = jqAlternatives(payload, [['session_id']]);
        const runs = sessionId === '' ? [] : (runOverruns(db, sessionId, now, limitMin, env) ?? []);
        const candidates = [
            ...tasks.map((o) => ({ mark: taskMark(o), line: alertLine(o) })),
            ...runs.map((r, i) => ({ mark: runMark(r, i), line: runAlertLine(r) })),
        ];
        if (candidates.length === 0)
            return ALLOW;
        const claimed = claim(db, candidates.map((c) => c.mark), now, env);
        const emit = claimed === null ? candidates : candidates.filter((c) => claimed.has(c.mark.key));
        if (emit.length === 0)
            return ALLOW;
        const event = jqAlternatives(payload, [['hook_event_name']]) || 'UserPromptSubmit';
        return {
            stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: event, additionalContext: emit.map((c) => c.line).join('\n') } })}\n`,
            code: 0,
        };
    };
}
export const taskOverrunAlert = makeTaskOverrunAlert();
//# sourceMappingURL=task-overrun-alert.js.map