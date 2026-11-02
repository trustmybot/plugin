/**
 * PostToolUse(Bash) gate (GH 2193), born in TypeScript: cuts the long output of
 * bro's routine read commands to its head and tail before it enters context,
 * since context is re-read on every later call and nothing in it can be evicted.
 *
 * Allowlist-based: it answers with hookSpecificOutput.updatedToolOutput, the
 * tool_response with only stdout replaced, when every condition holds, and
 * prints nothing otherwise:
 *   - bro's main thread: the payload carries no agent_id;
 *   - one simple command, after optional VAR=value words, with no `;`, `&`,
 *     `|`, `>`, `<`, `$(` or backtick anywhere and no unquoted newline,
 *     parenthesis or comment;
 *   - `gh {pr,issue,run} {view,list,checks}` without --json, --jq, -q or
 *     --template (-t); `git [-C <path>] log|status`; `git [-C <path>] diff`
 *     with --stat; or `sqlite3 -readonly <db> <sql>` whose SQL starts with
 *     SELECT or WITH. Only git's -C path and sqlite3's db may hold a `$`
 *     expansion; every other word must be literal;
 *   - empty stderr, interrupted and isImage not true;
 *   - stdout longer than TRIM_ABOVE chars, its head and tail each keeping a
 *     whole line and together leaving some line out.
 * Never denies; any doubt passes the output unchanged.
 */
