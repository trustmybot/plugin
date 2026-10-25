/**
 * The `keep` skeleton of tmb_cmd_strip_literals (cmd-analysis.sh), built from
 * a tree-sitter-bash tree instead of its line scanner: heredoc bodies and
 * comments dropped, quotes removed, every blank and operator character of
 * quoted or backslash-escaped text turned into a reversible control byte, and
 * a $( ) or backtick inside double quotes framed by QO … QC with its body
 * encoded as shell syntax again.
 */
import type { Node, Parser } from 'web-tree-sitter';

const NEUTRAL = ' \t<>|;&()`';

export const ENC: readonly string[] = ['', ...Array.from({ length: 12 }, (_, i) => String.fromCharCode(i < 6 ? i + 1 : i + 8))];
export const QO = '\x07';
export const QC = '\x08';
export const JOINER = ENC[12];
/** A quoted or escaped `(` / `)` inside a substitution that statements.ts frames as `$` ENC[8] … ENC[9]: decoded alike, told apart from the frame. */
export const SUB_PO = '\x15';
export const SUB_PC = '\x16';

const DECODE: ReadonlyMap<string, string> = new Map([
  ...[...NEUTRAL, '\n'].map((c, i): [string, string] => [i < 10 ? ENC[i + 1] : ENC[12], c]),
  [SUB_PO, '('],
  [SUB_PC, ')'],
]);

export function decode(text: string): string {
  return text.replace(/[\x01-\x06\x0e-\x11\x13\x15\x16]/g, (c) => DECODE.get(c) ?? c);
}

/** One char of quoted or escaped text; a missing char (a line's end) is \001, as awk's index(s, "") is 1. */
function neutral(c: string | undefined): string {
  if (c === undefined || c === '' || c === '\n') return ENC[1];
  const k = NEUTRAL.indexOf(c);
  return k >= 0 ? ENC[k + 1] : c;
}

const SPECIAL = new Set(['comment', 'string', 'raw_string', 'ansi_c_string', 'translated_string', 'heredoc_redirect']);

type Span = { start: number; end: number; node: Node };

function specials(node: Node, out: Span[]): Span[] {
  if (SPECIAL.has(node.type)) {
    out.push({ start: node.startIndex, end: node.endIndex, node });
    return out;
  }
  for (const child of node.children) if (child) specials(child, out);
  return out;
}

function substitutions(node: Node, out: Node[]): Node[] {
  for (const child of node.children) {
    if (!child) continue;
    if (child.type === 'command_substitution' || child.type === 'arithmetic_expansion') out.push(child);
    else substitutions(child, out);
  }
  return out;
}

export class Encoder {
  constructor(private readonly src: string) {}

  /** Unquoted text: a backslash escapes the next char. */
  private plain(from: number, to: number): string {
    const { src } = this;
    let out = '';
    for (let i = from; i < to; i++) {
      const c = src[i];
      if (c !== '\\') {
        out += c;
        continue;
      }
      const next = i + 1 < to ? src[i + 1] : undefined;
      out += neutral(next);
      if (next !== undefined && next !== '\n') i++;
    }
    return out;
  }

  /** Quoted text: every char neutral, a newline the joiner; `escapes` drops a backslash before the char it escapes. */
  private quoted(from: number, to: number, escapes: boolean): string {
    const { src } = this;
    let out = '';
    for (let i = from; i < to; i++) {
      const c = src[i];
      if (c === '\n') out += JOINER;
      else if (escapes && c === '\\') {
        const next = i + 1 < to ? src[i + 1] : undefined;
        out += neutral(next);
        if (next !== undefined && next !== '\n') i++;
      } else out += neutral(c);
    }
    return out;
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
    for (const sub of substitutions(node, [])) {
      if (sub.startIndex < from || sub.endIndex > to) continue;
      const start = this.opener(sub);
      out += this.quoted(at, start, true);
      const open = this.src.startsWith('$(', start) ? 2 : 1;
      out += QO + this.range(sub, start + open, sub.endIndex - 1) + QC;
      at = sub.endIndex;
    }
    return out + this.quoted(at, to, true);
  }

  private heredoc(node: Node): { text: string; skipTo: number; rest: Span[] } {
    const kids = node.children.filter((c): c is Node => c !== null);
    const start = kids.find((c) => c.type === 'heredoc_start');
    const body = kids.find((c) => c.type === 'heredoc_body');
    const end = kids.find((c) => c.type === 'heredoc_end');
    const delim = start ? this.src.slice(start.startIndex, start.endIndex).replace(/['"\\]/g, '') : '';
    const rest: Span[] = [];
    const opEnd = start ? start.endIndex : node.startIndex + 2;
    for (const c of kids) {
      if (c.startIndex >= opEnd && c !== body && c !== end) specials(c, rest);
    }
    const dropFrom = body?.startIndex ?? end?.startIndex ?? node.endIndex;
    let dropTo = end?.endIndex ?? node.endIndex;
    if (end && this.src[dropTo] === '\n') dropTo++;
    return { text: '<<' + delim, skipTo: opEnd, rest: [...rest, { start: dropFrom, end: dropTo, node }] };
  }

  /** One word node, encoded as `range` encodes it inside its command. */
  word(node: Node): string {
    return this.spans(specials(node, []), node.startIndex, node.endIndex);
  }

  /** [from, to) of `node`'s source, encoded as unquoted shell text. */
  range(node: Node, from: number, to: number): string {
    const spans = node.children
      .filter((c): c is Node => c !== null)
      .flatMap((c) => specials(c, []))
      .filter((s) => s.start >= from && s.end <= to);
    return this.spans(spans, from, to);
  }

  private spans(spans: Span[], from: number, to: number): string {
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
          out += this.dquoted(node, span.start + 1, span.end - 1);
          break;
        case 'translated_string':
          out += '$' + this.dquoted(node, span.start + 2, span.end - 1);
          break;
        case 'raw_string':
          out += this.quoted(span.start + 1, span.end - 1, false);
          break;
        case 'ansi_c_string':
          out += this.quoted(span.start + 2, span.end - 1, true);
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
 * by the shell at run time.
 */
export type Encoded = { ok: true; text: string; heredocs: Heredoc[]; held: Set<string> } | { ok: false };

const EXPANSIONS = ['simple_expansion', 'expansion', 'command_substitution', 'arithmetic_expansion', 'process_substitution'];

const expands = (node: Node): boolean => node.descendantsOfType(EXPANSIONS).length > 0;

/** The text an encoded word is matched on in `Encoded.held`: decoded, a substitution frame shown as `$(` … `)`. */
export function heldKey(word: string): string {
  return decode(word).replace(/\x07/g, '$(').replace(/\x08/g, ')');
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

/** The encoded skeleton of `command` and its heredocs, or not ok when the tree has an ERROR or MISSING node. */
export function encode(parser: Parser, command: string): Encoded {
  const tree = parser.parse(command);
  if (!tree) return { ok: false };
  try {
    const root = tree.rootNode;
    if (root.hasError || broken(root)) return { ok: false };
    const encoder = new Encoder(command);
    const text = encoder.range(root, 0, command.length);
    return { ok: true, text, heredocs: command.includes('<<') ? heredocs(command, root) : [], held: heldWords(encoder, root) };
  } finally {
    tree.delete();
  }
}
