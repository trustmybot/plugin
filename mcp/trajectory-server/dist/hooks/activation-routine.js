/**
 * UserPromptSubmit hook (GH 1692), the port of scripts/hooks/activation-routine.sh:
 * on a bro turn (the prompt says "bro" as a word and is not a harness turn,
 * or the transcript holds sticky bro mode) it pre-fetches the onboarded flag
 * and the newest open issue and injects them as additionalContext, prefixed
 * by a HALT notice when pgrep finds no trajectory-server. Never blocks.
 *
 * The word test is grep's: `\b` and -i under the locale grep would run in
 * (ASCII word bytes in C; letters, digits and _ under UTF-8, where a
 * transcript line with invalid UTF-8 never matches). Unlike the .sh, it needs
 * neither jq nor the sqlite3 CLI (decision 703).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { isHarnessTurn } from './cmd-analysis/harness-turn.js';
import { ALLOW } from './gate.js';
import { dbPathAdvisory, haveSqlite, sqliteRo } from './lib/db.js';
import { jqCompact, jqFieldOr } from './lib/jq.js';
import { commandOnPath } from './lib/persona.js';
import { commandSubstitution, setlocaleUtf8 } from './lib/project-env.js';
export const GATE_NAME = 'activation-routine';
export const HALT_TEXT = '⛔ MCP trajectory-server is not running at this prompt — trajectory tools (state reads and writes) are unreachable. Bro: HALT. Do not dispatch work; load tmb_recovery §B and follow it. The read-only sqlite3 fallback (bro-sqlite-readonly.sh) stays available for emergency reads.';
const FIRST_RUN_LINE = 'onboarded=<no — FIRST CONTACT, auto-fire /onboard before any reply>';
const SESSION_ID_LINE = /^[A-Za-z0-9_-]{8,64}$/;
/** A grep -E pattern run line by line under C (bytes) or UTF-8 (code points). */
export class LocaleGrep {
    utf8;
    word;
    flags;
    constructor(utf8) {
        this.utf8 = utf8;
        this.word = utf8 ? '[\\p{L}\\p{Nd}_]' : '[A-Za-z0-9_]';
        this.flags = utf8 ? 'u' : '';
    }
    /** <source> with `\b` as grep's word boundary under this locale. */
    regex(source, ignoreCase = false) {
        const w = this.word;
        const boundary = `(?:(?<!${w})(?=${w})|(?<=${w})(?!${w}))`;
        const body = source.replace(/\\b/g, boundary).replace(/(^|[^\\])\./g, '$1[^\\n]');
        return new RegExp(body, `${this.flags}${ignoreCase ? 'i' : ''}`);
    }
    /** The lines of <bytes> as grep sees them: undefined for a line it cannot match. */
    lines(bytes) {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const out = [];
        let start = 0;
        while (start <= bytes.length) {
            let end = bytes.indexOf(0x0a, start);
            if (end < 0)
                end = bytes.length;
            if (end === bytes.length && start === end && start > 0)
                break;
            const line = bytes.subarray(start, end);
            if (!this.utf8)
                out.push(line.toString('latin1'));
            else {
                try {
                    out.push(decoder.decode(line));
                }
                catch {
                    out.push(undefined);
                }
            }
            start = end + 1;
        }
        return out;
    }
    test(bytes, re) {
        return this.lines(bytes).some((line) => line !== undefined && re.test(line));
    }
}
function readTranscript(path) {
    if (path === '')
        return null;
    try {
        if (!statSync(path).isFile())
            return null;
        return readFileSync(path);
    }
    catch {
        return null;
    }
}
export function isStickyBro(transcript, grep) {
    if (transcript === null)
        return false;
    if (grep.test(transcript, grep.regex('exit bro mode|stop being bro', true)))
        return false;
    return grep.test(transcript, grep.regex('Entering bro mode.')) || grep.test(transcript, grep.regex('@bro\\b', true));
}
export function saysBro(prompt, grep) {
    return !isHarnessTurn(prompt) && grep.test(Buffer.from(`${prompt}\n`, 'utf8'), grep.regex('\\bbro\\b', true));
}
function serverDown(env) {
    if (!commandOnPath('pgrep', env))
        return false;
    try {
        return spawnSync('pgrep', ['-f', 'trajectory-server/dist/index.js'], { env, stdio: 'ignore' }).status === 1;
    }
    catch {
        return false;
    }
}
const emit = (context) => ({
    stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } })}\n`,
    code: 0,
});
export function activationContext(onboardedCount, pending) {
    let pendingLine = 'pending=<none>';
    if (pending !== '') {
        const bar = pending.indexOf('|');
        const id = bar < 0 ? pending : pending.slice(0, bar);
        const objective = bar < 0 ? pending : pending.slice(bar + 1);
        pendingLine = `pending=#${id}: ${objective}`;
    }
    if (onboardedCount === '0') {
        return `[tmb activation routine — pre-fetched by hook] ${FIRST_RUN_LINE}. ACTION: this is the user's first contact in this project — call \`onboard_state_get(agent='bro')\` and run the \`/onboard\` slash command flow IMMEDIATELY before any reply (auto-fire doctrine, no permission gate). Do not greet, do not answer the user's prompt, do not call issue_resume separately — onboard_state_get returns everything you need. ${pendingLine}`;
    }
    return `[tmb activation routine — pre-fetched by hook] onboarded=yes. Use this to compose the welcome banner; do NOT also call issue_resume — they would be redundant duplicate reads. ${pendingLine}`;
}
export function activationRoutine(payload, env) {
    try {
        const echoed = `${commandSubstitution(payload)}\n`;
        const field = (key) => commandSubstitution(jqFieldOr(echoed, key));
        const prompt = field('prompt');
        const grep = new LocaleGrep(setlocaleUtf8(env));
        if (!saysBro(prompt, grep) && !isStickyBro(readTranscript(field('transcript_path')), grep))
            return ALLOW;
        const halt = serverDown(env) ? HALT_TEXT : '';
        const haltOnly = () => (halt !== '' ? emit(halt) : ALLOW);
        const db = dbPathAdvisory(GATE_NAME, env, (line) => process.stderr.write(`${line}\n`));
        if (db === null || !haveSqlite(env))
            return haltOnly();
        const onboarded = sqliteRo(db, "SELECT COUNT(*) FROM plugin_config WHERE key='onboarded' AND value_json='true';", env);
        const pending = sqliteRo(db, "SELECT id, COALESCE(objective, '') FROM issues WHERE status='open' AND id > 0 ORDER BY id DESC LIMIT 1;", env);
        let context = activationContext(onboarded, pending);
        if (halt !== '')
            context = `${halt} ${context}`;
        const sessionId = field('session_id');
        if (sessionId.split('\n').some((line) => SESSION_ID_LINE.test(line)))
            context = `${context} session_id=${sessionId}`;
        return emit(context);
    }
    catch {
        return ALLOW;
    }
}
//# sourceMappingURL=activation-routine.js.map