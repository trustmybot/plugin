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

export type PersonaApplyAction = 'appended' | 'replaced' | 'unchanged' | 'skipped_source';
export type PersonaRemoveAction = 'removed' | 'unchanged';

export const PERSONA_END_MARKER = '<!-- tmb:persona end -->';
const START_RE = /<!-- tmb:persona start v([^\s>]+) -->/g;
const END_LITERAL = PERSONA_END_MARKER;

export class PersonaBlockError extends Error {}

export function personaStartMarker(version: string): string {
  return `<!-- tmb:persona start v${version} -->`;
}

export function renderPersonaBlock(body: string, version: string): string {
  if (!/^[^\s>]+$/.test(version)) throw new PersonaBlockError(`invalid persona version '${version}'`);
  const normalized = body.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  return `${personaStartMarker(version)}\n${normalized}\n${PERSONA_END_MARKER}`;
}

function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

interface BlockSpan {
  readonly start: number;
  readonly end: number;
  readonly version: string;
}

function findBlock(text: string): BlockSpan | null {
  const starts = [...text.matchAll(START_RE)];
  const endIdx = text.indexOf(END_LITERAL);
  if (starts.length === 0) {
    if (endIdx >= 0) throw new PersonaBlockError('CLAUDE.md has a tmb persona end marker without a start marker');
    return null;
  }
  if (starts.length > 1) throw new PersonaBlockError('CLAUDE.md holds more than one tmb persona start marker');
  const start = starts[0].index ?? 0;
  const end = text.indexOf(END_LITERAL, start);
  if (end < 0) throw new PersonaBlockError('CLAUDE.md has a tmb persona start marker without an end marker');
  if (text.indexOf(END_LITERAL, end + END_LITERAL.length) >= 0) {
    throw new PersonaBlockError('CLAUDE.md holds more than one tmb persona end marker');
  }
  return { start, end: end + END_LITERAL.length, version: starts[0][1] };
}

/** The version named by the file's persona start marker, or null when it has none. */
export function personaBlockVersion(text: string | null): string | null {
  if (!text) return null;
  return findBlock(text)?.version ?? null;
}

export function applyPersonaBlock(
  existing: string | null,
  block: string,
): { text: string; action: Exclude<PersonaApplyAction, 'skipped_source'> } {
  if (existing === null || existing.length === 0) {
    return { text: `${block}\n`, action: 'appended' };
  }
  const eol = eolOf(existing);
  const local = block.replace(/\r\n/g, '\n').split('\n').join(eol);
  const span = findBlock(existing);
  if (span) {
    if (existing.slice(span.start, span.end) === local) return { text: existing, action: 'unchanged' };
    return { text: existing.slice(0, span.start) + local + existing.slice(span.end), action: 'replaced' };
  }
  if (!existing.endsWith(eol)) return { text: `${existing}${eol}${eol}${local}`, action: 'appended' };
  const head = existing.endsWith(eol + eol) ? existing : existing + eol;
  return { text: `${head}${local}${eol}`, action: 'appended' };
}

export function removePersonaBlock(text: string): { text: string; action: PersonaRemoveAction } {
  const span = findBlock(text);
  if (!span) return { text, action: 'unchanged' };
  const eol = eolOf(text);
  let before = text.slice(0, span.start);
  let after = text.slice(span.end);
  const endedWithEol = after.startsWith(eol);
  if (endedWithEol) after = after.slice(eol.length);
  if (after.length === 0 && before.endsWith(eol + eol)) {
    before = before.slice(0, before.length - eol.length);
    if (!endedWithEol) before = before.slice(0, before.length - eol.length);
  }
  return { text: before + after, action: 'removed' };
}
