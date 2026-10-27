/**
 * Stop-time recorder (GH 1957), run fail-open by swe-atomic-close.sh (swe and
 * code-reviewer, SubagentStop) and bro-turn-usage.sh (bro, Stop) after each
 * writes its agent_runs row: how much text each tool returned into that run,
 * one agent_run_tool_output row per tool (schema v54).
 *
 * The transcript is parsed once per run at stop, not per tool call: each
 * tool_use block maps its id to its name, and each tool_result block adds one
 * call and the length of its text (string content, or the text of its
 * type:'text' blocks; image and other blocks count 0) to the tool of its
 * tool_use_id, `unknown` when no tool_use matches. With TMB_STOP_SINCE set
 * only entries timestamped at or after it count. est_tokens is
 * ceil(result_chars / 4).
 *
 * The run, by TMB_STOP_AGENT_TYPE:
 *   - swe / code-reviewer: the newest row of task TMB_STOP_TASK_ID of that
 *     agent type keyed by spawn_id TMB_STOP_SPAWN_ID; the payload's
 *     agent_transcript_path;
 *   - bro: the session row (task_id NULL) of TMB_STOP_SESSION_ID; the
 *     payload's transcript_path, the whole session (TMB_STOP_SINCE ignored).
 *
 * Each fire deletes and re-inserts the run's rows in one transaction, so a
 * re-fire is idempotent. Never denies: it always exits 0 with empty stdout,
 * and a missing run row, a missing, unreadable or malformed transcript, or a
 * failed read or write changes nothing.
 */
import { readFileSync } from 'node:fs';
import { ALLOW } from './gate.js';
import { dbWrite } from './lib/audit.js';
import { dbPath, gateRead, GATE_READ_ERROR, haveSqlite, sqlInt, sqlQuote } from './lib/db.js';
import { jqAlternatives } from './lib/jq.js';
export const GATE_NAME = 'tool-output-size';
export const CHARS_PER_TOKEN = 4;
export const UNKNOWN_TOOL = 'unknown';
const CANDIDATE_MARK = '"tool_';
export function resultChars(content) {
    if (typeof content === 'string')
        return content.length;
    if (!Array.isArray(content))
        return 0;
    let chars = 0;
    for (const c of content) {
        const block = c;
        if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
            chars += block.text.length;
    }
    return chars;
}
function parseEntry(line) {
    try {
        const entry = JSON.parse(line);
        return entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
    }
    catch {
        return null;
    }
}
/**
 * Per-tool totals of the transcript's tool results timestamped at or after
 * <sinceMs> (every result when null), sorted by tool name; null when no line
 * of the transcript is a JSON object.
 */
export function toolOutputSizes(transcriptText, sinceMs) {
    const names = new Map();
    const results = [];
    let parsed = false;
    const others = [];
    for (const line of transcriptText.split('\n')) {
        if (line.trim() === '')
            continue;
        if (!line.includes(CANDIDATE_MARK)) {
            if (!parsed)
                others.push(line);
            continue;
        }
        const entry = parseEntry(line);
        if (entry === null)
            continue;
        parsed = true;
        const content = entry.message?.content;
        if (!Array.isArray(content))
            continue;
        const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
        const inWindow = sinceMs === null || (!Number.isNaN(ts) && ts >= sinceMs);
        for (const raw of content) {
            if (!raw || typeof raw !== 'object')
                continue;
            const block = raw;
            if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
                names.set(block.id, block.name);
            }
            else if (block.type === 'tool_result' && inWindow) {
                results.push({ toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '', chars: resultChars(block.content) });
            }
        }
    }
    if (!parsed && !others.some((line) => parseEntry(line) !== null))
        return null;
    const totals = new Map();
    for (const r of results) {
        const name = names.get(r.toolUseId) ?? UNKNOWN_TOOL;
        const t = totals.get(name) ?? { calls: 0, chars: 0 };
        t.calls += 1;
        t.chars += r.chars;
        totals.set(name, t);
    }
    return [...totals]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([tool_name, t]) => ({
        tool_name,
        calls: t.calls,
        result_chars: t.chars,
        est_tokens: Math.ceil(t.chars / CHARS_PER_TOKEN),
    }));
}
function readTranscript(path) {
    if (path === '')
        return null;
    try {
        return readFileSync(path, 'utf8');
    }
    catch {
        return null;
    }
}
function runTarget(env) {
    const agentType = env.TMB_STOP_AGENT_TYPE ?? '';
    if (agentType === 'bro') {
        const session = env.TMB_STOP_SESSION_ID ?? '';
        if (session === '')
            return null;
        return {
            where: `agent_type = 'bro' AND task_id IS NULL AND session_id = '${sqlQuote(session)}'`,
            transcriptKey: 'transcript_path',
            sinceMs: null,
        };
    }
    if (agentType !== 'swe' && agentType !== 'code-reviewer')
        return null;
    const taskId = sqlInt(env.TMB_STOP_TASK_ID ?? '');
    const spawnId = env.TMB_STOP_SPAWN_ID ?? '';
    if (taskId === '' || spawnId === '')
        return null;
    const since = env.TMB_STOP_SINCE ?? '';
    const sinceMs = since === '' ? null : Date.parse(since);
    if (sinceMs !== null && Number.isNaN(sinceMs))
        return null;
    return {
        where: `task_id = ${taskId} AND agent_type = '${agentType}' AND spawn_id = '${sqlQuote(spawnId)}'`,
        transcriptKey: 'agent_transcript_path',
        sinceMs,
    };
}
/** The SQL that replaces run <runId>'s rows with <rows>. */
export function rewriteSql(runId, rows) {
    const del = `DELETE FROM agent_run_tool_output WHERE run_id = ${runId};`;
    if (rows.length === 0)
        return del;
    const values = rows
        .map((r) => `(${runId}, '${sqlQuote(r.tool_name)}', ${r.calls}, ${r.result_chars}, ${r.est_tokens})`)
        .join(',\n       ');
    return `${del}\nINSERT INTO agent_run_tool_output (run_id, tool_name, calls, result_chars, est_tokens)\nVALUES ${values};`;
}
export function toolOutputSize(payload, env) {
    try {
        const target = runTarget(env);
        if (target === null)
            return ALLOW;
        const db = dbPath(env);
        if (db === null || !haveSqlite(env))
            return ALLOW;
        const text = readTranscript(jqAlternatives(payload, [[target.transcriptKey]]));
        if (text === null)
            return ALLOW;
        const rows = toolOutputSizes(text, target.sinceMs);
        if (rows === null)
            return ALLOW;
        const found = gateRead(db, `SELECT id FROM agent_runs WHERE ${target.where} ORDER BY id DESC LIMIT 1;`, env);
        const runId = found === GATE_READ_ERROR ? '' : sqlInt(found);
        if (runId === '')
            return ALLOW;
        dbWrite(db, rewriteSql(runId, rows), { caller: GATE_NAME, env });
    }
    catch {
        // A recorder never fails its hook.
    }
    return ALLOW;
}
//# sourceMappingURL=tool-output-size.js.map