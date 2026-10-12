/**
 * The bro persona block onboarding writes into a user project's CLAUDE.md.
 * Claude Code reads only the project's own CLAUDE.md, so the plugin's
 * CLAUDE.md body is materialised there between managed, versioned markers:
 *
 *   <!-- tmb:persona start v<plugin version> -->
 *   <plugin CLAUDE.md body>
 *   <!-- tmb:persona end -->
 *
 * Pure text functions: no text outside the markers is ever changed, CRLF files
 * keep CRLF, and a start marker with no end marker is an error, never a guess.
 */
export const PERSONA_END_MARKER = '<!-- tmb:persona end -->';
const START_RE = /<!-- tmb:persona start v([^\s>]+) -->/g;
const END_LITERAL = PERSONA_END_MARKER;
export class PersonaBlockError extends Error {
}
export function personaStartMarker(version) {
    return `<!-- tmb:persona start v${version} -->`;
}
export function renderPersonaBlock(body, version) {
    if (!/^[^\s>]+$/.test(version))
        throw new PersonaBlockError(`invalid persona version '${version}'`);
    const normalized = body.replace(/\r\n/g, '\n').replace(/\n+$/, '');
    return `${personaStartMarker(version)}\n${normalized}\n${PERSONA_END_MARKER}`;
}
function eolOf(text) {
    return text.includes('\r\n') ? '\r\n' : '\n';
}
function findBlock(text) {
    const starts = [...text.matchAll(START_RE)];
    const endIdx = text.indexOf(END_LITERAL);
    if (starts.length === 0) {
        if (endIdx >= 0)
            throw new PersonaBlockError('CLAUDE.md has a tmb persona end marker without a start marker');
        return null;
    }
    if (starts.length > 1)
        throw new PersonaBlockError('CLAUDE.md holds more than one tmb persona start marker');
    const start = starts[0].index ?? 0;
    const end = text.indexOf(END_LITERAL, start);
    if (end < 0)
        throw new PersonaBlockError('CLAUDE.md has a tmb persona start marker without an end marker');
    if (text.indexOf(END_LITERAL, end + END_LITERAL.length) >= 0) {
        throw new PersonaBlockError('CLAUDE.md holds more than one tmb persona end marker');
    }
    return { start, end: end + END_LITERAL.length, version: starts[0][1] };
}
/** The version named by the file's persona start marker, or null when it has none. */
export function personaBlockVersion(text) {
    if (!text)
        return null;
    return findBlock(text)?.version ?? null;
}
export function applyPersonaBlock(existing, block) {
    if (existing === null || existing.length === 0) {
        return { text: `${block}\n`, action: 'appended' };
    }
    const eol = eolOf(existing);
    const local = block.replace(/\r\n/g, '\n').split('\n').join(eol);
    const span = findBlock(existing);
    if (span) {
        if (existing.slice(span.start, span.end) === local)
            return { text: existing, action: 'unchanged' };
        return { text: existing.slice(0, span.start) + local + existing.slice(span.end), action: 'replaced' };
    }
    let head = existing;
    if (!head.endsWith(eol))
        head += eol;
    if (!head.endsWith(eol + eol))
        head += eol;
    return { text: `${head}${local}${eol}`, action: 'appended' };
}
export function removePersonaBlock(text) {
    const span = findBlock(text);
    if (!span)
        return { text, action: 'unchanged' };
    const eol = eolOf(text);
    let before = text.slice(0, span.start);
    let after = text.slice(span.end);
    if (after.startsWith(eol))
        after = after.slice(eol.length);
    if (after.length === 0 && before.endsWith(eol + eol))
        before = before.slice(0, before.length - eol.length);
    return { text: before + after, action: 'removed' };
}
//# sourceMappingURL=persona-block.js.map