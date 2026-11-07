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
 * MKTEMP_MARK, and each `$` bash keeps literal is DOLLAR (GH 2443).
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
  ) {}

  /** One char of quoted or escaped text; with `marks`, a `$` bash keeps literal is DOLLAR. */
  private literal(c: string | undefined, dollar: boolean): string {
    return dollar && this.marks && c === '$' ? DOLLAR : neutral(c, this.marks);
  }

  /** Unquoted text: a backslash escapes the next char. */
  private plain(from: number, to: number): string {
    const { src } = this;
    let out = '';
    for (let i = from; i < to; i++) {
      const c = src[i];
      if (c !== '\\') {
        out += literalMark(c, this.marks) ? QM_LITERAL : c;
        continue;
      }
      const next = i + 1 < to ? src[i + 1] : undefined;
      out += QM + this.literal(next, true);
      if (next !== undefined && next !== '\n') i++;
    }
    return out;
  }

  /** Quoted text: every char neutral, a newline the joiner; `escapes` drops a backslash before the char it escapes; `literal` keeps every `$` literal, else only an escaped one. */
  private quoted(from: number, to: number, escapes: boolean, literal: boolean): string {
    const { src } = this;
    let out = '';
    for (let i = from; i < to; i++) {
      const c = src[i];
      if (c === '\n') out += JOINER;
      else if (escapes && c === '\\') {
        const next = i + 1 < to ? src[i + 1] : undefined;
        out += this.literal(next, true);
        if (next !== undefined && next !== '\n') i++;
      } else out += this.literal(c, literal);
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
    return { text: '<<' + (delim === '' ? '' : data ? HD_DATA : HD_EXP) + delim, skipTo: opEnd, rest: [...rest, { start: dropFrom, end: dropTo, node }] };
  }

  /** One word node, encoded as `range` encodes it inside its command. */
  word(node: Node): string {
    return this.spans(specials(node, [], this.charge, this.marks), node.startIndex, node.endIndex);
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
          out += QM + this.quoted(span.start + 2, span.end - 1, true, true);
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

function heldWords(encoder: Encoder, root: Node): Set<string> {
  const held = new Set<string>();
  for (const node of root.descendantsOfType(['command', 'herestring_redirect'])) {
    if (!node) continue;
    for (const word of node.namedChildren) {
      if (word && word.type !== 'file_redirect' && word.type !== 'herestring_redirect' && expands(word)) held.add(heldKey(encoder.word(word)));
    }
  }
  return held;
}

const PLAIN_EXPANSIONS = ['simple_expansion', 'expansion'];
const CODE_EXPANSIONS = ['command_substitution', 'arithmetic_expansion', 'process_substitution'];

function splicedWords(encoder: Encoder, root: Node): Set<string> {
  const plain = new Set<string>();
  const opaque = new Set<string>();
  const classify = (word: Node, redirect: boolean): void => {
    const key = heldKey(encoder.word(word));
    const dollars = key.split('$').length - 1;
    if (dollars === 0 && !key.includes('`')) return;
    const spliced =
      !redirect && !key.includes('`') && word.descendantsOfType(CODE_EXPANSIONS).length === 0 && word.descendantsOfType(PLAIN_EXPANSIONS).length === dollars;
    (spliced ? plain : opaque).add(key);
  };
  for (const node of root.descendantsOfType(['command', 'file_redirect', 'herestring_redirect'])) {
    if (!node) continue;
    const redirect = node.type !== 'command';
    for (const word of node.namedChildren) if (word && !/^(file|herestring)_redirect$/.test(word.type)) classify(word, redirect);
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

/** The source line holding `at`, without its newline. */
function lineAt(src: string, at: number): string {
  const end = src.indexOf('\n', at);
  return src.slice(src.lastIndexOf('\n', at - 1) + 1, end < 0 ? src.length : end);
}

/**
 * GH 1927: bash ends a heredoc at the first line that is exactly its
 * delimiter (the start word with quotes and backslashes removed, leading tabs
 * stripped for <<-). A heredoc tree-sitter-bash ends on another line, or past
 * a body line bash would end it on, has misread where the command resumes.
 */
function heredocMisread(src: string, root: Node): boolean {
  return root.descendantsOfType('heredoc_redirect').some((node) => {
    if (!node) return false;
    const kids = node.children.filter((c): c is Node => c !== null);
    const start = kids.find((c) => c.type === 'heredoc_start');
    const end = kids.find((c) => c.type === 'heredoc_end');
    if (!start || !end) return true;
    const delim = src.slice(start.startIndex, start.endIndex).replace(/['"\\]/g, '');
    const tabs = kids.some((c) => c.type === '<<-');
    const line = (text: string): string => (tabs ? text.replace(/^\t+/, '') : text);
    if (line(lineAt(src, end.startIndex)) !== delim) return true;
    const from = kids.find((c) => c.type === 'heredoc_body')?.startIndex ?? end.startIndex;
    const bodyStart = src.lastIndexOf('\n', from - 1) + 1;
    const endStart = src.lastIndexOf('\n', end.startIndex - 1) + 1;
    return endStart > bodyStart && src.slice(bodyStart, endStart - 1).split('\n').some((l) => line(l) === delim);
  });
}

/** The encoded skeleton of `command` and its heredocs, or not ok when the tree has an ERROR or MISSING node or misreads a heredoc's end (GH 1927); `marks` frames mktemp calls (GH 1912). */
export function encode(parser: Parser, command: string, charge: Charge = NO_CHARGE, marks = false): Encoded {
  const tree = parser.parse(command);
  if (!tree) return { ok: false };
  try {
    const root = tree.rootNode;
    if (root.hasError || broken(root)) return { ok: false };
    if (command.includes('<<') && heredocMisread(command, root)) return { ok: false };
    const encoder = new Encoder(command, charge, marks);
    const text = encoder.range(root, 0, command.length);
    return { ok: true, text, heredocs: command.includes('<<') ? heredocs(command, root) : [], held: heldWords(encoder, root), spliced: splicedWords(encoder, root) };
  } finally {
    tree.delete();
  }
}
