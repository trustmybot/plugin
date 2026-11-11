/**
 * The `keep` skeleton of tmb_cmd_strip_literals (cmd-analysis.sh), built from
 * a tree-sitter-bash tree instead of its line scanner: heredoc bodies and
 * comments dropped, quotes removed, every blank and operator character of
 * quoted or backslash-escaped text turned into a reversible control byte, and
 * a $( ) or backtick inside double quotes framed by QO … QC with its body
 * encoded as shell syntax again, and each heredoc's `<<` followed by HD_DATA
 * when its body is data to the shell, else by HD_EXP (GH 1911). With `marks`
 * (the write-path analyzer, GH 1912), a substitution whose body is one mktemp
 * call `mktempCall` admits is framed by QO … QC quoted or not, its body led by
 * MKTEMP_MARK, and each `$` bash keeps literal is DOLLAR (GH 2443). With
 * `heredocCode` (the git listing, GH 2635), the code of each $( ) or
 * backtick in an unquoted-delimiter heredoc body (bodyCodes: a $( ) from the
 * parse tree, a backtick from the text) is encoded on its own and framed by
 * QO … QC, each after a blank, right after the heredoc's delimiter; the
 * command is not ok when one does not parse.
 */
import type { Node, Parser } from 'web-tree-sitter';
import { MKTEMP_MARK, mktempCall } from './mktemp.js';

const NEUTRAL = ' \t<>|;&()`';

export const ENC: readonly string[] = ['', ...Array.from({ length: 12 }, (_, i) => String.fromCharCode(i < 6 ? i + 1 : i + 8))];
export const QO = '\x07';
export const QC = '\x08';
export const JOINER = ENC[12];
/** A quoted or escaped `(` / `)` inside a substitution that statements.ts frames as `$` ENC[8] … ENC[9]: decoded alike, told apart from the frame. */
export const SUB_PO = '\x15';
export const SUB_PC = '\x16';
/** After a heredoc's `<<`: its delimiter is quoted, or its body expands nothing but plain `$NAME` / `${NAME}`. */
export const HD_DATA = '\x1e';
/** After a heredoc's `<<`: its body may run code or assign when the shell expands it. */
export const HD_EXP = '\x1a';
/** Before each opening quote or unquoted backslash: statements.ts reads a word holding one as never a reserved word (POSIX 2.4) and drops it. */
export const QM = '\x17';
/** A literal QM in the command: `$()` (encoded), so it reads as computed text rather than a mark. */
const QM_LITERAL = '$' + ENC[8] + ENC[9];
/** With `marks` (GH 2443): a `$` bash keeps literal, inside `'…'` or `$'…'` or after a backslash, unquoted or in `"…"`; `decode` turns it back into `$`. */
export const DOLLAR = '\x19';
/** An empty unquoted substitution: text the analyzers cannot know, so a word holding it reads as computed (GH 2640). */
const COMPUTED = '$()';
/** With `shownControls`, a control char a `$'…'` escape decodes to, which the skeleton cannot carry: U+FFFD, text the commit-message reader lints rather than skips. */
export const CONTROL_SHOWN = '�';

const ANSI_C_SIMPLE: ReadonlyMap<string, string> = new Map([
  ['a', '\x07'],
  ['b', '\b'],
  ['e', '\x1b'],
  ['E', '\x1b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['v', '\v'],
  ['\\', '\\'],
  ["'", "'"],
  ['"', '"'],
  ['?', '?'],
]);

const ANSI_C_DIGITS: ReadonlyMap<string, { re: RegExp; radix: number }> = new Map([
  ['x', { re: /^[0-9A-Fa-f]{1,2}/, radix: 16 }],
  ['u', { re: /^[0-9A-Fa-f]{1,4}/, radix: 16 }],
  ['U', { re: /^[0-9A-Fa-f]{1,8}/, radix: 16 }],
]);

/** A code point bash writes as one char in every version and locale: not NUL (it ends the word), a surrogate, or past U+10FFFF. */
const ansiCPoint = (n: number): string | null => (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) ? null : String.fromCodePoint(n));

/** A `\xHH` or `\NNN` byte: past 0x7F bash writes a raw byte that is no single char (F753-2). */
const ansiCByte = (n: number): string | null => (n > 0x7f ? null : ansiCPoint(n));

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The `\NNN` or `\xHH` escape at `body[i]` (a backslash) when it is one byte, with its source length. */
function byteEscape(body: string, i: number): { n: number; len: number } | null {
  const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1));
  const hex = octal || body[i + 1] !== 'x' ? null : /^[0-9A-Fa-f]{1,2}/.exec(body.slice(i + 2));
  const b = octal ? { n: parseInt(octal[0], 8), len: 1 + octal[0].length } : hex ? { n: parseInt(hex[0], 16), len: 2 + hex[0].length } : null;
  return b && b.n <= 0xff ? b : null;
}

