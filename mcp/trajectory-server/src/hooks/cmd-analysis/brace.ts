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

/** Steps of <step> (0 reads as 1) from <from> to <to>, or null past the limit. */
function steps(from: number, to: number, step: number): number[] | null {
  const by = Math.abs(step) || 1;
  if (Math.floor(Math.abs(to - from) / by) + 1 > BRACE_LIMIT) return null;
  const out: number[] = [];
  for (let n = from; from <= to ? n <= to : n >= to; n += from <= to ? by : -by) out.push(n);
  return out;
}

/** The words a `{x..y[..n]}` body expands to, null past the limit, or undefined when it is no sequence. */
function sequence(body: string): string[] | null | undefined {
  const num = NUMERIC_SEQ.exec(body);
  if (num) {
    const ns = steps(Number(num[1]), Number(num[2]), Number(num[3] ?? 1));
    const padded = /^[-+]?0\d/.test(num[1]) || /^[-+]?0\d/.test(num[2]);
    const width = padded ? Math.max(num[1].length, num[2].length) : 0;
    return ns?.map((n) => (n < 0 ? `-${String(-n).padStart(width - 1, '0')}` : String(n).padStart(width, '0'))) ?? null;
  }
  const chars = CHAR_SEQ.exec(body);
  if (!chars) return undefined;
  const codes = steps(chars[1].codePointAt(0) ?? 0, chars[2].codePointAt(0) ?? 0, Number(chars[3] ?? 1));
  return codes?.map((c) => String.fromCodePoint(c)) ?? null;
}

/**
 * <word> brace-expanded as bash does, left to right: a comma list `{a,b}`
 * (nested too) or a sequence `{x..y[..n]}` repeats the word once per
 * alternative, prefix and suffix kept. A `{` that never closes, or closes
 * with no top-level comma and no sequence, stays literal; `${…}` is a
 * parameter, never a brace. Null past BRACE_LIMIT words, so a caller fails
 * closed. Quoting is not seen: a quoted brace expands too.
 */
export function braceExpand(word: string): string[] | null {
  for (let i = 0; i < word.length; i++) {
    if (word[i] !== '{') continue;
    const span = braceSpan(word, i);
    if (span === null) continue;
    if (word[i - 1] === '$') {
      i = span.close;
      continue;
    }
    const body = word.slice(i + 1, span.close);
    let alternatives: string[] | null | undefined;
    if (span.commas.length > 0) {
      const cuts = [i, ...span.commas, span.close];
      alternatives = cuts.slice(0, -1).map((at, k) => word.slice(at + 1, cuts[k + 1]));
    } else alternatives = sequence(body);
    if (alternatives === undefined) continue;
    if (alternatives === null) return null;
    const prefix = word.slice(0, i);
    const suffix = word.slice(span.close + 1);
    const out: string[] = [];
    for (const alternative of alternatives) {
      const rest = braceExpand(alternative + suffix);
      if (rest === null || out.length + rest.length > BRACE_LIMIT) return null;
      for (const r of rest) out.push(prefix + r);
    }
    return out;
  }
  return [word];
}

/** Each word of <words> brace-expanded, or null past BRACE_LIMIT words. */
export function braceExpandWords(words: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const word of words) {
    const expanded = braceExpand(word);
    if (expanded === null || out.length + expanded.length > BRACE_LIMIT) return null;
    out.push(...expanded);
  }
  return out;
}
