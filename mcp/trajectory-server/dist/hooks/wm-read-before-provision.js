/**
 * PreToolUse(task_provision) gate (GH 2329, GH 2958), born in TypeScript: bro
 * reads the world model on the code a task touches before it plans the task
 * (tmb_planning §1).
 *
 * An allowlist deny. The call is allowed silently only when the session
 * transcript (`transcript_path`) holds an assistant tool_use of a world-model
 * read tool, timestamped within the last WINDOW_MINUTES, that covers one of
 * `tool_input.task.files[]`: a files[] path appears in the read's input or in
 * its tool_result text (same tool_use_id), or the read's `path` input and a
 * files[] entry are one a directory prefix of the other. A task with no
 * files[] is allowed on any recent read. Every other call is denied with one
 * `wm_read_missing_before_provision` audit row, an unreadable transcript
 * included. The one exception fires where there is no world model to read:
 * a repo with no `wm_files` rows, or a DB that does not resolve, is allowed
 * with an additionalContext nudge. A failed audit write never changes the
 * answer.
 */
import { readFileSync } from 'node:fs';
import { ALLOW } from './gate.js';
import { auditAppend } from './lib/audit.js';
import { dbPath, GATE_READ_ERROR, gateRead, sqlQuote } from './lib/db.js';
import { denyResult } from './lib/deny.js';
import { jqCompact } from './lib/jq.js';
export const GATE_NAME = 'wm-read-before-provision';
export const WINDOW_MINUTES = 60;
export const EVENT_TYPE = 'wm_read_missing_before_provision';
const WINDOW_MS = WINDOW_MINUTES * 60_000;
const PROVISION_TOOL = /trajectory-server__task_provision$/;
const WM_READ_TOOL = /trajectory-server__(world_model_get|world_model_search|world_model_symbol|world_model_concepts|world_model_concept_get|scope_suggest)$/;
const WM_READ_HINT = /trajectory-server__(world_model_|scope_suggest)/;
const PATH_CHAR = /[A-Za-z0-9_.-]/;
function parseLine(line) {
    try {
        const v = JSON.parse(line);
        return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
    }
    catch {
        return null;
    }
}
function asWmRead(block) {
    if (block === null || typeof block !== 'object')
        return null;
    const b = block;
    if (b.type !== 'tool_use' || typeof b.name !== 'string' || !WM_READ_TOOL.test(b.name))
        return null;
    return { id: typeof b.id === 'string' && b.id !== '' ? b.id : null, input: b.input };
}
/** The assistant world-model read tool_uses of <transcript> timestamped in [now - window, now], newest first. */
export function recentWmReads(transcript, nowMs) {
    const reads = [];
    const lines = transcript.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!WM_READ_HINT.test(line))
            continue;
        const entry = parseLine(line);
        if (entry === null || entry.type !== 'assistant' || typeof entry.timestamp !== 'string')
            continue;
        const at = Date.parse(entry.timestamp);
        if (!Number.isFinite(at) || at > nowMs || nowMs - at > WINDOW_MS)
            continue;
        const content = entry.message?.content;
        if (!Array.isArray(content))
            continue;
        for (const block of content) {
            const read = asWmRead(block);
            if (read !== null)
                reads.push(read);
        }
    }
    return reads;
}
/** Whether <transcript> holds an assistant world-model read tool_use timestamped in [now - window, now]. */
export function hasRecentWmRead(transcript, nowMs) {
    return recentWmReads(transcript, nowMs).length > 0;
}
function blockText(block) {
    if (typeof block === 'string')
        return block;
    if (block === null || typeof block !== 'object')
        return '';
    const text = block.text;
    return typeof text === 'string' ? text : '';
}
/** The text of every tool_result block in <transcript> answering one of <ids>, keyed by tool_use_id. */
function toolResultTexts(transcript, ids) {
    const texts = new Map();
    if (ids.size === 0)
        return texts;
    for (const line of transcript.split('\n')) {
        if (!line.includes('tool_result') || ![...ids].some((id) => line.includes(id)))
            continue;
        const content = parseLine(line)?.message?.content;
        if (!Array.isArray(content))
            continue;
        for (const block of content) {
            if (block === null || typeof block !== 'object')
                continue;
            const b = block;
            if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string' || !ids.has(b.tool_use_id))
                continue;
            const text = Array.isArray(b.content) ? b.content.map(blockText).join('\n') : blockText(b.content);
            texts.set(b.tool_use_id, `${texts.get(b.tool_use_id) ?? ''}\n${text}`);
        }
    }
    return texts;
}
/** <path> repo-relative and posix as files[] entries compare: `\` as `/`, no leading `./`, no trailing `/`. */
export function normalizePath(path) {
    return path.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}
