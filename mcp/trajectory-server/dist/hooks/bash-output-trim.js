/**
 * PostToolUse(Bash) gate (GH 2193), born in TypeScript: cuts the long output of
 * bro's routine read commands to its head and tail before it enters context,
 * since context is re-read on every later call and nothing in it can be evicted.
 *
 * Allowlist-based: it answers with hookSpecificOutput.updatedToolOutput, the
 * tool_response with only stdout replaced, when every condition holds, and
 * prints nothing otherwise:
 *   - bro's main thread: the payload carries no agent_id;
 *   - the command, read with a quote-aware tokenizer, has no unclosed quote,
 *     backtick, `$(`, `<`, `(`, `||`, lone `&` or redirect but a stage's
 *     trailing `2>&1` or `2>/dev/null`, and every `$` is `$NAME` or `${NAME}`;
 *   - every segment between top-level `&&`, `;` and newlines is `cd <word>`,
 *     `[export] NAME=<word>`, or a pipeline whose first stage is a read source
 *     (a filter, ls, echo, printf, diff, rg without --pre, a git read verb
 *     without --output, `gh {pr,issue,run} {view,list,checks,diff}`, or
 *     `sqlite3 -readonly` SELECT/WITH) and whose later stages are filters
 *     (head, tail, grep, sort without -o, uniq with one positional, cut, wc,
 *     nl, cat, tr, column, jq, print-only `sed -n`); program words and git/gh
 *     verbs are literal;
 *   - no pipeline ends in a bare `| cat`, the marker's escape to full output;
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
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const BOUNDARY = ' \t\n;&|()<>';
const SAFE_REDIRECTS = ['&1', '/dev/null'];
/**
 * The tokens of <command>: words with quotes removed, the top-level operators
 * `&&`, `;`, newline and `|`, and each `2>&1` or `2>/dev/null`; null on an
 * unclosed quote, a backtick, any `$` form but `$NAME` and `${NAME}`, `||`,
 * a lone `&`, `<`, `(`, `)`, or any other redirect.
 */
