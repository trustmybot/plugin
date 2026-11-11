/**
 * Bash brace expansion (bash(1) "Brace Expansion") of one word, for the
 * prompt-write-approval tree-writes reading (GH 2981): `mv x/{.claude,a} .`
 * moves a `.claude` dir though no word spells it.
 */

export const BRACE_LIMIT = 4096;

const NUMERIC_SEQ = /^([-+]?\d+)\.\.([-+]?\d+)(?:\.\.([-+]?\d+))?$/;
const CHAR_SEQ = /^([^\d])\.\.([^\d])(?:\.\.([-+]?\d+))?$/su;

/** The `}` closing the `{` at <open> and the top-level commas between, or null when it never closes. */
function braceSpan(word: string, open: number): { close: number; commas: number[] } | null {
  const commas: number[] = [];
  let depth = 0;
  for (let i = open; i < word.length; i++) {
    const c = word[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { close: i, commas };
    else if (c === ',' && depth === 1) commas.push(i);
  }
  return null;
}

/** A `{x..y[..n]}` sequence: its <count> words, the <k>th shown by <at>. */
interface Sequence {
  count: number;
  at: (k: number) => string;
}

/** The sequence a brace body spells, or undefined when it is none. */
function sequenceOf(body: string): Sequence | undefined {
  const num = NUMERIC_SEQ.exec(body);
  const bounds = num ?? CHAR_SEQ.exec(body);
  if (!bounds) return undefined;
  const from = num ? Number(num[1]) : (bounds[1].codePointAt(0) ?? 0);
  const to = num ? Number(num[2]) : (bounds[2].codePointAt(0) ?? 0);
  const by = (Math.abs(Number(bounds[3] ?? 1)) || 1) * (from <= to ? 1 : -1);
  const count = Math.floor(Math.abs(to - from) / Math.abs(by)) + 1;
  if (!num) return { count, at: (k) => String.fromCodePoint(from + k * by) };
  const padded = /^[-+]?0\d/.test(num[1]) || /^[-+]?0\d/.test(num[2]);
  const width = padded ? Math.max(num[1].length, num[2].length) : 0;
  const show = (n: number): string => (n < 0 ? `-${String(-n).padStart(width - 1, '0')}` : String(n).padStart(width, '0'));
  return { count, at: (k) => show(from + k * by) };
}

/** The first brace of <word> bash expands: where it sits, and its comma alternatives or its sequence; null when none does. */
function firstBrace(word: string): { open: number; close: number; alternatives: string[] | Sequence } | null {
  for (let i = 0; i < word.length; i++) {
    if (word[i] !== '{') continue;
    const span = braceSpan(word, i);
    if (span === null) continue;
    if (word[i - 1] === '$') {
      i = span.close;
      continue;
    }
    if (span.commas.length > 0) {
      const cuts = [i, ...span.commas, span.close];
      return { open: i, close: span.close, alternatives: cuts.slice(0, -1).map((at, k) => word.slice(at + 1, cuts[k + 1])) };
    }
    const sequence = sequenceOf(word.slice(i + 1, span.close));
    if (sequence !== undefined) return { open: i, close: span.close, alternatives: sequence };
  }
  return null;
}

/**
 * <word> brace-expanded as bash does, left to right: a comma list `{a,b}`
 * (nested too) or a sequence `{x..y[..n]}` repeats the word once per
 * alternative, prefix and suffix kept. A `{` that never closes, or closes
 * with no top-level comma and no sequence, stays literal; `${…}` is a
 * parameter, never a brace. Null past BRACE_LIMIT words. Quoting is not
 * seen: a quoted brace expands too.
 */
export function braceExpand(word: string): string[] | null {
  const brace = firstBrace(word);
  if (brace === null) return [word];
  const { alternatives } = brace;
  const list = Array.isArray(alternatives) ? alternatives : alternatives.count > BRACE_LIMIT ? null : Array.from({ length: alternatives.count }, (_, k) => alternatives.at(k));
  if (list === null) return null;
  const prefix = word.slice(0, brace.open);
  const suffix = word.slice(brace.close + 1);
  const out: string[] = [];
  for (const alternative of list) {
    const rest = braceExpand(alternative + suffix);
    if (rest === null || out.length + rest.length > BRACE_LIMIT) return null;
    for (const r of rest) out.push(prefix + r);
  }
  return out;
}

/** The first (or with <last> the last) word <word> brace-expands to, found without listing the rest. */
export function braceEdge(word: string, last: boolean): string {
  const brace = firstBrace(word);
  if (brace === null) return word;
  const { alternatives } = brace;
  const pick = Array.isArray(alternatives) ? alternatives[last ? alternatives.length - 1 : 0] : alternatives.at(last ? alternatives.count - 1 : 0);
  return word.slice(0, brace.open) + braceEdge(pick + word.slice(brace.close + 1), last);
}

/** The text before <word>'s first `{`, cut after its last `/`, or its option prefix (`-C`, `--name=`) when it has no `/`. */
function stem(word: string): string {
  const head = word.slice(0, Math.max(word.indexOf('{'), 0));
  const slash = head.lastIndexOf('/');
  if (slash >= 0) return head.slice(0, slash + 1);
  return /^(--[A-Za-z-]+=|-[A-Za-z])/.exec(head)?.[0] ?? '';
}

/**
 * Each of <words> brace-expanded, as bash passes a command its arguments. A
 * word past BRACE_LIMIT words (or past it with the words before) stands as
 * three: its first and last word, which keep every option value and last
 * operand where bash puts them, and between them the glob `<stem>.claude*`,
 * standing for the words between: a gate matching a source's name against
 * `.claude` fails closed for that word alone, while one reading it as a
 * plain name sees no `.claude` dir.
 */
export function braceWords(words: readonly string[]): string[] {
  const out: string[] = [];
  for (const word of words) {
    const expanded = braceExpand(word);
    if (expanded !== null && out.length + expanded.length <= BRACE_LIMIT) out.push(...expanded);
    else out.push(braceEdge(word, false), `${stem(word)}.claude*`, braceEdge(word, true));
  }
  return out;
}