function isDirPrefix(dir, path) {
    return path === dir || path.startsWith(`${dir}/`);
}
/** Whether <text> names <entry> as a whole path: no path character before it, none but `/` after it. */
function mentions(text, entry) {
    for (let at = text.indexOf(entry); at >= 0; at = text.indexOf(entry, at + 1)) {
        const before = at === 0 ? '' : text[at - 1];
        const after = text[at + entry.length] ?? '';
        if (!(before === '/' || PATH_CHAR.test(before)) && !PATH_CHAR.test(after))
            return true;
    }
    return false;
}
function readPath(input) {
    if (input === null || typeof input !== 'object')
        return '';
    const path = input.path;
    return typeof path === 'string' ? normalizePath(path) : '';
}
/** Whether <read> covers one of <files> (normalized entries), its tool_result text being <resultText>. */
export function readCovers(read, resultText, files) {
    if (files.some((f) => f === ''))
        return true;
    const path = readPath(read.input);
    if (path !== '' && files.some((f) => isDirPrefix(path, f) || isDirPrefix(f, path)))
        return true;
    const inputText = JSON.stringify(read.input ?? null);
    return files.some((f) => mentions(inputText, f) || mentions(resultText, f));
}
function taskFiles(payload) {
    const files = payload.tool_input?.task?.files;
    if (!Array.isArray(files))
        return [];
    return files.filter((f) => typeof f === 'string' && f.trim() !== '');
}
/** Why <transcript> admits no provision of a task touching <files>, or null when it does. */
export function missingReason(transcript, files, nowMs) {
    if (transcript === null)
        return 'transcript_unreadable';
    const reads = recentWmReads(transcript, nowMs);
    if (reads.length === 0)
        return 'no_read';
    if (files.length === 0)
        return null;
    const entries = files.map(normalizePath);
    const ids = new Set(reads.flatMap((r) => (r.id === null ? [] : [r.id])));
    const results = toolResultTexts(transcript, ids);
    return reads.some((r) => readCovers(r, r.id === null ? '' : (results.get(r.id) ?? ''), entries)) ? null : 'no_covering_read';
}
function readTranscript(path) {
    if (typeof path !== 'string' || path === '')
        return null;
    try {
        return readFileSync(path, 'utf8');
    }
    catch {
        return null;
    }
}
function seenText(reason) {
    if (reason === 'transcript_unreadable')
        return 'this session\'s transcript could not be read, so no world-model read is on record';
    if (reason === 'no_covering_read')
        return `no world-model read in this session's last ${WINDOW_MINUTES} minutes that covers the task's files[]`;
    return `no world-model read in this session's last ${WINDOW_MINUTES} minutes`;
}
export function nudge(reason) {
    return (`TMB: task_provision with ${seenText(reason)}. Read the world model before planning a task (tmb_planning §1): ` +
        'world_model_get, world_model_search, world_model_symbol or scope_suggest on the code the task touches, so the spec names real paths and symbols.');
}
/** The directory of <entry>: itself when it ends with `/`, else its parent ('' at the repo root). */
function entryDir(entry) {
    const normalized = normalizePath(entry);
    if (/[\\/]$/.test(entry))
        return normalized;
    const slash = normalized.lastIndexOf('/');
    return slash >= 0 ? normalized.slice(0, slash) : '';
}
/** The world_model_get call that reads the first files[] entry's directory. */
export function readCall(repo, files) {
    const args = [...(repo === null ? [] : [`repo='${repo}'`]), ...(files.length === 0 ? [] : [`path='${entryDir(files[0])}'`])];
    return `world_model_get(${args.join(', ')})`;
}
function denyReason(reason) {
    return (`BLOCKED: ${GATE_NAME}: task_provision with ${seenText(reason)}. Read the world model on the code this task touches before planning it ` +
        '(tmb_planning §1), so the spec names real paths and symbols, then call task_provision again.');
}
function issueIdOf(value) {
    const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
    return /^[0-9]+$/.test(text) ? text : '-1';
}
function firstRow(db, sql, env) {
    const out = gateRead(db, sql, env);
    return out === GATE_READ_ERROR ? null : (out.split('\n')[0] ?? '');
}
/** The repo the provision lands in, as task_provision resolves it: task.repo, else the issue's repo, else the sole registered repo. */
function taskRepo(db, payload, env) {
    const given = payload.tool_input?.task?.repo;
    if (typeof given === 'string' && given !== '')
        return given;
    if (db === null)
        return null;
    const issueRepo = firstRow(db, `SELECT COALESCE(repo, '') FROM issues WHERE id = ${issueIdOf(payload.tool_input?.issue_id)};`, env);
    if (issueRepo)
        return issueRepo;
    const sole = firstRow(db, `SELECT name FROM repos WHERE (SELECT COUNT(*) FROM repos) = 1;`, env);
    return sole || null;
}
/** Whether a world model exists to read: false when the DB does not resolve or holds no wm_files row for <repo>. */
function worldModelBuilt(db, repo, env) {
    if (db === null)
        return false;
    const where = repo === null ? '' : ` WHERE repo = '${sqlQuote(repo)}'`;
    const row = firstRow(db, `SELECT EXISTS (SELECT 1 FROM wm_files${where});`, env);
    return row === '1';
}
function audit(db, payload, tool, reason, env) {
    try {
        if (db === null)
            return;
        const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
        const content = { tool, session_id: sessionId, window_minutes: WINDOW_MINUTES, reason };
        const r = auditAppend(db, {
            issueId: issueIdOf(payload.tool_input?.issue_id),
            branchId: '',
            fromNode: `hook:${GATE_NAME}`,
            eventType: 'wm_read_missing_before_provision',
            summary: `task_provision denied: no world-model read covering its files in the last ${WINDOW_MINUTES} min (${reason})`,
            contentJson: JSON.stringify(content),
        }, { caller: GATE_NAME, env });
        if (!r.ok)
            process.stderr.write(`${r.error}\n`);
    }
    catch (e) {
        process.stderr.write(`${GATE_NAME}: audit write failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
}
export const wmReadBeforeProvision = (raw, env) => {
    let payload;
    try {
        payload = JSON.parse(raw);
    }
    catch {
        return ALLOW;
    }
    if (payload === null || typeof payload !== 'object')
        return ALLOW;
    const tool = typeof payload.tool_name === 'string' ? payload.tool_name : '';
    if (!PROVISION_TOOL.test(tool))
        return ALLOW;
    const files = taskFiles(payload);
    const reason = missingReason(readTranscript(payload.transcript_path), files, Date.now());
    if (reason === null)
        return ALLOW;
    const db = dbPath(env);
    const repo = taskRepo(db, payload, env);
    if (!worldModelBuilt(db, repo, env)) {
        const output = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: nudge(reason) } };
        return { stdout: `${jqCompact(output)}\n`, code: 0 };
    }
    audit(db, payload, tool, reason, env);
    return denyResult(denyReason(reason), { allowed: readCall(repo, files) });
};
//# sourceMappingURL=wm-read-before-provision.js.map