export function tokenize(command) {
    const tokens = [];
    let text = '';
    let literal = true;
    let started = -1;
    const end = (at) => {
        if (started >= 0)
            tokens.push({ kind: 'word', text, literal, raw: command.slice(started, at) });
        text = '';
        literal = true;
        started = -1;
    };
    const start = (at) => {
        if (started < 0)
            started = at;
    };
    const dollar = (i) => {
        const next = command[i + 1] ?? '';
        let j = i + 1;
        if (next === '{') {
            j = i + 2;
            if (!NAME_START.test(command[j] ?? ''))
                return -1;
            while (NAME_CHAR.test(command[j] ?? ''))
                j++;
            if (command[j] !== '}')
                return -1;
            j++;
        }
        else {
            if (!NAME_START.test(next))
                return -1;
            while (NAME_CHAR.test(command[j] ?? ''))
                j++;
        }
        text += command.slice(i, j);
        literal = false;
        return j - 1;
    };
    const afterJoin = () => {
        const last = tokens[tokens.length - 1];
        return last?.kind === 'op' && (last.op === '&&' || last.op === '|');
    };
    for (let i = 0; i < command.length; i++) {
        const c = command[i];
        if (c === ' ' || c === '\t') {
            end(i);
        }
        else if (c === '\n') {
            end(i);
            if (!afterJoin())
                tokens.push({ kind: 'op', op: '\n' });
        }
        else if (c === '#' && started < 0) {
            while (i + 1 < command.length && command[i + 1] !== '\n')
                i++;
        }
        else if (c === "'") {
            start(i);
            const close = command.indexOf("'", i + 1);
            if (close < 0)
                return null;
            text += command.slice(i + 1, close);
            i = close;
        }
        else if (c === '"') {
            start(i);
            let j = i + 1;
            for (; j < command.length && command[j] !== '"'; j++) {
                const d = command[j];
                if (d === '`')
                    return null;
                if (d === '\\' && j + 1 < command.length && '"\\$`\n'.includes(command[j + 1])) {
                    j++;
                    if (command[j] !== '\n')
                        text += command[j];
                }
                else if (d === '$') {
                    j = dollar(j);
                    if (j < 0)
                        return null;
                }
                else {
                    text += d;
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
                start(i - 1);
                text += command[i];
            }
        }
        else if (c === '$') {
            start(i);
            i = dollar(i);
            if (i < 0)
                return null;
        }
        else if (c === '&') {
            if (command[i + 1] !== '&')
                return null;
            end(i);
            tokens.push({ kind: 'op', op: '&&' });
            i++;
        }
        else if (c === '|') {
            if (command[i + 1] === '|' || command[i + 1] === '&')
                return null;
            end(i);
            tokens.push({ kind: 'op', op: '|' });
        }
        else if (c === ';') {
            end(i);
            tokens.push({ kind: 'op', op: ';' });
        }
        else if (c === '>') {
            if (started < 0 || command.slice(started, i) !== '2')
                return null;
            const target = SAFE_REDIRECTS.find((t) => command.startsWith(t, i + 1));
            const after = i + 1 + (target?.length ?? 0);
            if (target === undefined || (after < command.length && !BOUNDARY.includes(command[after])))
                return null;
            started = -1;
            text = '';
            tokens.push({ kind: 'redirect' });
            i = after - 1;
        }
        else if (c === '`' || c === '<' || c === '(' || c === ')') {
            return null;
        }
        else {
            start(i);
            text += c;
        }
    }
    end(command.length);
    return tokens;
}
const isAssignment = (w) => ASSIGNMENT.test(w.raw);
const PLAIN_FILTERS = new Set(['head', 'tail', 'grep', 'cut', 'wc', 'nl', 'cat', 'tr', 'column', 'jq']);
function sortRead(args) {
    return args.every((w) => !/^--output(=|$)/.test(w.text) && !/^-[^-]*o/.test(w.text));
}
function uniqRead(args) {
    let positional = 0;
    let options = true;
    for (const w of args) {
        if (options && w.text === '--')
            options = false;
        else if (!options || w.text === '-' || !w.text.startsWith('-'))
            positional++;
    }
    return positional <= 1;
}
const SED_ADDRESS = String.raw `(?:\d+|\$|/(?:[^/\\\n;]|\\[^\n;])*/)`;
const SED_PRINT = new RegExp(`^(?:${SED_ADDRESS}(?:,${SED_ADDRESS})?)?p$`);
/** Whether <script> is only `p` commands, each after an optional N, N,M, $ or /re/ address, joined by `;`. */
export function sedPrintOnly(script) {
    const commands = script.split(';').map((s) => s.trim()).filter((s) => s !== '');
    return commands.length > 0 && commands.every((s) => SED_PRINT.test(s));
}
function sedRead(args) {
    let quiet = false;
    const scripts = [];
    const positional = [];
    for (let i = 0; i < args.length; i++) {
        const w = args[i];
        if (w.text === '-e') {
            if (i + 1 >= args.length)
                return false;
            scripts.push(args[++i]);
        }
        else if (w.text === '--quiet' || w.text === '--silent') {
            quiet = true;
        }
        else if (/^-[nEr]+$/.test(w.text) && w.literal) {
            if (w.text.includes('n'))
                quiet = true;
        }
        else if (w.text.startsWith('-') && w.text !== '-') {
            return false;
        }
        else {
            positional.push(w);
        }
    }
    if (scripts.length === 0) {
        const script = positional.shift();
        if (script === undefined)
            return false;
        scripts.push(script);
    }
    return quiet && scripts.every((s) => s.literal && sedPrintOnly(s.text));
}
function filterRead(program, args) {
    if (PLAIN_FILTERS.has(program))
        return true;
    if (program === 'sort')
        return sortRead(args);
    if (program === 'uniq')
        return uniqRead(args);
    if (program === 'sed')
        return sedRead(args);
    return false;
}
const GIT_READS = new Set(['log', 'status', 'diff', 'show', 'grep', 'ls-files', 'rev-parse', 'merge-base', 'blame', 'shortlog', 'ls-tree']);
function gitRead(args) {
    let i = 0;
    if (args[0]?.text === '-C') {
        if (!args[0].literal || args.length < 2)
            return false;
        i = 2;
    }
    const verb = args[i];
    if (verb === undefined || !verb.literal || !GIT_READS.has(verb.text))
        return false;
    return args.slice(i + 1).every((w) => !/^--output(=|$)/.test(w.text));
}
const GH_GROUPS = new Set(['pr', 'issue', 'run']);
const GH_READS = new Set(['view', 'list', 'checks', 'diff']);
function ghRead(args) {
    const [group, verb] = args;
    return group !== undefined && verb !== undefined && group.literal && verb.literal && GH_GROUPS.has(group.text) && GH_READS.has(verb.text);
}
const SQLITE_FLAGS = new Set([
    'readonly', 'header', 'noheader', 'column', 'csv', 'json', 'line', 'list', 'box', 'table', 'markdown', 'html', 'tabs', 'batch', 'bail', 'echo', 'safe', 'ascii', 'quote', 'nofollow',
]);
const SQLITE_VALUE_FLAGS = new Set(['separator', 'newline', 'nullvalue']);
const READ_SQL = /^\s*(SELECT|WITH)\b/i;
/** sqlite3 -readonly <db> <sql>, the SQL last and starting with SELECT or WITH; any other flag, positional or dot-command rejects. */
function sqliteRead(args) {
    let readonly = false;
    const positional = [];
    for (let i = 0; i < args.length; i++) {
        const w = args[i];
        if (!w.text.startsWith('-')) {
            positional.push(i);
            continue;
        }
        if (!w.literal)
            return false;
        const flag = w.text.replace(/^--?/, '');
        if (flag === 'readonly')
            readonly = true;
        if (SQLITE_VALUE_FLAGS.has(flag)) {
            if (i + 1 >= args.length)
                return false;
            i++;
        }
        else if (!SQLITE_FLAGS.has(flag)) {
            return false;
        }
    }
    return readonly && positional.length === 2 && positional[1] === args.length - 1 && READ_SQL.test(args[args.length - 1].text);
}
const ECHOES = new Set(['ls', 'echo', 'printf', 'diff']);
function sourceRead(program, args) {
    if (ECHOES.has(program))
        return true;
    if (program === 'rg')
        return args.every((w) => !/^--pre(-glob)?(=|$)/.test(w.text));
    if (program === 'git')
        return gitRead(args);
    if (program === 'gh')
        return ghRead(args);
    if (program === 'sqlite3')
        return sqliteRead(args);
    return filterRead(program, args);
}
/** One pipeline stage: `NAME=<word>` prefixes, a literal program, its words, an optional trailing 2>&1 or 2>/dev/null. */
function stageRead(tokens, first) {
    let last = tokens.length;
    while (last > 0 && tokens[last - 1].kind === 'redirect')
        last--;
    const words = tokens.slice(0, last);
    if (!words.every((t) => t.kind === 'word'))
        return false;
    let at = 0;
    while (at < words.length && isAssignment(words[at]))
        at++;
    const program = words[at];
    if (program === undefined || !program.literal)
        return false;
    const args = words.slice(at + 1);
    return first ? sourceRead(program.text, args) : filterRead(program.text, args);
}
function stagesOf(tokens) {
    const stages = [[]];
    for (const t of tokens) {
        if (t.kind === 'op')
            stages.push([]);
        else
            stages[stages.length - 1].push(t);
    }
    return stages;
}
function segmentRead(tokens) {
    const words = tokens.filter((t) => t.kind === 'word');
    if (words.length === tokens.length) {
        if (words.length === 2 && words[0].literal && words[0].text === 'cd')
            return true;
        const assignment = words[0].literal && words[0].text === 'export' ? words.slice(1) : words;
        if (assignment.length === 1 && isAssignment(assignment[0]))
            return true;
    }
    return stagesOf(tokens).every((stage, i) => stage.length > 0 && stageRead(stage, i === 0));
}
function endsInBareCat(tokens) {
    const stages = stagesOf(tokens);
    const words = stages[stages.length - 1].filter((t) => t.kind === 'word');
    return stages.length > 1 && words.length === 1 && words[0].literal && words[0].text === 'cat';
}
function segmentsOf(command) {
    const tokens = tokenize(command);
    if (tokens === null)
        return null;
    const segments = [[]];
    for (const t of tokens) {
        if (t.kind === 'op' && t.op !== '|')
            segments.push([]);
        else
            segments[segments.length - 1].push(t);
    }
    return segments.filter((s) => s.length > 0);
}
/** Whether <command> is provably a read: `cd`, assignments and read pipelines chained by `&&`, `;` or newline. */
export function isRoutineRead(command) {
    const present = segmentsOf(command);
    return present !== null && present.length > 0 && present.every(segmentRead);
}
/** Whether some pipeline of <command> ends in a bare `| cat`, the marker's ask for the full output. */
export function asksFullOutput(command) {
    return segmentsOf(command)?.some(endsInBareCat) ?? false;
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
    if (stdout.length <= TRIM_ABOVE || !isRoutineRead(command) || asksFullOutput(command))
        return ALLOW;
    const trimmed = trimOutput(stdout);
    if (trimmed === null)
        return ALLOW;
    return { stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ...response, stdout: trimmed } } })}\n`, code: 0 };
};
//# sourceMappingURL=bash-output-trim.js.map