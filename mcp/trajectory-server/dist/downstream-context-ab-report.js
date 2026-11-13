/**
 * The read side of the downstream-context A/B (GH 1990), after
 * effort-ab-report.ts: three cells with the median and mean of four per-task
 * metrics. `baseline` is the 20 most recent closed tasks finished before
 * tools_shipped_at (no world-model tools); `hooks-off` and `hooks-on` are the
 * tasks of the label's downstream_context_ab_enrolled rows by arm.
 *
 * - tokens: input, output, cache-read and cache-creation tokens over the
 *   task's agent_runs.
 * - first_pass: 1 when the task's first validation attempt is a pass, 0 when
 *   it is not, null with none; its mean is the first-pass rate.
 * - caller_bugs: findings of the task's failed attempts whose text names a
 *   file outside the diff (tasks.files plus the newest bro_verification_pass
 *   row's scope.extras_accepted).
 * - wm_calls_per_run: wm_tool_called rows whose from_node is a swe or
 *   code-reviewer run's agent_type, inside that run's started_at..completed_at
 *   window, over the task's swe and code-reviewer runs (null with none).
 *
 * Read-only.
 */
import { DOWNSTREAM_AB_EVENT } from './downstream-context-ab.js';
export const DOWNSTREAM_AB_CELLS = ['baseline', 'hooks-off', 'hooks-on'];
export const DOWNSTREAM_AB_METRICS = ['tokens', 'first_pass', 'caller_bugs', 'wm_calls_per_run'];
export const BASELINE_TASKS = 20;
const RUN_ROLES = ['swe', 'code-reviewer'];
const PATH_IN_TEXT = /(?:[\w.-]+\/)+[\w.-]+\.\w+/g;
function summarize(values) {
    const xs = values.filter((v) => v !== null).sort((a, b) => a - b);
    if (xs.length === 0)
        return { n: 0, median: null, mean: null };
    const mid = Math.floor(xs.length / 2);
    const median = xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
    return { n: xs.length, median, mean: xs.reduce((a, b) => a + b, 0) / xs.length };
}
function taskTokens(db, taskId) {
    return (db.get(`SELECT SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0)) AS n
         FROM agent_runs WHERE task_id = ?`, [taskId])?.n ?? 0);
}
function firstPass(db, taskId) {
    const row = db.get(`SELECT verdict FROM validation_attempts WHERE task_id = ? ORDER BY attempt_n, id LIMIT 1`, [taskId]);
    return row === undefined ? null : row.verdict === 'pass' ? 1 : 0;
}
function jsonStrings(text) {
    try {
        const v = JSON.parse(text ?? '[]');
        return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    }
    catch {
        return [];
    }
}
/** Whether <path> sits in the diff: a scope entry equal to it, or a directory entry (trailing /) holding it. */
export function inScope(path, scope) {
    return scope.some((s) => (s.endsWith('/') ? path.startsWith(s) || `${path}/` === s : path === s || path.endsWith(`/${s}`) || s.endsWith(`/${path}`)));
}
function diffScope(db, taskId) {
    const files = jsonStrings(db.get(`SELECT files FROM tasks WHERE id = ?`, [taskId])?.files);
    const extras = db.get(`SELECT json_extract(content_json, '$.scope.extras_accepted') AS extras FROM audit
      WHERE event_type = 'bro_verification_pass' AND json_valid(content_json)
        AND CAST(json_extract(content_json, '$.task_id') AS INTEGER) = ?
      ORDER BY id DESC LIMIT 1`, [taskId])?.extras;
    return [...files, ...jsonStrings(extras)];
}
function callerBugs(db, taskId) {
    const scope = diffScope(db, taskId);
    const findings = db.all(`SELECT f.probe_cmd, f.expected, f.observed FROM review_findings f
       JOIN validation_attempts v ON v.task_id = f.task_id AND v.attempt_n = f.attempt_n AND v.verdict = 'fail'
      WHERE f.task_id = ?`, [taskId]);
    return findings.filter((f) => {
        const paths = `${f.probe_cmd}\n${f.expected}\n${f.observed}`.match(PATH_IN_TEXT) ?? [];
        return paths.some((p) => !inScope(p, scope));
    }).length;
}
function wmCallsPerRun(db, taskId) {
    const marks = RUN_ROLES.map(() => '?').join(', ');
    const runs = db.all(`SELECT agent_type, started_at, completed_at FROM agent_runs WHERE task_id = ? AND agent_type IN (${marks})`, [taskId, ...RUN_ROLES]);
    if (runs.length === 0)
        return null;
    let calls = 0;
    for (const r of runs) {
        calls +=
            db.get(`SELECT COUNT(*) AS n FROM audit WHERE event_type = 'wm_tool_called' AND from_node = ? AND created_at >= ? AND created_at <= ?`, [r.agent_type, r.started_at, r.completed_at ?? '9999-12-31T23:59:59Z'])?.n ?? 0;
    }
    return calls / runs.length;
}
function cellReport(db, cell, taskIds) {
    const perTask = taskIds.map((id) => ({
        tokens: taskTokens(db, id),
        first_pass: firstPass(db, id),
        caller_bugs: callerBugs(db, id),
        wm_calls_per_run: wmCallsPerRun(db, id),
    }));
    const metrics = Object.fromEntries(DOWNSTREAM_AB_METRICS.map((m) => [m, summarize(perTask.map((t) => t[m]))]));
    return { cell, task_count: taskIds.length, task_ids: taskIds, metrics };
}
export function downstreamContextAbReport(db, ab) {
    const baseline = db
        .all(`SELECT id FROM tasks WHERE status = 'closed' AND COALESCE(completed_at, updated_at) < ?
        ORDER BY COALESCE(completed_at, updated_at) DESC, id DESC LIMIT ?`, [ab.tools_shipped_at, BASELINE_TASKS])
        .map((r) => r.id)
        .sort((a, b) => a - b);
    const enrolled = db.all(`SELECT CAST(json_extract(content_json, '$.task_id') AS INTEGER) AS task_id, MIN(json_extract(content_json, '$.arm')) AS arm
       FROM audit WHERE event_type = ? AND json_valid(content_json) AND json_extract(content_json, '$.label') = ?
      GROUP BY 1 ORDER BY 1`, [DOWNSTREAM_AB_EVENT, ab.label]);
    const arm = (a) => enrolled.filter((r) => r.arm === a).map((r) => r.task_id);
    return {
        label: ab.label,
        tools_shipped_at: ab.tools_shipped_at,
        cells: [cellReport(db, 'baseline', baseline), cellReport(db, 'hooks-off', arm('off')), cellReport(db, 'hooks-on', arm('on'))],
    };
}
function fmt(value) {
    if (value === null)
        return '-';
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
export function formatDownstreamContextAbReport(report) {
    const lines = [`downstream-context A/B '${report.label}' (tools shipped ${report.tools_shipped_at})`];
    for (const cell of report.cells) {
        lines.push('', `${cell.cell}: ${cell.task_count} task(s)${cell.task_ids.length ? ` [${cell.task_ids.join(', ')}]` : ''}`);
        for (const m of DOWNSTREAM_AB_METRICS) {
            const s = cell.metrics[m];
            lines.push(`  ${m.padEnd(17)} median ${fmt(s.median).padStart(12)}  mean ${fmt(s.mean).padStart(12)}  n=${s.n}`);
        }
    }
    return lines.join('\n') + '\n';
}
//# sourceMappingURL=downstream-context-ab-report.js.map