import { ALLOW } from './gate.js';
export const GATE_NAME = 'bash-output-trim';
export const TRIM_ABOVE = 4000;
export const HEAD_CHARS = 2400;
export const TAIL_CHARS = 800;
const FORBIDDEN = /[;&|<>`]|\$\(/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** The words of one simple command, quotes removed; null on anything it cannot be sure of. */
export function simpleWords(command) {
    if (FORBIDDEN.test(command))
        return null;
    const words = [];
    let text = '';
    let literal = true;
    let started = false;
    const end = () => {
        if (started)
            words.push({ text, literal });
        text = '';
        literal = true;
        started = false;
    };
    for (let i = 0; i < command.length; i++) {
        const c = command[i];
        if (c === ' ' || c === '\t') {
            end();
        }
        else if (c === '\n' || c === '\r' || c === '(' || c === ')' || (c === '#' && !started)) {
            return null;
        }
        else if (c === "'") {
            const close = command.indexOf("'", i + 1);
            if (close < 0)
                return null;
            text += command.slice(i + 1, close);
            started = true;
            i = close;
        }
        else if (c === '"') {
            started = true;
            let j = i + 1;
            for (; j < command.length && command[j] !== '"'; j++) {
                if (command[j] === '\\' && j + 1 < command.length && '"\\$`\n'.includes(command[j + 1])) {
                    j++;
                    if (command[j] !== '\n')
                        text += command[j];
                }
                else {
                    if (command[j] === '$')
                        literal = false;
                    text += command[j];
                }
            }
            if (j >= command.length)
                return null;
            i = j;
        }
        else if (c === '\\') {
            if (i + 1 >= command.length)
                return null;
            i++;
            if (command[i] !== '\n') {
                text += command[i];
                started = true;
            }
        }
        else {
            if (c === '$')
                literal = false;
            text += c;
            started = true;
        }
    }
    end();
    return words;
}
const GH_GROUPS = new Set(['pr', 'issue', 'run']);
const GH_READS = new Set(['view', 'list', 'checks']);
const GH_SHAPERS = /^(--json|--jq|--template)(=|$)/;
function ghRead(words) {
    if (words.length < 3 || !GH_GROUPS.has(words[1].text) || !GH_READS.has(words[2].text))
        return false;
    return words.every((w) => w.literal && !GH_SHAPERS.test(w.text) && !/^-[A-Za-z]*[qt]/.test(w.text));
}
function gitRead(words) {
    let i = 1;
    if (words[1]?.text === '-C') {
        if (!words[1].literal || words.length < 3)
            return false;
        i = 3;
    }
    const sub = words[i];
    const rest = words.slice(i + 1);
    if (sub === undefined || !sub.literal || !rest.every((w) => w.literal))
        return false;
    if (sub.text === 'log' || sub.text === 'status')
        return true;
    return sub.text === 'diff' && rest.some((w) => w.text === '--stat' || w.text.startsWith('--stat='));
}
const SQLITE_FLAGS = new Set([
    'readonly', 'header', 'noheader', 'column', 'csv', 'json', 'line', 'list', 'box', 'table', 'markdown', 'html', 'tabs', 'batch', 'bail', 'echo', 'safe', 'ascii', 'quote', 'nofollow',
]);
const SQLITE_VALUE_FLAGS = new Set(['separator', 'newline', 'nullvalue']);
const READ_SQL = /^\s*(SELECT|WITH)\b/i;
function sqliteRead(words) {
    let readonly = false;
    const positional = [];
    for (let i = 1; i < words.length; i++) {
        const w = words[i];
        if (!w.text.startsWith('-')) {
            positional.push(w);
            continue;
        }
        if (!w.literal)
            return false;
        const flag = w.text.replace(/^--?/, '');
        if (flag === 'readonly')
            readonly = true;
        if (SQLITE_VALUE_FLAGS.has(flag)) {
            if (i + 1 >= words.length || !words[i + 1].literal)
                return false;
            i++;
        }
        else if (!SQLITE_FLAGS.has(flag)) {
            return false;
        }
    }
    if (!readonly || positional.length !== 2)
        return false;
    const sql = positional[1];
    return sql.literal && READ_SQL.test(sql.text);
}
/** Whether <command> is one routine read the allowlist names. */
export function isRoutineRead(command) {
    const all = simpleWords(command);
    if (all === null)
        return false;
    let start = 0;
    while (start < all.length && ASSIGNMENT.test(all[start].text))
        start++;
    const words = all.slice(start);
    if (words.length === 0 || !words[0].literal)
        return false;
    switch (words[0].text) {
        case 'gh':
            return ghRead(words);
        case 'git':
            return gitRead(words);
        case 'sqlite3':
            return sqliteRead(words);
        default:
            return false;
    }
}
export function trimMarker(cutLines, cutChars, totalLines) {
    return `[bash-output-trim: cut ${cutLines} lines (${cutChars} chars) of ${totalLines} lines; rerun with a narrower command, or append | cat for the full output]`;
}
/** <stdout> cut to whole head lines within HEAD_CHARS and whole tail lines within TAIL_CHARS around one marker line; null when that would keep or drop everything. */
export function trimOutput(stdout) {
    const lines = stdout.split('\n');
    let head = 0;
    let headChars = 0;
    while (head < lines.length && headChars + lines[head].length + 1 <= HEAD_CHARS) {
        headChars += lines[head].length + 1;
        head++;
    }
    let tail = 0;
    let tailChars = 0;
    while (head + tail < lines.length && tailChars + lines[lines.length - 1 - tail].length + 1 <= TAIL_CHARS) {
        tailChars += lines[lines.length - 1 - tail].length + 1;
        tail++;
    }
    if (head === 0 || tail === 0 || head + tail >= lines.length)
        return null;
    const cut = lines.slice(head, lines.length - tail);
    const cutChars = cut.reduce((n, l) => n + l.length + 1, 0);
    const total = lines.length - (stdout.endsWith('\n') ? 1 : 0);
    return [...lines.slice(0, head), trimMarker(cut.length, cutChars, total), ...lines.slice(lines.length - tail)].join('\n');
}
const asRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
export const bashOutputTrim = (payload) => {
    let parsed;
    try {
        parsed = JSON.parse(payload);
    }
    catch {
        return ALLOW;
    }
    const p = asRecord(parsed);
    if (p === null || 'agent_id' in p || p.tool_name !== 'Bash')
        return ALLOW;
    const command = asRecord(p.tool_input)?.command;
    const response = asRecord(p.tool_response);
    if (typeof command !== 'string' || response === null)
        return ALLOW;
    const { stdout, stderr, interrupted, isImage } = response;
    if (typeof stdout !== 'string' || stderr !== '' || interrupted === true || isImage === true)
        return ALLOW;
    if (stdout.length <= TRIM_ABOVE || !isRoutineRead(command))
        return ALLOW;
    const trimmed = trimOutput(stdout);
    if (trimmed === null)
        return ALLOW;
    return { stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ...response, stdout: trimmed } } })}\n`, code: 0 };
};
//# sourceMappingURL=bash-output-trim.js.map