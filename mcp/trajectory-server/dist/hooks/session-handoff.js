/**
 * PreCompact gate and SessionStart consumer (GH 2275): restores bro's state
 * from the DB after Claude Code compacts a bro session. Before each
 * compaction, manual or auto, the PreCompact gate upserts the session's
 * session_handoffs row when the session has a bro agent_runs row, re-arming a
 * row an earlier compaction consumed. The SessionStart with source 'compact'
 * that follows takes that same session's row in session-start-persona's
 * context: the issue, its live tasks and its newest decision. The gate never
 * blocks and never prints, because blocking an auto compact fails the
 * request: any error exits 0 with no output. Bypass:
 * TMB_DISABLE_SESSION_HANDOFF_HOOK=1.
 *
 * bro-turn-usage writes the bro row asynchronously, so a compaction before a
 * session's first turn has ended records nothing.
 */
import { SESSION_ID_LINE } from './activation-routine.js';
import { ALLOW } from './gate.js';
import { dbWrite } from './lib/audit.js';
import { dbPath, sqlQuote } from './lib/db.js';
export const GATE_NAME = 'session-handoff';
const LIVE_TASK_LIMIT = 20;
const LIVE_TASK_STATUSES = "'pending','running','needs_validation','completed','escalated'";
const CONSUME_SOURCE = 'compact';
const HOOK_CONTEXT_CAP = 10_000;
const CONTEXT_SEPARATOR = '\n\n';
const MIN_BLOCK_CHARS = 200;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
function disabled(env) {
    return (env.TMB_DISABLE_SESSION_HANDOFF_HOOK ?? '0') === '1';
}
function payloadObject(payload) {
    const value = JSON.parse(payload);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function validSessionId(value) {
    return typeof value === 'string' && SESSION_ID_LINE.test(value);
}
function validCwd(value) {
    return typeof value === 'string' && value !== '' && !value.includes('\0');
}
function truncated(text, max) {
    if (text.length <= max)
        return text;
    const code = text.charCodeAt(max - 1);
    return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}
function upsertSql(sessionId, cwd) {
    const issue = `(SELECT issue_id FROM agent_runs WHERE session_id = '${sessionId}' AND agent_type <> 'bro' AND issue_id IS NOT NULL ORDER BY id DESC LIMIT 1)`;
    return `
INSERT INTO session_handoffs (session_id, cwd, issue_id, summary, created_at, updated_at)
SELECT '${sessionId}', '${sqlQuote(cwd)}', ${issue}, NULL, ${NOW}, ${NOW}
 WHERE EXISTS (SELECT 1 FROM agent_runs WHERE agent_type = 'bro' AND session_id = '${sessionId}')
ON CONFLICT (session_id) DO UPDATE
   SET cwd = excluded.cwd, issue_id = excluded.issue_id, summary = NULL, updated_at = excluded.updated_at,
       consumed_at = NULL, consumed_by_session = NULL;
`;
}
export const sessionHandoff = (payload, env) => {
    if (disabled(env))
        return ALLOW;
    try {
        const input = payloadObject(payload);
        const sessionId = input.session_id;
        const cwd = input.cwd;
        if (!validSessionId(sessionId) || !validCwd(cwd))
            return ALLOW;
        const db = dbPath(env);
        if (db !== null)
            dbWrite(db, upsertSql(sessionId, cwd), { env, caller: GATE_NAME });
        return ALLOW;
    }
    catch {
        return ALLOW;
    }
};
function consumeSql(sessionId) {
    const issueOfRow = 'session_handoffs.issue_id';
    const newestDecision = (column) => `(SELECT ${column} FROM discussions WHERE issue_id = ${issueOfRow} AND kind = 'decision' ORDER BY id DESC LIMIT 1)`;
    return `
UPDATE session_handoffs
   SET consumed_at = ${NOW}, consumed_by_session = '${sessionId}'
 WHERE session_id = '${sessionId}' AND consumed_at IS NULL
RETURNING json_object(
  'issue_id', issue_id,
  'objective', (SELECT objective FROM issues WHERE id = ${issueOfRow}),
  'issue_status', (SELECT status FROM issues WHERE id = ${issueOfRow}),
  'tasks', json((SELECT json_group_array(json_object('id', t.id, 'status', t.status, 'title', t.title))
                   FROM (SELECT id, status, title FROM tasks
                          WHERE issue_id = ${issueOfRow} AND status IN (${LIVE_TASK_STATUSES})
                          ORDER BY id DESC LIMIT ${LIVE_TASK_LIMIT}) t)),
  'decision_id', ${newestDecision('id')},
  'decision', ${newestDecision('body')});
`;
}
function handoffBlock(h) {
    const lines = ['[Compaction restore: Claude Code compacted this bro session; its state below was read from the DB just now]'];
    if (h.issue_id === null)
        lines.push('No issue was recorded for this session.');
    else {
        const status = h.issue_status === null || h.issue_status === 'open' ? '' : ` (status: ${h.issue_status})`;
        lines.push(`Issue #${h.issue_id}${status}: ${h.objective ?? ''}`);
    }
    if (h.tasks.length > 0) {
        lines.push('Its open tasks. Use task_brief on them:');
        for (const t of h.tasks)
            lines.push(`- #${t.id} [${t.status}] ${t.title}`);
    }
    if (h.decision !== null) {
        lines.push(`Its newest decision (discussion #${h.decision_id ?? '?'}):`);
        lines.push(h.decision.replace(/^/gm, '> '));
    }
    return lines.join('\n');
}
/** <context> with the state this session recorded before its compaction appended, within the hook's cap; <context> itself on any other source, when there is none or on any failure. */
export function withHandoff(context, payload, env) {
    if (disabled(env))
        return context;
    try {
        const input = payloadObject(payload);
        const sessionId = input.session_id;
        if (input.source !== CONSUME_SOURCE || !validSessionId(sessionId) || !validCwd(input.cwd))
            return context;
        const room = HOOK_CONTEXT_CAP - context.length - CONTEXT_SEPARATOR.length;
        if (room < MIN_BLOCK_CHARS)
            return context;
        const db = dbPath(env);
        if (db === null)
            return context;
        const written = dbWrite(db, consumeSql(sessionId), { env, caller: GATE_NAME });
        if (!written.ok || written.stdout.trim() === '')
            return context;
        const block = handoffBlock(JSON.parse(written.stdout));
        return `${context}${CONTEXT_SEPARATOR}${truncated(block, room)}`;
    }
    catch {
        return context;
    }
}
//# sourceMappingURL=session-handoff.js.map