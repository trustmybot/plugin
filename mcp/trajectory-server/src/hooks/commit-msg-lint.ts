/**
 * PreToolUse lint (GH 1692, GH 2582): denies a real `git commit -m` statement
 * whose subject is not `<emoji> <type>(<scope>): <msg>` within 72 characters.
 * It is an allowlist: the emoji is one Extended_Pictographic grapheme (VS16,
 * skin-tone and ZWJ sequences included) or a `:shortcode:`, the type one of
 * TYPES, the scope optional, then `: ` and the message; length counts code
 * points in every locale. `--fixup`, `--squash`, `--no-edit`, `--merge` and a
 * commit with no visible message (`-F`, the editor) are admitted; `--amend`
 * with `-m` is linted. Bypass: TMB_SKIP_COMMIT_MSG_LINT=1.
 *
 * A command that names `commit` and that tree-sitter-bash cannot parse is
 * denied with git-guards' PARSE_REASON unless it holds `$(` or a backtick (a
 * message built that way is never linted).
 */
import { ALLOW, type GateResult, type Gate } from './gate.js';
import { gitCommitMessage } from './cmd-analysis/commit-message.js';
import { PARSE_FIX, PARSE_REASON } from './git-guards.js';
import { type DenyFix, denyResult } from './lib/deny.js';
import { jqPath, jqRawOr } from './lib/lint-shell.js';

export const GATE_NAME = 'commit-msg-lint';

export const TYPES = 'feat|fix|improvement|refactor|docs|test|perf|chore|build|ci|style|revert|research';
export const EXPECTED_FORM = '<emoji> <type>(<scope>): <msg>';
export const MAX_SUBJECT_CHARS = 72;

const SKIPPED_MODES = [' --no-edit', ' --fixup', ' --squash', ' --merge'];
const BUILT_MESSAGE = /\$\(|`/;
const PICTOGRAPH = String.raw`\p{Extended_Pictographic}(?:\u{FE0F}|\p{Emoji_Modifier})?`;
const EMOJI = String.raw`(?::[a-z0-9_+-]+:|${PICTOGRAPH}(?:\u{200D}${PICTOGRAPH})*)`;
const SUBJECT_RE = new RegExp(`^${EMOJI} (?:${TYPES})(?:\\([a-z0-9._/-]+\\))?: \\S`, 'u');

const FIX: DenyFix = {
  allowed: `the same git commit with a subject of the form '${EXPECTED_FORM}' in at most ${MAX_SUBJECT_CHARS} chars, e.g. -m '✨ feat(hooks): add the gate'`,
};

export function subjectViolation(subject: string): string | null {
  if (!SUBJECT_RE.test(subject)) {
    return (
      `commit subject breaks the grammar rule: it does not match '${EXPECTED_FORM}' ` +
      `(one emoji or :shortcode:, a space, a type from ${TYPES}, an optional (<scope>) of [a-z0-9._/-], then ': ' and the message)`
    );
  }
  const length = [...subject].length;
  return length > MAX_SUBJECT_CHARS ? `commit subject breaks the length rule: it is ${length} chars (>${MAX_SUBJECT_CHARS})` : null;
}

function deny(violation: string, subject: string): GateResult {
  return denyResult(`BLOCKED: commit-msg-lint: ${violation}. Subject seen: "${subject}".`, FIX);
}

export const commitMsgLint: Gate = async (payload, env) => {
  if ((env.TMB_SKIP_COMMIT_MSG_LINT ?? '0') === '1') return ALLOW;
  if (jqRawOr(payload, [jqPath('tool_name')]) !== 'Bash') return ALLOW;
  const command = jqRawOr(payload, [jqPath('tool_input', 'command')]);
  if (!command.includes('commit')) return ALLOW;

  const commit = await gitCommitMessage(command, env);
  if (!commit.ok) return BUILT_MESSAGE.test(command) ? ALLOW : denyResult(PARSE_REASON, PARSE_FIX);
  if (commit.subcommand === '') return ALLOW;
  const padded = ` ${commit.subcommand} `;
  if (SKIPPED_MODES.some((mode) => padded.includes(mode))) return ALLOW;
  if (commit.message === '') return ALLOW;

  const subject = commit.message.split('\n')[0];
  const violation = subjectViolation(subject);
  return violation === null ? ALLOW : deny(violation, subject);
};