/** The maximal run of byte escapes at `body[i]` decoded as UTF-8 (GH 2765), each char as `ansiCPoint` gives it; null when `body[i]` starts no byte escape, and its bytes as `ansiCByte` gives them when the run is all ASCII (GH 2793) or not valid UTF-8. */
export function utf8Run(body: string, i: number): { chars: Array<string | null>; end: number } | null {
  const bytes: number[] = [];
  let end = i;
  while (body[end] === '\\') {
    const b = byteEscape(body, end);
    if (b === null) break;
    bytes.push(b.n);
    end += b.len;
  }
  if (bytes.length === 0) return null;
  if (!bytes.some((n) => n > 0x7f)) return { chars: bytes.map(ansiCByte), end };
  try {
    return { chars: [...UTF8.decode(Uint8Array.from(bytes))].map((ch) => ansiCPoint(ch.codePointAt(0)!)), end };
  } catch {
    return { chars: bytes.map(ansiCByte), end };
  }
}

/**
 * A `$'…'` body's chars as bash decodes them, null for an escape whose result
 * is unknown: `\x` / `\u` / `\U` with no hex digit, a `\x` or `\NNN` byte past
 * 0x7F, a NUL, an invalid code point, `\c` with no letter after it or with `\`
 * or `?` (bash versions differ), a lone trailing backslash. An escape bash
 * does not know keeps its backslash. With `utf8`, a run of adjacent byte
 * escapes that is valid UTF-8 gives its chars, as bash in a UTF-8 locale
 * writes them (GH 2765).
 */
export function ansiCChars(body: string, utf8 = false): Array<string | null> {
  const out: Array<string | null> = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      out.push(c);
      continue;
    }
    const run = utf8 ? utf8Run(body, i) : null;
    if (run) {
      out.push(...run.chars);
      i = run.end - 1;
      continue;
    }
    const e = body[i + 1];
    if (e === undefined) {
      out.push(null);
      continue;
    }
    const simple = ANSI_C_SIMPLE.get(e);
    const digits = ANSI_C_DIGITS.get(e);
    const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1));
    if (simple !== undefined) {
      out.push(simple);
      i++;
    } else if (octal) {
      const n = parseInt(octal[0], 8);
      out.push(ansiCByte(n));
      i += octal[0].length;
    } else if (digits) {
      const hex = digits.re.exec(body.slice(i + 2));
      const point = e === 'x' ? ansiCByte : ansiCPoint;
      out.push(hex ? point(parseInt(hex[0], digits.radix)) : null);
      i += 1 + (hex ? hex[0].length : 0);
    } else if (e === 'c') {
      const x = body[i + 2];
      out.push(x === undefined || x === '\\' || x === '?' || x.charCodeAt(0) > 0x7f ? null : ansiCPoint(x.toUpperCase().charCodeAt(0) & 0x1f));
      i += x === undefined ? 1 : 2;
    } else {
      out.push('\\', e);
      i++;
    }
  }
  return out;
}

/** Every `$` in `text` is a plain `$NAME` not followed by `[`, or exactly `${NAME}`. */
export function plainDollars(text: string): boolean {
  let m: number;
  while ((m = text.indexOf('$')) >= 0) {
    text = text.slice(m + 1);
    const braced = /^\{[A-Za-z_][A-Za-z0-9_]*\}/.exec(text);
    const plain = braced ? null : /^[A-Za-z_][A-Za-z0-9_]*/.exec(text);
    if (braced) text = text.slice(braced[0].length);
    else if (plain && text[plain[0].length] !== '[') text = text.slice(plain[0].length);
    else return false;
  }
  return true;
}

const DECODE: ReadonlyMap<string, string> = new Map([
  ...[...NEUTRAL, '\n'].map((c, i): [string, string] => [i < 10 ? ENC[i + 1] : ENC[12], c]),
  [SUB_PO, '('],
  [SUB_PC, ')'],
  [DOLLAR, '$'],
]);

export function decode(text: string): string {
  return text.replace(/[\x01-\x06\x0e-\x11\x13\x15\x16\x19]/g, (c) => DECODE.get(c) ?? c);
}

/** `decode`, each DOLLAR kept: a path or value the write-path analyzer expands, its literal `$` passed through as text. */
export function decodeKeepDollar(text: string): string {
  return text.replace(/[\x01-\x06\x0e-\x11\x13\x15\x16]/g, (c) => DECODE.get(c) ?? c);
}

