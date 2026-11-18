/**
 * PreToolUse Bash nudge (GH 1907): when swe runs a raw test command, tell it
 * through additionalContext to rerun it through dist/test-run.js, which keeps
 * only the failures and the summary line. Advisory: it never denies, asks or
 * rewrites the command. Bypass: TMB_SKIP_TEST_RUN_NUDGE=1.
 *
 * Detection is a denylist of known forms on purpose (a miss only drops a
 * nudge): `node [--flags] --test`, `bun test` / `bun run test`, `npm test` /
 * `npm run test`, `vitest`, `jest`, `pytest`, and `bash|sh` of a script under a
 * `test/` or `tests/` dir or named `*.test.sh`, in any statement of the
 * command. The command is split on its unquoted `;`, `&`, `|`, newlines,
 * parens and backticks; a `bash|sh -c '<cmd>'` is judged by its `<cmd>`.
 */
import { ALLOW } from './gate.js';
import { jqPath, jqRawOr, preToolContext } from './lib/lint-shell.js';
import { agentRole } from './lib/role.js';
export const GATE_NAME = 'test-run-nudge';
const WRAPPER_RE = /test-run\.(js|ts)/;
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SCRIPT_RE = /\.[cm]?[jt]s$/;
const TEST_SCRIPT_RE = /(^|\/)tests?\/.*\.sh$|\.test\.sh$/;
const RUNNERS = new Set(['vitest', 'jest', 'pytest']);
const LAUNCHERS = new Set(['npx', 'bunx', 'pnpx', 'env', 'time', 'exec', 'nice']);
const SHELLS = new Set(['bash', 'sh']);
const MAX_DEPTH = 2;
/** The command's statements, each its words with quotes removed. */
function statements(command) {
    const out = [];
    let words = [];
    let word = null;
    let quote = '';
    const endWord = () => {
        if (word !== null)
            words.push(word);
        word = null;
    };
    const endStatement = () => {
        endWord();
        if (words.length > 0)
            out.push(words);
        words = [];
    };
    for (let i = 0; i < command.length; i++) {
        const c = command[i];
        if (quote !== '') {
            if (c === quote)
                quote = '';
            else if (c === '\\' && quote === '"' && i + 1 < command.length)
                word = (word ?? '') + command[++i];
            else
                word = (word ?? '') + c;
        }
        else if (c === "'" || c === '"') {
            quote = c;
            word ??= '';
        }
        else if (c === '\\' && i + 1 < command.length) {
            word = (word ?? '') + command[++i];
        }
        else if (';&|()\n`'.includes(c)) {
            endStatement();
        }
        else if (c === ' ' || c === '\t') {
            endWord();
        }
        else {
            word = (word ?? '') + c;
        }
    }
    endStatement();
    return out;
}
const base = (word) => word.slice(word.lastIndexOf('/') + 1);
/** The words from the program on: leading assignments and launchers (`npx`, `env`, `timeout 60`, …) dropped. */
function program(words) {
    let i = 0;
    while (i < words.length) {
        const w = words[i];
        if (ASSIGNMENT_RE.test(w) || LAUNCHERS.has(base(w)) || (i > 0 && LAUNCHERS.has(base(words[i - 1])) && w.startsWith('-')))
            i++;
        else if (base(w) === 'timeout')
            i += 2;
        else
            break;
    }
    return words.slice(i);
}
function nodeTest(args) {
    const at = args.indexOf('--test');
    return at >= 0 && !args.slice(0, at).some((a) => !a.startsWith('-') && SCRIPT_RE.test(a));
}
function rawTest(words, depth) {
    const [head, ...args] = program(words);
    if (head === undefined)
        return false;
    const name = base(head);
    if (TEST_SCRIPT_RE.test(head) && head.includes('/'))
        return true;
    if (RUNNERS.has(name))
        return true;
    if (name === 'node')
        return nodeTest(args);
    if (/^python3?$/.test(name))
        return args[0] === '-m' && args[1] === 'pytest';
    if (name === 'bun' || name === 'npm')
        return args[0] === 'test' || (args[0] === 'run' && args[1] === 'test');
    if (SHELLS.has(name)) {
        const c = args.indexOf('-c');
        if (c >= 0)
            return depth < MAX_DEPTH && args[c + 1] !== undefined && statements(args[c + 1]).some((s) => rawTest(s, depth + 1));
        const script = args.find((a) => !a.startsWith('-'));
        return script !== undefined && TEST_SCRIPT_RE.test(script);
    }
    return false;
}
export function runsRawTest(command) {
    return !WRAPPER_RE.test(command) && statements(command).some((s) => rawTest(s, 0));
}
export const testRunNudge = (payload, env) => {
    if ((env.TMB_SKIP_TEST_RUN_NUDGE ?? '0') === '1')
        return ALLOW;
    if (jqRawOr(payload, [jqPath('tool_name')]) !== 'Bash')
        return ALLOW;
    if (agentRole(payload) !== 'swe')
        return ALLOW;
    if (!runsRawTest(jqRawOr(payload, [jqPath('tool_input', 'command')])))
        return ALLOW;
    const root = env.CLAUDE_PLUGIN_ROOT || '${CLAUDE_PLUGIN_ROOT}';
    const ctx = `test-run-nudge: rerun this test command as node "${root}/mcp/trajectory-server/dist/test-run.js" -- <argv...> ` +
        `(or -- bash -c '<cmd>' for shell syntax): it prints one summary line plus each failure and keeps the full log at its log= path.\n` +
        'Set TMB_SKIP_TEST_RUN_NUDGE=1 to bypass.';
    return { stdout: preToolContext(ctx), code: 0 };
};
//# sourceMappingURL=test-run-nudge.js.map