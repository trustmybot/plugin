/**
 * PreToolUse lint (GH 1692, GH 2582): denies a real `git commit -m` statement
 * whose subject is not `<emoji> <type>(<scope>): <msg>` within 72 characters.
 * It is an allowlist; the rule lives in ../commit-subject.ts (subjectViolation).
 * `--fixup`, `--squash`, `--no-edit`, `--merge` and a commit with no visible message (`-F`, the editor) are admitted; `--amend`
 * with `-m` is linted. Bypass: TMB_SKIP_COMMIT_MSG_LINT=1.
 *
 * A command that names `commit` and that tree-sitter-bash cannot parse is
 * denied with git-guards' PARSE_REASON unless it holds `$(` or a backtick (a
 * message built that way is never linted).
 */
import { EXPECTED_FORM, MAX_SUBJECT_CHARS, subjectViolation, TYPES } from '../commit-subject.js';
import { ALLOW } from './gate.js';
import { gitCommitMessage } from './cmd-analysis/commit-message.js';
import { PARSE_FIX, PARSE_REASON } from './git-guards.js';
import { denyResult } from './lib/deny.js';
import { jqPath, jqRawOr } from './lib/lint-shell.js';
export { EXPECTED_FORM, MAX_SUBJECT_CHARS, subjectViolation, TYPES };
export const GATE_NAME = 'commit-msg-lint';
const SKIPPED_MODES = [' --no-edit', ' --fixup', ' --squash', ' --merge'];
const BUILT_MESSAGE = /\$\(|`/;
const FIX = {
    allowed: `the same git commit with a subject of the form '${EXPECTED_FORM}' in at most ${MAX_SUBJECT_CHARS} chars, e.g. -m '✨ feat(hooks): add the gate'`,
};
function deny(violation, subject) {
    return denyResult(`BLOCKED: commit-msg-lint: ${violation}. Subject seen: "${subject}".`, FIX);
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
        return BUILT_MESSAGE.test(command) ? ALLOW : denyResult(PARSE_REASON, PARSE_FIX);
    if (commit.subcommand === '')
        return ALLOW;
    const padded = ` ${commit.subcommand} `;
    if (SKIPPED_MODES.some((mode) => padded.includes(mode)))
        return ALLOW;
    if (commit.message === '')
        return ALLOW;
    const subject = commit.message.split('\n')[0];
    const violation = subjectViolation(subject);
    return violation === null ? ALLOW : deny(violation, subject);
};
//# sourceMappingURL=commit-msg-lint.js.map