/** A literal QM, or with `marks` a literal MKTEMP_MARK or DOLLAR, read as computed text rather than a mark. */
const literalMark = (c: string, marks: boolean): boolean => c === QM || (marks && (c === MKTEMP_MARK || c === DOLLAR));

/** One char of quoted or escaped text; a missing char (a line's end) is \001, as awk's index(s, "") is 1. */
function neutral(c: string | undefined, marks: boolean): string {
  if (c === undefined || c === '' || c === '\n') return ENC[1];
  if (literalMark(c, marks)) return QM_LITERAL;
  const k = NEUTRAL.indexOf(c);
  return k >= 0 ? ENC[k + 1] : c;
}

const SPECIAL = new Set(['comment', 'string', 'raw_string', 'ansi_c_string', 'translated_string', 'heredoc_redirect']);

type Span = { start: number; end: number; node: Node };

/** A heredoc body's source lines: from the line `from` starts on up to its end delimiter's line, as tmb_cmd_strip_literals reads them. */
function bodyText(src: string, from: Node, end: Node): string {
  const lineStart = src.lastIndexOf('\n', from.startIndex - 1) + 1;
  const endStart = src.lastIndexOf('\n', end.startIndex - 1) + 1;
  return endStart > lineStart ? src.slice(lineStart, endStart) : '';
}

const plainBody = (body: string): boolean => !body.includes('`') && plainDollars(body);

/** Spends units of the analysis in progress; the write-path analyzer's throws past its cap. */
export type Charge = (units: number) => void;

export const NO_CHARGE: Charge = () => {};

const MKTEMP_ARGS = new Set(['word', 'string', 'raw_string', 'simple_expansion', 'expansion', 'concatenation']);

