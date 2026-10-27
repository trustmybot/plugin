/**
 * UserPromptSubmit hook (GH 1692), the port of scripts/hooks/session-log-capture.sh:
 * appends {ts, event, prompt, additional_context} to
 * <project>/.claude/<plugin>/logs/<UTC date>-<session_id>.jsonl, the session
 * id from the payload, else the .current-session-id sentinel, else
 * <UTC timestamp>-<pid>, and prints {"continue": true}. Silent in a project
 * with no trajectory DB. Unlike the .sh, which logs an empty file without jq,
 * it reads the payload itself (decision 703).
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { ALLOW } from './gate.js';
import { dbPath } from './lib/db.js';
import { jqCompact, jqFieldOr, jqIndex, jqLiteralNumbers, jqMap, jqOr } from './lib/jq.js';
import { commandSubstitution, posixDirname, resolvePluginName } from './lib/project-env.js';
export const GATE_NAME = 'session-log-capture';
export const CONTINUE = '{"continue": true}\n';
function utcStamp(date) {
    const iso = date.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const day = iso.slice(0, 10);
    return { day, compact: `${day.replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`, iso };
}
function sentinelId(sentinel) {
    try {
        if (!statSync(sentinel).isFile())
            return '';
        return commandSubstitution(readFileSync(sentinel, 'utf8'));
    }
    catch {
        return '';
    }
}
/** The jq -c log lines of every payload value. */
export function logLines(input, ts) {
    return jqMap(input, (value) => `${jqCompact({
        ts,
        event: 'user_prompt',
        prompt: jqOr(jqIndex(value, 'prompt'), ''),
        additional_context: jqOr(jqIndex(value, 'additionalContext'), ''),
    })}\n`, jqLiteralNumbers).join('');
}
export function sessionLogCapture(payload, env) {
    try {
        const plugin = resolvePluginName(env);
        const echoed = `${commandSubstitution(payload)}\n`;
        const db = dbPath(env);
        if (db === null || db === '')
            return ALLOW;
        const workspace = posixDirname(posixDirname(posixDirname(db)));
        const logDir = `${workspace}/.claude/${plugin}/logs`;
        try {
            mkdirSync(logDir, { recursive: true });
        }
        catch {
            return ALLOW;
        }
        const now = utcStamp(new Date());
        const sessionId = commandSubstitution(jqFieldOr(echoed, 'session_id')) ||
            sentinelId(`${workspace}/.claude/${plugin}/.current-session-id`) ||
            `${now.compact}-${process.pid}`;
        try {
            appendFileSync(`${logDir}/${now.day}-${sessionId}.jsonl`, logLines(echoed, now.iso));
        }
        catch {
            /* as the .sh: the log line is best effort */
        }
        return { stdout: CONTINUE, code: 0 };
    }
    catch {
        return ALLOW;
    }
}
//# sourceMappingURL=session-log-capture.js.map