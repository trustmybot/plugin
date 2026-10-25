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

const DECODE: ReadonlyMap<string, string> = new Map([...NEUTRAL, '\n'].map((c, i) => [i < 10 ? ENC[i + 1] : ENC[12], c]));

export function decode(text: string): string {
  return text.replace(/[\x01-\x06\x0e-\x11\x13]/g, (c) => DECODE.get(c) ?? c);
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

  private dquoted(node: Node, from: number, to: number): string {
    let out = '';
    let at = from;
    for (const sub of substitutions(node, [])) {
      if (sub.startIndex < from || sub.endIndex > to) continue;
      out += this.quoted(at, sub.startIndex, true);
      const open = this.src.startsWith('$(', sub.startIndex) ? 2 : 1;
      out += QO + this.range(sub, sub.startIndex + open, sub.endIndex - 1) + QC;
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

export type Encoded = { ok: true; text: string } | { ok: false };

function broken(node: Node): boolean {
  if (node.isError || node.isMissing) return true;
  if (!node.hasError) return false;
  return node.children.some((c) => c !== null && broken(c));
}

/** The encoded skeleton of `command`, or not ok when the tree has an ERROR or MISSING node. */
export function encode(parser: Parser, command: string): Encoded {
  const tree = parser.parse(command);
  if (!tree) return { ok: false };
  try {
    const root = tree.rootNode;
    if (root.hasError || broken(root)) return { ok: false };
    return { ok: true, text: new Encoder(command).range(root, 0, command.length) };
  } finally {
    tree.delete();
  }
}