/** A substitution whose body is one plain `mktemp` call of a shape `mktempCall` admits, no argument holding a blank, paren, backtick, backslash or substitution. */
function mktempSub(sub: Node): boolean {
  const body = sub.namedChildren.filter((c): c is Node => c !== null);
  if (body.length !== 1 || body[0].type !== 'command') return false;
  const [name, ...args] = body[0].namedChildren.filter((c): c is Node => c !== null);
  if (name?.type !== 'command_name' || name.text !== 'mktemp') return false;
  const plain = (a: Node): boolean => MKTEMP_ARGS.has(a.type) && !/[\s()`\\]/.test(a.text) && a.descendantsOfType(CODE_EXPANSIONS).length === 0;
  return args.every(plain) && mktempCall(['mktemp', ...args.map((a) => a.text.replace(/["']/g, ''))]) !== null;
}

function specials(node: Node, out: Span[], charge: Charge, marks: boolean): Span[] {
  charge(1);
  if (SPECIAL.has(node.type) || (marks && node.type === 'command_substitution' && mktempSub(node))) {
    out.push({ start: node.startIndex, end: node.endIndex, node });
    return out;
  }
  for (const child of node.children) if (child) specials(child, out, charge, marks);
  return out;
}

/** What the git listing reads heredoc code with: the parser, and the encoded skeleton of a substitution's code, or null when it does not parse. */
export interface HeredocCode {
  readonly parser: Parser;
  readonly code: (code: string) => string | null;
}

/** A HeredocCode that encodes with <parser>, heredocs in the code read the same way. */
export function heredocEncoder(parser: Parser, charge: Charge = NO_CHARGE): HeredocCode {
  return {
    parser,
    code: (code) => {
      const encoded = encode(parser, code, charge, false, false, true);
      return encoded.ok ? encoded.text : null;
    },
  };
}

/** The outermost command substitutions under <node>, `$(( ))` arithmetic searched through. */
function outerSubstitutions(node: Node, out: Node[] = []): Node[] {
  for (const child of node.children) {
    if (child?.type === 'command_substitution') out.push(child);
    else if (child) outerSubstitutions(child, out);
  }
  return out;
}

/**
 * Whether the heredoc-body command_substitution <sub> is a `$(( ))` bash
 * reads as arithmetic that runs no command (GH 2876). tree-sitter-bash parses
 * a body's `$((W=0))` as $( ) around the subshell `(W=0)`; bash reads it as
 * arithmetic when one paren group closes right before the final `)`, so
 * `$((a);(b))` and `$((a) )` stay command substitutions. Only text made of
 * arithmetic characters counts: zsh ignores quoted parens when matching
 * `$(( ))`, so it runs `$((echo ")";cmd))` as a command (F823-1), and any
 * quote, `;`, `&`, `|`, newline, `$` or backtick keeps the code listed.
 */
const ARITHMETIC_ONLY = /^[A-Za-z0-9_ \t+\-*/%=<>!~^?:,()[\]]*$/;

function commandFreeArithmetic(src: string, sub: Node): boolean {
  const [open, inner, close, ...more] = sub.children;
  if (!open || !inner || !close || more.length > 0) return false;
  if (inner.type !== 'subshell' || inner.startIndex !== open.endIndex || inner.endIndex !== close.startIndex) return false;
  return ARITHMETIC_ONLY.test(src.slice(inner.startIndex, inner.endIndex));
}

/**
 * The code of each outermost $( ) and backtick of an unquoted-delimiter
 * heredoc body, <body> its heredoc_body node in the tree of <src> and
 * [from, to) its text (GH 2635). A $( ) is the parse tree's
 * command_substitution, so it ends where bash's parser ends it (a comment's
 * `)` closes nothing). tree-sitter-bash reads no backtick in a body, so a
 * backtick is read from the text outside those nodes: up to the next
 * unescaped backtick, as bash reads it, a backslash dropped before a
 * backtick, `$` or backslash. Null at an unclosed backtick or a $( ) that a
 * backtick's end cuts.
 */
export function bodyCodes(src: string, body: Node, from: number, to: number): string[] | null {
  const subs = outerSubstitutions(body).filter((sub) => src[sub.startIndex] !== '`');
  const out: string[] = [];
  let next = 0;
  for (let i = from; i < to; i++) {
    while (next < subs.length && subs[next].endIndex <= i) next++;
    const sub = subs[next];
    if (sub && sub.startIndex <= i) {
      const open = sub.firstChild;
      const close = sub.lastChild;
      if (!open || !close || close.type !== ')') return null;
      if (!commandFreeArithmetic(src, sub)) out.push(src.slice(open.endIndex, close.startIndex));
      i = sub.endIndex - 1;
      continue;
    }
    const c = src[i];
    if (c === '\\') i++;
    else if (c === '`') {
      let code = '';
      let j = i + 1;
      for (; j < to && src[j] !== '`'; j++) {
        if (src[j] === '\\' && /[`$\\]/.test(src[j + 1] ?? '')) j++;
        code += src[j];
      }
      if (j >= to) return null;
      for (; next < subs.length && subs[next].startIndex < j; next++) if (subs[next].endIndex > j) return null;
      out.push(code);
      i = j;
    }
  }
  return out;
}

/**
 * The code of an unquoted-delimiter heredoc's body (bodyCodes), its
 * heredoc_body <body> in <src> up to its end delimiter's line at <endLine>.
 * A `<<-` body is read again with its leading tabs stripped, as bash strips
 * them before it expands the body, since tree-sitter-bash parses no
 * substitution in it; null where that does not parse.
 */
function heredocCodes(parser: Parser, src: string, body: Node, endLine: number, delim: string, tabs: boolean): string[] | null {
  if (!tabs) return bodyCodes(src, body, body.startIndex, endLine);
  const lineStart = src.lastIndexOf('\n', body.startIndex - 1) + 1;
  const text = src.slice(lineStart, endLine).replace(/^\t+/gm, '');
  const again = `: <<${delim}\n${text}${delim}\n`;
  const tree = parser.parse(again);
  if (!tree) return null;
  try {
    const root = tree.rootNode;
    if (root.hasError || broken(root)) return null;
    const node = root.descendantsOfType('heredoc_body')[0];
    return node ? bodyCodes(again, node, node.startIndex, again.length - delim.length - 1) : [];
  } finally {
    tree.delete();
  }
}

function substitutions(node: Node, out: Node[], charge: Charge): Node[] {
  charge(1);
  for (const child of node.children) {
    if (!child) continue;
    if (child.type === 'command_substitution' || child.type === 'arithmetic_expansion') out.push(child);
    else substitutions(child, out, charge);
  }
  return out;
}

export class Encoder {
  constructor(
    private readonly src: string,
    private readonly charge: Charge,
    private readonly marks = false,
    private readonly shownControls = false,
    private readonly heredocCode: HeredocCode | null = null,
  ) {}

  /** Whether a heredoc substitution's code did not parse or a body's substitution is unclosed. */
  failed = false;

  /** One char of quoted or escaped text; with `marks`, a `$` bash keeps literal is DOLLAR. */
  private literal(c: string | undefined, dollar: boolean): string {
    return dollar && this.marks && c === '$' ? DOLLAR : neutral(c, this.marks);
  }

  /** `$` at src[i] starts no expansion, so bash keeps it literal (GH 2451). */
  private literalDollar(i: number): boolean {
    const next = this.src[i + 1];
    return next === undefined || !/[A-Za-z0-9_@*#?$!{(`-]/.test(next);
  }

  /** Unquoted text: a backslash escapes the next char; a backslash-newline is dropped, as bash joins the lines (GH 2646). */
  private plain(from: number, to: number): string {
    const { src } = this;
    let out = '';
    for (let i = from; i < to; i++) {
      const c = src[i];
      if (c !== '\\') {
        if (this.marks && c === '$' && i + 1 < to && src[i + 1] === '$') {
          // `$$` is the shell's pid, an expansion: neither `$` is literal (GH 2451).
          out += '$$';
          i++;
        } else if (c === '$' && this.marks && this.literalDollar(i)) out += DOLLAR;
        else out += literalMark(c, this.marks) ? QM_LITERAL : c;
        continue;
      }
      const next = i + 1 < to ? src[i + 1] : undefined;
      if (next !== '\n') out += QM + this.literal(next, true);
      if (next !== undefined) i++;
    }
    return out;
  }

  /** Quoted text: every char neutral, a newline the joiner; `escapes` drops a backslash before the char it escapes, and a backslash-newline whole; `literal` keeps every `$` literal, else only one that starts no expansion. */
  private quoted(from: number, to: number, escapes: boolean, literal: boolean): string {
    const { src } = this;
    let out = '';
    for (let i = from; i < to; i++) {
      const c = src[i];
      if (c === '\n') out += JOINER;
      else if (escapes && c === '\\') {
        const next = i + 1 < to ? src[i + 1] : undefined;
        if (next !== '\n') out += this.literal(next, true);
        if (next !== undefined) i++;
      } else if (!literal && c === '$' && i + 1 < to && src[i + 1] === '$') {
        // `$$` is the shell's pid in "…" too, never a literal `$` (GH 2451).
        out += '$$';
        i++;
      } else out += this.literal(c, literal || (c === '$' && this.literalDollar(i)));
    }
    return out;
  }

  /** A `$'…'` body as bash decodes it (GH 2640): a newline the joiner, a tab neutral, an undecodable escape COMPUTED, any other control char COMPUTED or with `shownControls` CONTROL_SHOWN; with `shownControls` a valid UTF-8 run of byte escapes is its chars (GH 2765). */
  private ansiC(from: number, to: number): string {
    let out = '';
    for (const c of ansiCChars(this.src.slice(from, to), this.shownControls)) {
      if (c === null) out += COMPUTED;
      else if (c === '\n') out += JOINER;
      else if (c !== '\t' && /[\x00-\x1f\x7f]/.test(c)) out += this.shownControls ? CONTROL_SHOWN : COMPUTED;
      else out += this.literal(c, true);
    }
    return out;
  }

  /** A substitution opened at `start`, framed by QO … QC with its body encoded as shell syntax, led by MKTEMP_MARK for a mktemp call (GH 1912). */
  private frame(sub: Node, start: number): string {
    const open = this.src.startsWith('$(', start) ? 2 : 1;
    const mark = this.marks && sub.type === 'command_substitution' && mktempSub(sub) ? MKTEMP_MARK : '';
    return QO + mark + this.range(sub, start + open, sub.endIndex - 1) + QC;
  }

  /** Where a substitution's `$(` or backtick starts: tree-sitter-bash folds the blanks after a preceding expansion into the opener token (`"$(a) $(b)"`). */
  private opener(sub: Node): number {
    const first = sub.firstChild;
    if (!first) return sub.startIndex;
    const tok = this.src.slice(first.startIndex, first.endIndex);
    return first.startIndex + tok.length - tok.trimStart().length;
  }

  private dquoted(node: Node, from: number, to: number): string {
    let out = '';
    let at = from;
    for (const sub of substitutions(node, [], this.charge)) {
      if (sub.startIndex < from || sub.endIndex > to) continue;
      const start = this.opener(sub);
      out += this.quoted(at, start, true, false) + this.frame(sub, start);
      at = sub.endIndex;
    }
    return out + this.quoted(at, to, true, false);
  }

  private heredoc(node: Node): { text: string; skipTo: number; rest: Span[] } {
    const kids = node.children.filter((c): c is Node => c !== null);
    const start = kids.find((c) => c.type === 'heredoc_start');
    const body = kids.find((c) => c.type === 'heredoc_body');
    const end = kids.find((c) => c.type === 'heredoc_end');
    const word = start ? this.src.slice(start.startIndex, start.endIndex) : '';
    const delim = word.replace(/['"\\]/g, '');
    const data = /['"\\]/.test(word) || (end !== undefined && plainBody(bodyText(this.src, body ?? end, end)));
    const rest: Span[] = [];
    const opEnd = start ? start.endIndex : node.startIndex + 2;
    for (const c of kids) {
      if (c.startIndex >= opEnd && c !== body && c !== end) specials(c, rest, this.charge, this.marks);
    }
    const dropFrom = body?.startIndex ?? end?.startIndex ?? node.endIndex;
    let dropTo = end?.endIndex ?? node.endIndex;
    if (end && this.src[dropTo] === '\n') dropTo++;
    let code = '';
    if (this.heredocCode && body && end && !/['"\\]/.test(word)) {
      const endLine = this.src.lastIndexOf('\n', end.startIndex - 1) + 1;
      const subs = heredocCodes(this.heredocCode.parser, this.src, body, endLine, delim, kids.some((c) => c.type === '<<-'));
      for (const sub of subs ?? []) {
        const text = this.heredocCode.code(sub);
        if (text === null) this.failed = true;
        else code += ` ${QO}${text}${QC}`;
      }
      if (subs === null) this.failed = true;
    }
    return { text: '<<' + (delim === '' ? '' : data ? HD_DATA : HD_EXP) + delim + code, skipTo: opEnd, rest: [...rest, { start: dropFrom, end: dropTo, node }] };
  }

  /** One word node, encoded as `range` encodes it inside its command. */
  word(node: Node): string {
    return this.spans(specials(node, [], this.charge, this.marks), node.startIndex, node.endIndex);
  }

  /** [at, end) of `node`'s source, `at` a word's start, encoded as `word` encodes it. */
  from(node: Node, at: number): string {
    return this.spans(
      specials(node, [], this.charge, this.marks).filter((s) => s.start >= at),
      at,
      node.endIndex,
    );
  }

  /** [from, to) of `node`'s source, encoded as unquoted shell text. */
  range(node: Node, from: number, to: number): string {
    const spans = node.children
      .filter((c): c is Node => c !== null)
      .flatMap((c) => specials(c, [], this.charge, this.marks))
      .filter((s) => s.start >= from && s.end <= to);
    return this.spans(spans, from, to);
  }

  private spans(spans: Span[], from: number, to: number): string {
    this.charge(to - from);
    let out = '';
    let at = from;
    const queue = [...spans].sort((a, b) => a.start - b.start);
    while (queue.length) {
      const span = queue.shift()!;
      if (span.start < at) continue;
      out += this.plain(at, span.start);
      const { node } = span;
      if (span.node.type === 'heredoc_redirect' && span.start === node.startIndex && span.end === node.endIndex) {
        const h = this.heredoc(node);
        out += h.text;
        at = h.skipTo;
        queue.push(...h.rest.filter((s) => s.start >= at && s.end <= to));
        queue.sort((a, b) => a.start - b.start);
        continue;
      }
      at = span.end;
      switch (node.type) {
        case 'heredoc_redirect':
        case 'comment':
          break;
        case 'string':
          out += QM + this.dquoted(node, span.start + 1, span.end - 1);
          break;
        case 'translated_string':
          out += '$' + QM + this.dquoted(node, span.start + 2, span.end - 1);
          break;
        case 'raw_string':
          out += QM + this.quoted(span.start + 1, span.end - 1, false, true);
          break;
        case 'ansi_c_string':
          out += QM + this.ansiC(span.start + 2, span.end - 1);
          break;
        case 'command_substitution':
          out += this.frame(node, span.start);
          break;
      }
    }
    return out + this.plain(at, to);
  }
}

export interface Heredoc {
  delim: string;
  body: string;
  /** The delimiter is unquoted and the body holds an expansion, so the shell fills part of it in (GH 1739). */
  expands: boolean;
}

/**
 * `held` (GH 1739): the `heldKey` of every command or herestring word that
 * holds an expansion outside single quotes, so part of its text is filled in
 * by the shell at run time. `spliced` (GH 1913): the `heldKey` of every
 * command word each of whose `$` is a `$NAME` / `${NAME}` expansion, with no
 * backtick or substitution, unless a command or redirect word of the same key
 * holds a `$` or backtick of any other kind.
 */
export type Encoded = { ok: true; text: string; heredocs: Heredoc[]; held: Set<string>; spliced: Set<string> } | { ok: false };

const EXPANSIONS = ['simple_expansion', 'expansion', 'command_substitution', 'arithmetic_expansion', 'process_substitution'];

const expands = (node: Node): boolean => node.descendantsOfType(EXPANSIONS).length > 0;

/** The text an encoded word is matched on in `Encoded.held`: decoded, a substitution frame shown as `$(` … `)`. */
export function heldKey(word: string): string {
  return decode(word).replaceAll(QM, '').replace(/\x07/g, '$(').replace(/\x08/g, ')');
}

/** One shell word: its tree-sitter-bash nodes, more than one where a backslash-newline joins them (GH 1978), and whether a redirect holds part of it. */
type ShellWord = { nodes: Node[]; redirect: boolean; joined: boolean };

/** Each word of the `parents` nodes under `root` as bash reads it, a node a backslash-newline joins to the one before it being part of that word. */
function shellWords(src: string, root: Node, parents: string[]): ShellWord[] {
  const units = root.descendantsOfType(parents).flatMap((parent) =>
    parent ? parent.namedChildren.flatMap((node) => (node && !/^(file|herestring)_redirect$/.test(node.type) ? [{ node, redirect: parent.type !== 'command' }] : [])) : [],
  );
  const at = new Map<number, (typeof units)[number]>();
  for (const unit of units) if (!at.has(unit.node.startIndex)) at.set(unit.node.startIndex, unit);
  const next = (unit: (typeof units)[number]): (typeof units)[number] | undefined => {
    let pos = unit.node.endIndex;
    while (src.startsWith('\\\n', pos)) pos += 2;
    return pos > unit.node.endIndex ? at.get(pos) : undefined;
  };
  const tails = new Set(units.map(next));
  return units
    .filter((unit) => !tails.has(unit))
    .map((head) => {
      const chain = [head];
      for (let n = next(head); n && !chain.includes(n); n = next(n)) chain.push(n);
      const nodes = chain.map((u) => u.node);
      return { nodes, redirect: chain.some((u) => u.redirect), joined: src.slice(nodes[0].startIndex, nodes.at(-1)!.endIndex).includes('\\\n') };
    });
}

const wordKey = (encoder: Encoder, word: ShellWord): string => heldKey(word.nodes.map((node) => encoder.word(node)).join(''));

/** A word held as `Encoded.held` says, or one a backslash-newline runs through that holds a `$` or backtick, or one holding a `$'…'` escape left COMPUTED. */
function heldWords(encoder: Encoder, src: string, root: Node): Set<string> {
  const held = new Set<string>();
  for (const word of shellWords(src, root, ['command', 'herestring_redirect'])) {
    const text = word.nodes.map((node) => encoder.word(node)).join('');
    const key = heldKey(text);
    if (word.nodes.some(expands) || text.includes(COMPUTED) || (word.joined && /[$`]/.test(key))) held.add(key);
  }
  return held;
}

const PLAIN_EXPANSIONS = ['simple_expansion', 'expansion'];
const CODE_EXPANSIONS = ['command_substitution', 'arithmetic_expansion', 'process_substitution'];

function splicedWords(encoder: Encoder, src: string, root: Node): Set<string> {
  const plain = new Set<string>();
  const opaque = new Set<string>();
  for (const word of shellWords(src, root, ['command', 'file_redirect', 'herestring_redirect'])) {
    const key = wordKey(encoder, word);
    const dollars = key.split('$').length - 1;
    if (dollars === 0 && !key.includes('`')) continue;
    const count = (types: string[]): number => word.nodes.reduce((n, node) => n + node.descendantsOfType(types).length, 0);
    const spliced = !word.redirect && !word.joined && !key.includes('`') && count(CODE_EXPANSIONS) === 0 && count(PLAIN_EXPANSIONS) === dollars;
    (spliced ? plain : opaque).add(key);
  }
  for (const key of opaque) plain.delete(key);
  return plain;
}

function broken(node: Node): boolean {
  if (node.isError || node.isMissing) return true;
  if (!node.hasError) return false;
  return node.children.some((c) => c !== null && broken(c));
}

/**
 * tmb_cmd_strip_literals' `bodies`: each heredoc's delimiter and its body
 * lines (leading tabs stripped for <<-), as _tmb_cmd_write_paths_in reads them
 * back: outer tabs and trailing newlines trimmed.
 */
function heredocs(src: string, root: Node): Heredoc[] {
  return root.descendantsOfType('heredoc_redirect').flatMap((node) => {
    if (!node) return [];
    const kids = node.children.filter((c): c is Node => c !== null);
    const start = kids.find((c) => c.type === 'heredoc_start');
    const end = kids.find((c) => c.type === 'heredoc_end');
    if (!start || !end) return [];
    const bodyNode = kids.find((c) => c.type === 'heredoc_body');
    const from = bodyNode?.startIndex ?? end.startIndex;
    const tabs = kids.some((c) => c.type === '<<-');
    const lineStart = src.lastIndexOf('\n', from - 1) + 1;
    const endStart = src.lastIndexOf('\n', end.startIndex - 1) + 1;
    let lines = endStart > lineStart ? src.slice(lineStart, endStart - 1).split('\n') : [];
    if (tabs) lines = lines.map((l) => l.replace(/^\t+/, ''));
    const body = lines.join('\n').replace(/^\t+/, '').replace(/\t+$/, '').replace(/\n+$/, '');
    return [{ delim: src.slice(start.startIndex, start.endIndex).replace(/['"\\]/g, ''), body, expands: bodyNode !== undefined && expands(bodyNode) }];
  });
}

/**
 * Where bash ends a heredoc whose body starts at `at`: the [start, stop) of
 * the first line that is exactly `delim` once read as bash reads it, an
 * unquoted delimiter's body lines joined across each backslash-newline the
 * backslash is not itself escaped in, then leading tabs stripped for <<-
 * (F753-1); null when no line is.
 */
function bashHeredocEnd(src: string, at: number, delim: string, joins: boolean, tabs: boolean): { start: number; stop: number } | null {
  let start = at;
  let text = '';
  for (;;) {
    const nl = src.indexOf('\n', at);
    const stop = nl < 0 ? src.length : nl;
    const physical = src.slice(at, stop);
    if (joins && nl >= 0 && /\\*$/.exec(physical)![0].length % 2 === 1) {
      text += physical.slice(0, -1);
      at = nl + 1;
      continue;
    }
    text += physical;
    if ((tabs ? text.replace(/^\t+/, '') : text) === delim) return { start, stop };
    if (nl < 0) return null;
    at = start = nl + 1;
    text = '';
  }
}

/**
 * GH 1927: bash ends a heredoc at the first line that is exactly its
 * delimiter (the start word with quotes and backslashes removed, leading tabs
 * stripped for <<-, an unquoted delimiter's body read across backslash-newline
 * joins). A heredoc tree-sitter-bash ends on another line, or past a body line
 * bash would end it on, has misread where the command resumes.
 */
function heredocMisread(src: string, root: Node): boolean {
  return root.descendantsOfType('heredoc_redirect').some((node) => {
    if (!node) return false;
    const kids = node.children.filter((c): c is Node => c !== null);
    const start = kids.find((c) => c.type === 'heredoc_start');
    const end = kids.find((c) => c.type === 'heredoc_end');
    if (!start || !end) return true;
    const word = src.slice(start.startIndex, start.endIndex);
    const delim = word.replace(/['"\\]/g, '');
    const tabs = kids.some((c) => c.type === '<<-');
    const from = kids.find((c) => c.type === 'heredoc_body')?.startIndex ?? end.startIndex;
    const bash = bashHeredocEnd(src, src.lastIndexOf('\n', from - 1) + 1, delim, !/['"\\]/.test(word), tabs);
    const endStart = src.lastIndexOf('\n', end.startIndex - 1) + 1;
    const endStop = src.indexOf('\n', end.startIndex);
    return bash === null || bash.start !== endStart || bash.stop !== (endStop < 0 ? src.length : endStop);
  });
}

/** The encoded skeleton of `command` and its heredocs, or not ok when the tree has an ERROR or MISSING node or misreads a heredoc's end (GH 1927); `marks` frames mktemp calls (GH 1912); `shownControls` gives a `$'…'` control char as CONTROL_SHOWN and a valid UTF-8 run of its byte escapes as its chars (GH 2765); `heredocCode` lists heredoc substitutions (GH 2635). */
export function encode(parser: Parser, command: string, charge: Charge = NO_CHARGE, marks = false, shownControls = false, heredocCode = false): Encoded {
  const tree = parser.parse(command);
  if (!tree) return { ok: false };
  try {
    const root = tree.rootNode;
    if (root.hasError || broken(root)) return { ok: false };
    if (command.includes('<<') && heredocMisread(command, root)) return { ok: false };
    const encoder = new Encoder(command, charge, marks, shownControls, heredocCode ? heredocEncoder(parser, charge) : null);
    const text = encoder.range(root, 0, command.length);
    if (encoder.failed) return { ok: false };
    return { ok: true, text, heredocs: command.includes('<<') ? heredocs(command, root) : [], held: heldWords(encoder, command, root), spliced: splicedWords(encoder, command, root) };
  } finally {
    tree.delete();
  }
}
