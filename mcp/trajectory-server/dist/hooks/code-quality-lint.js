/**
 * PreToolUse lint (GH 1692), the port of scripts/hooks/code-quality-lint.sh:
 * warns through additionalContext on the code-quality patterns a regex finds
 * in the new content of a Python or TS/JS source file (bare except, an
 * unbounded subprocess.run, string-built SQL, `catch (e: any)`, a TODO
 * marker, …). Bypass: TMB_SKIP_CQ_LINT=1.
 *
 * Messages and decisions are the .sh's; the lint also runs with no jq on PATH.
 */
import { ALLOW } from './gate.js';
import { anyLine, grepMultibyte, grepSpace, jqEachOptional, jqIndex, jqJoinLines, jqPath, jqRawOr, preToolContext, } from './lib/lint-shell.js';
export const GATE_NAME = 'code-quality-lint';
const TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const SOURCE_EXTS = ['.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const TS_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']);
const SKIPPED_DIRS = ['/node_modules/', '/dist/', '/build/', '/__pycache__/', '/target/', '/fixtures/', '/__fixtures__/'];
const PY_CHECKS = [
    { pattern: '^[S]*except[S]*:', message: "bare 'except:' — catch a specific exception or re-raise" },
    { pattern: '^[S]*except[S]+Exception[S]*[:as ]', message: "'except Exception' is too broad — catches SystemExit/KeyboardInterrupt" },
];
const PY_LATER_CHECKS = [
    { pattern: `f['"](SELECT|INSERT|UPDATE|DELETE|MERGE)[S]`, message: 'f-string SQL — use parameterized queries to prevent injection' },
    { pattern: 'datetime\\.utcnow\\(\\)', message: 'datetime.utcnow() returns naive datetime — use datetime.now(timezone.utc)' },
    { pattern: 'def[S]+[A-Za-z_][A-Za-z0-9_]*\\([^)]*=\\[\\]', message: 'mutable default argument [] — use None and assign in body' },
    { pattern: 'def[S]+[A-Za-z_][A-Za-z0-9_]*\\([^)]*=\\{\\}', message: 'mutable default argument {} — use None and assign in body' },
];
const TS_CHECKS = [
    {
        pattern: 'catch[S]*\\([S]*[A-Za-z_][A-Za-z0-9_]*[S]*:[S]*any[S]*\\)',
        message: "catch (e: any) — use 'unknown' and narrow with instanceof",
    },
    { pattern: '`(SELECT|INSERT|UPDATE|DELETE|MERGE)[^`]*[$][{]', message: 'template-string SQL with ${...} — use parameterized queries' },
    { pattern: `setTimeout\\([S]*['"]`, message: 'setTimeout with string argument — use a function reference' },
];
const MARKER_CHECK = {
    pattern: '(TODO|FIXME|HACK|XXX)([S]|:|$)',
    message: "TODO/FIXME/HACK — finish the work or escalate; don't ship the marker",
};
/** `[S]` in a pattern stands for grep's `[[:space:]]` in the hook's locale. */
function regex(pattern, multibyte) {
    return new RegExp(pattern.replace(/\[S\]/g, `[${grepSpace(multibyte)}]`), 'u');
}
/** `.tool_input.content // .tool_input.new_string // ([.tool_input.edits[]?.new_string] | join("\n")) // ""`. */
function newContent(payload) {
    return jqRawOr(payload, [
        jqPath('tool_input', 'content'),
        jqPath('tool_input', 'new_string'),
        (value) => jqJoinLines(jqEachOptional(jqPath('tool_input', 'edits')(value)).map((edit) => jqIndex(edit, 'new_string'))),
    ]);
}
function pythonFindings(content, multibyte) {
    const found = PY_CHECKS.filter((c) => anyLine(content, regex(c.pattern, multibyte))).map((c) => c.message);
    const call = regex('subprocess\\.run\\([^)]*\\)', multibyte);
    const timeout = regex('timeout[S]*=', multibyte);
    const unbounded = content.split('\n').some((line) => call.test(line) && !timeout.test(line));
    if (anyLine(content, /subprocess\.run\(/) && unbounded)
        found.push('subprocess.run without timeout= — risk of indefinite hang');
    return found.concat(PY_LATER_CHECKS.filter((c) => anyLine(content, regex(c.pattern, multibyte))).map((c) => c.message));
}
export const codeQualityLint = (payload, env) => {
    if ((env.TMB_SKIP_CQ_LINT ?? '0') === '1')
        return ALLOW;
    if (!TOOLS.has(jqRawOr(payload, [jqPath('tool_name')])))
        return ALLOW;
    const target = jqRawOr(payload, [jqPath('tool_input', 'file_path')]);
    if (target === '' || !SOURCE_EXTS.some((ext) => target.endsWith(ext)))
        return ALLOW;
    if (SKIPPED_DIRS.some((d) => target.includes(d)))
        return ALLOW;
    const content = newContent(payload);
    if (content === '')
        return ALLOW;
    const ext = target.slice(target.lastIndexOf('.') + 1);
    const multibyte = grepMultibyte(env);
    const findings = [];
    if (ext === 'py')
        findings.push(...pythonFindings(content, multibyte));
    else if (TS_EXTS.has(ext))
        findings.push(...TS_CHECKS.filter((c) => anyLine(content, regex(c.pattern, multibyte))).map((c) => c.message));
    if (anyLine(content, regex(MARKER_CHECK.pattern, multibyte)))
        findings.push(MARKER_CHECK.message);
    if (findings.length === 0)
        return ALLOW;
    const ctx = `code-quality-lint: ${target}${findings.map((f) => `\n - ${f}`).join('')}\nSet TMB_SKIP_CQ_LINT=1 to bypass.`;
    return { stdout: preToolContext(ctx), code: 0 };
};
//# sourceMappingURL=code-quality-lint.js.map