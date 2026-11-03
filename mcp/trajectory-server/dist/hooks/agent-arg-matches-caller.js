/**
 * PreToolUse gate of the trajectory-gates chain (GH 1692), the port of
 * scripts/hooks/agent-arg-matches-caller.sh: a trajectory-server tool call's
 * `agent` argument must name the real caller, the payload's agent_type (else
 * subagent_type), or bro when the payload carries none. Both sides drop a
 * plugin prefix and compare lowercased as tr '[:upper:]' '[:lower:]' does in
 * the hook's locale. No agent argument allows. A mismatch denies naming the
 * tool and both values, and writes one agent_arg_mismatch audit row on the
 * task's issue (else issue -1) when the DB reads; the decision never depends
 * on the DB.
 *
 * Unlike the .sh, it needs neither jq nor the sqlite3 CLI: without jq the .sh
 * exits 1 and the call goes through, without sqlite3 it writes no audit row,
 * where this denies a mismatch and records it (decision 703).
 */
import { ALLOW } from './gate.js';
import { auditAppend } from './lib/audit.js';
import { dbPath, dbState, sqlInt, sqliteRo } from './lib/db.js';
import { jqCompact } from './lib/jq.js';
import { jqAlt, jqGet, jqInput, jqNumber, jqTostring, JqUnindexable } from './lib/jq-raw.js';
import { setlocaleUtf8 } from './lib/project-env.js';
import { normalizeRole } from './lib/role.js';
export const GATE_NAME = 'agent-arg-matches-caller';
const WRITE_RUN_BUDGET_MS = '2500';
const TRAJECTORY_TOOL = /^mcp__.*trajectory-server__/s;
const TOOL_PREFIX = 'trajectory-server__';
/** Uppercase letters macOS libc does not map (Unicode 16 additions) or maps unlike ICU. */
const TR_UNMAPPED = /[ᲉꟋꟌ꟎꟒꟔ꟚꟜ\u{10D50}-\u{10D65}\u{16EA0}-\u{16EB8}]/u;
const TR_OVERRIDES = new Map([
    ['İ', 'i'],
    ['Ύ', 'ώ'],
    ['Ώ', 'Ϗ'],
]);
/** `tr '[:upper:]' '[:lower:]'` on macOS: ASCII in C, libc's towlower of each uppercase letter under a UTF-8 locale. */
export function trLower(text, env) {
    if (!setlocaleUtf8(env))
        return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
    return text.replace(/\p{Lu}/gu, (c) => {
        const mapped = TR_OVERRIDES.get(c);
        if (mapped !== undefined)
            return mapped;
        if (TR_UNMAPPED.test(c))
            return c;
        const lower = c.toLowerCase();
        return [...lower].length === 1 ? lower : c;
    });
}
function gsubString(value) {
    if (typeof value !== 'string')
        throw new JqUnindexable('cannot be matched, as it is not a string');
    return value.replace(/[\n\r\x1f]/g, ' ').replace(/\0/g, '');
}
function fieldsOf(value) {
    return {
        tool: gsubString(jqAlt(jqGet(value, 'tool_name'), '')),
        given: gsubString(jqTostring(jqAlt(jqGet(value, 'tool_input', 'agent'), ''))),
        actual: gsubString(jqAlt(jqAlt(jqGet(value, 'agent_type'), jqGet(value, 'subagent_type')), '')),
        task: gsubString(jqTostring(jqAlt(jqGet(value, 'tool_input', 'task_id'), ''))),
    };
}
/**
 * The .sh's FIELDS read: the first line jq prints, or null when jq exits
 * non-zero (a parse error, or the stream's last value errors), which allows.
 */
export function callFields(payload) {
    const input = jqInput(payload);
    if (!input.complete)
        return null;
    let first = null;
    let lastFailed = false;
    for (const value of input.values) {
        try {
            const f = fieldsOf(value);
            first ??= f;
            lastFailed = false;
        }
        catch (e) {
            if (!(e instanceof JqUnindexable))
                throw e;
            lastFailed = true;
        }
    }
    return lastFailed ? null : first;
}
export function denyJson(reason) {
    return `${jqCompact({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    })}\n`;
}
function recordMismatch(env, toolShort, f, actual, caller) {
    const db = dbPath(env);
    if (db === null)
        return;
    const taskId = sqlInt(f.task);
    let issue = '-1';
    if (taskId !== '') {
        const found = sqlInt(sqliteRo(db, `SELECT issue_id FROM tasks WHERE id = ${taskId};`, env));
        if (found !== '')
            issue = found;
    }
    const content = jqCompact({ tool: toolShort, given: f.given, actual, task_id: taskId === '' ? null : jqNumber(taskId) });
    auditAppend(db, {
        issueId: issue,
        branchId: '',
        fromNode: `hook:${GATE_NAME}`,
        eventType: 'agent_arg_mismatch',
        summary: `${toolShort}: agent='${f.given}' but the caller is ${caller}`,
        contentJson: content,
    }, { env: { ...env, TMB_DB_WRITE_RUN_BUDGET_MS: WRITE_RUN_BUDGET_MS }, caller: GATE_NAME });
}
export const agentArgMatchesCaller = (payload, env) => {
    const f = callFields(payload);
    if (f === null || f.given === '')
        return ALLOW;
    if (!TRAJECTORY_TOOL.test(f.tool))
        return ALLOW;
    const given = trLower(normalizeRole(f.given), env);
    const actual = trLower(normalizeRole(f.actual), env) || 'bro';
    if (given === actual)
        return ALLOW;
    const toolShort = f.tool.slice(f.tool.lastIndexOf(TOOL_PREFIX) + TOOL_PREFIX.length);
    const caller = f.actual === '' ? 'the main session (bro)' : `a ${actual} subagent`;
    dbPath(env, (line) => process.stderr.write(`${line}\n`));
    if (dbState(env) === 'ok')
        recordMismatch(env, toolShort, f, actual, caller);
    return {
        stdout: denyJson(`BLOCKED: ${toolShort} called with agent='${f.given}' but the caller is ${caller}; pass agent='${actual}'.`),
        code: 0,
    };
};
//# sourceMappingURL=agent-arg-matches-caller.js.map