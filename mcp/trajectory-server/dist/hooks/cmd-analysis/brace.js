/**
 * Bash brace expansion (bash(1) "Brace Expansion") of one word, for the
 * prompt-write-approval tree-writes reading (GH 2981): `mv x/{.claude,a} .`
 * moves a `.claude` dir though no word spells it.
 */
export const BRACE_LIMIT = 4096;
const NUMERIC_SEQ = /^([-+]?\d+)\.\.([-+]?\d+)(?:\.\.([-+]?\d+))?$/;
const CHAR_SEQ = /^([^\d])\.\.([^\d])(?:\.\.([-+]?\d+))?$/su;
/** The `}` closing the `{` at <open> and the top-level commas between, or null when it never closes. */
function braceSpan(word, open) {
    const commas = [];
    let depth = 0;
    for (let i = open; i < word.length; i++) {
        const c = word[i];
        if (c === '{')
            depth++;
        else if (c === '}' && --depth === 0)
            return { close: i, commas };
        else if (c === ',' && depth === 1)
            commas.push(i);
    }
    return null;
}
/** The sequence a brace body spells, or undefined when it is none. */
function sequenceOf(body) {
    const num = NUMERIC_SEQ.exec(body);
    const bounds = num ?? CHAR_SEQ.exec(body);
    if (!bounds)
        return undefined;
    const from = num ? Number(num[1]) : (bounds[1].codePointAt(0) ?? 0);
    const to = num ? Number(num[2]) : (bounds[2].codePointAt(0) ?? 0);
    const by = (Math.abs(Number(bounds[3] ?? 1)) || 1) * (from <= to ? 1 : -1);
    const count = Math.floor(Math.abs(to - from) / Math.abs(by)) + 1;
    if (!num)
        return { count, at: (k) => String.fromCodePoint(from + k * by), numeric: false };
    const padded = /^[-+]?0\d/.test(num[1]) || /^[-+]?0\d/.test(num[2]);
    const width = padded ? Math.max(num[1].length, num[2].length) : 0;
    const show = (n) => (n < 0 ? `-${String(-n).padStart(width - 1, '0')}` : String(n).padStart(width, '0'));
    return { count, at: (k) => show(from + k * by), numeric: true };
}
/** The first brace of <word> bash expands: where it sits, and its comma alternatives or its sequence; null when none does. */
function firstBrace(word) {
    for (let i = 0; i < word.length; i++) {
        if (word[i] !== '{')
            continue;
        const span = braceSpan(word, i);
        if (span === null)
            continue;
        if (word[i - 1] === '$') {
            i = span.close;
            continue;
        }
        if (span.commas.length > 0) {
            const cuts = [i, ...span.commas, span.close];
            return { open: i, close: span.close, alternatives: cuts.slice(0, -1).map((at, k) => word.slice(at + 1, cuts[k + 1])) };
        }
        const sequence = sequenceOf(word.slice(i + 1, span.close));
        if (sequence !== undefined)
            return { open: i, close: span.close, alternatives: sequence };
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
export function braceExpand(word) {
    return expandWith(word, everyWord);
}
const everyWord = (s) => (s.count > BRACE_LIMIT ? null : Array.from({ length: s.count }, (_, k) => s.at(k)));
/** A numeric sequence cut to its first and last number: its numbers hold only digits and a sign, which they change at one end at most. */
const shapeWords = (s) => (s.numeric ? [...new Set([s.at(0), s.at(s.count - 1)])] : everyWord(s));
function expandWith(word, sequenceWords) {
    const brace = firstBrace(word);
    if (brace === null)
        return [word];
    const { alternatives } = brace;
    const list = Array.isArray(alternatives) ? alternatives : sequenceWords(alternatives);
    if (list === null)
        return null;
    const prefix = word.slice(0, brace.open);
    const suffix = word.slice(brace.close + 1);
    const out = [];
    for (const alternative of list) {
        const rest = expandWith(alternative + suffix, sequenceWords);
        if (rest === null || out.length + rest.length > BRACE_LIMIT)
            return null;
        for (const r of rest)
            out.push(prefix + r);
    }
    return out;
}
/** The first (or with <last> the last) word <word> brace-expands to, found without listing the rest. */
export function braceEdge(word, last) {
    const brace = firstBrace(word);
    if (brace === null)
        return word;
    const { alternatives } = brace;
    const pick = Array.isArray(alternatives) ? alternatives[last ? alternatives.length - 1 : 0] : alternatives.at(last ? alternatives.count - 1 : 0);
    return word.slice(0, brace.open) + braceEdge(pick + word.slice(brace.close + 1), last);
}
const OPTION_PREFIX = /^(--[A-Za-z-]+=|-[A-Za-z])/;
const DOT_DOT_SEGMENT = /(^|\/)\.\.(\/|$)/;
/** The text before <word>'s first `{`. */
function braceHead(word) {
    return word.slice(0, Math.max(word.indexOf('{'), 0));
}
/** The option prefix (`-C`, `--name=`) <word> starts with before its first `{`, or ''. */
function optionPrefix(word) {
    return OPTION_PREFIX.exec(braceHead(word))?.[0] ?? '';
}
/** The text before <word>'s first `{`, cut after its last `/`, or its option prefix when it has no `/`. */
function stem(word) {
    const head = braceHead(word);
    const slash = head.lastIndexOf('/');
    return slash >= 0 ? head.slice(0, slash + 1) : optionPrefix(word);
}
/**
 * Whether a word <word> expands to may lie outside its stem, read on its <shapes> (null when even
 * they pass BRACE_LIMIT): one with a `..` segment after the stem, one rooted at `/` or `~` where
 * the stem holds no `/`, or any word when a `$` or backtick follows the stem, since its value is
 * filled in after brace expansion.
 */
function leavesStem(word, shapes) {
    const from = stem(word);
    if (shapes === null || /[$`]/.test(word.slice(from.length)))
        return true;
    const rootable = !from.includes('/');
    return shapes.some((shape) => {
        const rest = shape.slice(from.length);
        return DOT_DOT_SEGMENT.test(rest) || (rootable && /^[/~]/.test(rest));
    });
}
/**
 * The words standing for <word> when it expands past what can be listed. Its first and last word
 * keep every option value and last operand where bash puts them. Between them stand its shapes
 * (the words it expands to with each numeric sequence cut to its first and last number: words bash
 * does pass, holding every dot, slash, letter and option a word between can hold) and the glob
 * `<stem>.claude*`: a gate matching a source's name against `.claude` fails closed for that word
 * alone, while one reading it as a plain name sees no `.claude` dir. A word that may lie outside
 * its stem (leavesStem) stands as its first word, <unresolvable> after its option prefix, and its
 * last word: <unresolvable> is a path its caller gates for a write anywhere under its root.
 */
function braceStandIns(word, unresolvable) {
    const first = braceEdge(word, false);
    const last = braceEdge(word, true);
    const shapes = expandWith(word, shapeWords);
    if (leavesStem(word, shapes))
        return [first, optionPrefix(word) + unresolvable, last];
    return [first, `${stem(word)}.claude*`, ...(shapes ?? []).filter((shape) => shape !== first && shape !== last), last];
}
/**
 * Each of <words> brace-expanded, as bash passes a command its arguments. A
 * word past BRACE_LIMIT words (or past it with the words before) stands as
 * braceStandIns gives it, <unresolvable> for one that may leave its stem.
 */
export function braceWords(words, unresolvable) {
    const out = [];
    for (const word of words) {
        const expanded = braceExpand(word);
        if (expanded !== null && out.length + expanded.length <= BRACE_LIMIT)
            out.push(...expanded);
        else
            out.push(...braceStandIns(word, unresolvable));
    }
    return out;
}
//# sourceMappingURL=brace.js.map