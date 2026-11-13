/**
 * The commit subject rule (GH 1692, GH 2582, GH 2667): `<emoji> <type>(<scope>): <msg>`
 * within 72 code points. The emoji is one Extended_Pictographic grapheme
 * (VS16, skin-tone and ZWJ sequences included) or a `:shortcode:`, the type
 * one of TYPES, the scope optional. commit-msg-lint denies a commit that
 * breaks it; specCommitProblem refuses a spec whose `## Commit` subject does.
 * Dependency-free, so the hooks bundle and the tools share it.
 */
export const TYPES = 'feat|fix|improvement|refactor|docs|test|perf|chore|build|ci|style|revert|research';
export const EXPECTED_FORM = '<emoji> <type>(<scope>): <msg>';
export const MAX_SUBJECT_CHARS = 72;
const PICTOGRAPH = String.raw `\p{Extended_Pictographic}(?:\u{FE0F}|\p{Emoji_Modifier})?`;
const EMOJI = String.raw `(?::[a-z0-9_+-]+:|${PICTOGRAPH}(?:\u{200D}${PICTOGRAPH})*)`;
const SUBJECT_RE = new RegExp(`^${EMOJI} (?:${TYPES})(?:\\([a-z0-9._/-]+\\))?: \\S`, 'u');
export function subjectViolation(subject) {
    if (!SUBJECT_RE.test(subject)) {
        return (`commit subject breaks the grammar rule: it does not match '${EXPECTED_FORM}' ` +
            `(one emoji or :shortcode:, a space, a type from ${TYPES}, an optional (<scope>) of [a-z0-9._/-], then ': ' and the message)`);
    }
    const length = [...subject].length;
    return length > MAX_SUBJECT_CHARS ? `commit subject breaks the length rule: it is ${length} chars (>${MAX_SUBJECT_CHARS})` : null;
}
//# sourceMappingURL=commit-subject.js.map