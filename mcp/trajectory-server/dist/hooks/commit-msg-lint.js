/**
 * PreToolUse lint (GH 1692), the port of scripts/hooks/commit-msg-lint.sh:
 * warns through additionalContext when the subject of a real `git commit -m`
 * statement is not `<emoji> <type>(<scope>): <description>` or runs past 72
 * characters. Bypass: TMB_SKIP_COMMIT_MSG_LINT=1.
 *
 * Messages and decisions are the .sh's, with two exceptions: a command that
 * names `commit` and that tree-sitter-bash cannot parse is denied with
 * git-guards' PARSE_REASON unless it holds `$(` or a backtick (the .sh never
 * lints a message built that way, so such a command keeps its silence), and
 * the lint runs with no jq on PATH.
 */
import { ALLOW } from './gate.js';
import { gitCommitMessage } from './cmd-analysis/commit-message.js';
import { PARSE_REASON } from './git-guards.js';
import { jqCompact } from './lib/jq.js';
import { awkSpace, grepMultibyte, grepSpace, jqPath, jqRawOr, preToolContext } from './lib/lint-shell.js';
import { ctypeUtf8 } from './lib/project-env.js';
export const GATE_NAME = 'commit-msg-lint';
const TYPES = 'feat|fix|improvement|refactor|docs|test|perf|chore|build|ci|style|revert';
const SKIPPED_MODES = [' --amend', ' --no-edit', ' --fixup', ' --squash', ' --merge'];
const AWK_FIELD_SEP = /[ \t\n]+/;
const BUILT_MESSAGE = /\$\(|`/;
function parseDeny() {
    const decision = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: PARSE_REASON } };
    return `${jqCompact(decision)}\n`;
}
/** `awk '{print $1}'` and `awk '{$1=""; sub(/^[[:space:]]+/, ""); print}'` of one line. */
function splitSubject(line, env) {
    if (line === '')
        return { prefix: '', rest: '' };
    const fields = line.split(AWK_FIELD_SEP).filter((f) => f !== '');
    const rebuilt = ['', ...fields.slice(1)].join(' ');
    const rest = rebuilt.replace(new RegExp(`^[${awkSpace(env)}]+`, 'u'), '');
    return { prefix: fields[0] ?? '', rest };
}
function prefixOk(prefix) {
    return /^:[a-z0-9_+-]+:$/.test(prefix) || /[^\t\n\v\f\r\x20-\x7e]/.test(prefix);
}
function restOk(rest, multibyte) {
    return new RegExp(`^(${TYPES})(\\([a-z0-9._/-]+\\))?:[${grepSpace(multibyte)}].+`, 'su').test(rest);
}
/** `printf '%s' "$s" | wc -m`: code points under a UTF-8 ctype, bytes otherwise. */
function charCount(s, env) {
    return ctypeUtf8(env) ? [...s].length : Buffer.byteLength(s, 'utf8');
}
export const commitMsgLint = async (payload, env) => {
    if ((env.TMB_SKIP_COMMIT_MSG_LINT ?? '0') === '1')
        return ALLOW;
    if (jqRawOr(payload, [jqPath('tool_name')]) !== 'Bash')
        return ALLOW;
    const command = jqRawOr(payload, [jqPath('tool_input', 'command')]);
    if (!command.includes('commit'))
        return ALLOW;
    const commit = await gitCommitMessage(command, env);
    if (!commit.ok)
        return BUILT_MESSAGE.test(command) ? ALLOW : { stdout: parseDeny(), code: 0 };
    if (commit.subcommand === '')
        return ALLOW;
    const padded = ` ${commit.subcommand} `;
    if (SKIPPED_MODES.some((mode) => padded.includes(mode)))
        return ALLOW;
    if (commit.message === '')
        return ALLOW;
    const firstLine = commit.message.split('\n')[0];
    const { prefix, rest } = splitSubject(firstLine, env);
    let violation = '';
    if (!prefixOk(prefix) || !restOk(rest, grepMultibyte(env))) {
        violation = `commit subject does not match '<emoji> <type>(<scope>): <description>' (allowed types: ${TYPES})`;
    }
    else {
        const length = charCount(firstLine, env);
        if (length > 72)
            violation = `commit subject is ${length} chars (>72)`;
    }
    if (violation === '')
        return ALLOW;
    const ctx = `commit-msg-lint: ${violation}. Subject seen: "${firstLine}". Set TMB_SKIP_COMMIT_MSG_LINT=1 to bypass.`;
    return { stdout: preToolContext(ctx), code: 0 };
};
//# sourceMappingURL=commit-msg-lint.js.map