// Symbol and reference extraction for the L1 structural layer (GH 1680):
// TS/JS, bash and Python through tree-sitter, SQL DDL (in .sql files and in TS string
// literals) and Perl subs and constants through regexes. Pure functions: a
// file's text in, its symbols and outgoing references out. Adapted from the
// GH 1680 MVP.
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { IndexedGrammar, Parsers } from './loader.js';

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'const'
  | 'sh_function'
  | 'sql_table'
  | 'sql_index'
  | 'sql_trigger'
  | 'module'
  | 'hook'
  | 'runner';

export type EdgeKind =
  | 'calls'
  | 'imports'
  | 'instantiates'
  | 'sources'
  | 'runs'
  | 'reads_table'
  | 'writes_table'
  | 'indexes'
  | 'triggers_on'
  | 'bundles'
  | 'reads_config'
  | 'covers';

export type SourceLanguage = IndexedGrammar | 'sql' | 'perl';

export interface ExtractedSymbol {
  kind: SymbolKind;
  qualified_name: string;
  signature: string;
  doc: string;
  start_line: number;
  end_line: number;
  body_hash: string;
  exported: number;
  run_order?: number;
}

// src indexes Extraction.symbols. hint is the import specifier of an
// 'imports' edge, or the receiver of a member call: its class when the file
// types it (`C` for `obj: C` in obj.fn()), else its text (`obj`).
export interface ExtractedEdge {
  src: number;
  kind: EdgeKind;
  dst_name: string;
  line: number;
  hint: string | null;
}

export interface Extraction {
  symbols: ExtractedSymbol[];
  edges: ExtractedEdge[];
}

const GENERATED_PATH = [
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)node_modules\//,
  /(^|\/)vendor\//,
  /\.map$/,
  /\.min\.js$/,
];

const LOCKFILE_PATH = [/(^|\/)package-lock\.json$/, /\.lock(b)?$/];

const EXTENSION_LANGUAGE: Record<string, SourceLanguage> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  sh: 'bash',
  bash: 'bash',
  sql: 'sql',
  pl: 'perl',
  pm: 'perl',
  py: 'python',
};

const SH_BUILTINS = new Set(
  'echo printf local export declare readonly return exit set unset shift cd test [ [[ true false read eval exec trap wait source . if then else fi for do done while case esac cat grep sed awk tr cut head tail sort uniq wc mkdir rm cp mv ln chmod touch date sleep command type jq git basename dirname xargs find tee env mktemp pwd kill ps sqlite3 node bash sh python3 curl gh'.split(
    ' ',
  ),
);

export const STOPWORDS = new Set(
  'a an the and or of to in on for with by is are was were be been when where what which who how why does do did it its this that these those from as at into per not no than then there their them our we you i set get'.split(
    ' ',
  ),
);

export const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

export const DOC_MAX = 1000;

export function splitWords(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()
    .trim();
}

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

export const GATE_MODULE_DIR = 'mcp/trajectory-server/src/hooks';

export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__)\/|\.test\.[a-z]+$/.test(path);
}

// Build output, installed or vendored dependencies, source maps and minified
// bundles: the world model indexes none of them (GH 1835).
export function isGeneratedPath(relPath: string): boolean {
  return GENERATED_PATH.some((re) => re.test(relPath));
}

// A path is in symbol scope unless it is generated output or a lockfile.
export function inSymbolScope(relPath: string): boolean {
  return !isGeneratedPath(relPath) && !LOCKFILE_PATH.some((re) => re.test(relPath));
}

// The language a path parses as: by extension, else a perl or bash/sh shebang
// on an extensionless file; null when the file has no symbol extractor.
export function languageOf(relPath: string, head: () => string): SourceLanguage | null {
  const name = basename(relPath);
  const dot = name.lastIndexOf('.');
  if (dot > 0) return EXTENSION_LANGUAGE[name.slice(dot + 1).toLowerCase()] ?? null;
  const shebang = head().slice(0, 120);
  if (/^#!.*\bperl\b/.test(shebang)) return 'perl';
  return /^#!.*\b(bash|sh)\b/.test(shebang) ? 'bash' : null;
}

// Grammar-free languages: extracted by regex, with no tree-sitter parser.
export function needsParser(lang: SourceLanguage): lang is IndexedGrammar {
  return lang !== 'sql' && lang !== 'perl';
}

// The split-name text wm_symbols_fts indexes for a symbol.
export function symbolTerms(kind: SymbolKind, qualifiedName: string, relPath: string): string {
  return `${splitWords(qualifiedName)} ${kind.replace('_', ' ')} ${splitWords(basename(relPath))}`;
}

// The distinct non-stopword words of a body, for callers that rank on them.
export function bodyTerms(text: string): string {
  const seen = new Set<string>();
  for (const w of splitWords(text).split(' ')) if (w.length > 2 && !STOPWORDS.has(w)) seen.add(w);
  return [...seen].slice(0, 400).join(' ');
}

function normalizedHash(node: Node): string {
  const base = node.startIndex;
  let text = node.text;
  const comments = node
    .descendantsOfType('comment')
    .filter((c): c is Node => c !== null)
    .sort((a, b) => b.startIndex - a.startIndex);
  for (const c of comments) text = text.slice(0, c.startIndex - base) + text.slice(c.endIndex - base);
  return md5(oneLine(text));
}

// A comment line that is only a rule: after its marker, three or more of
// -=#*_~/ and spaces, e.g. `# -----` or `// ====`.
export function isRuleLine(line: string): boolean {
  const rest = line
    .replace(/^\s*(\/\*\*?|\/\/|#|\*)/, '')
    .replace(/\*\/\s*$/, '')
    .trim();
  return rest.length >= 3 && /^[-=#*_~/ ]+$/.test(rest);
}

// A rule line, or a framed title: three or more of one of - or =, then text,
// then three or more of the same, e.g. `# --- Section ---`.
export function isBannerLine(line: string): boolean {
  if (isRuleLine(line)) return true;
  const rest = line
    .replace(/^\s*(\/\*\*?|\/\/|#|\*)/, '')
    .replace(/\*\/\s*$/, '')
    .trim();
  return /^([-=])\1{2,}\s*\S.*?\s*\1{3,}$/.test(rest);
}

function afterLastBanner(lines: string[]): string[] {
  let last = -1;
  lines.forEach((l, i) => {
    if (isBannerLine(l)) last = i;
  });
  return lines.slice(last + 1);
}

// The comment block whose last row is the row right above a definition (or
// above its export), with no blank row between, from after its last banner
// line on; '' when nothing follows that banner.
export function docOf(node: Node): string {
  const anchor = node.parent?.type === 'export_statement' ? node.parent : node;
  const blocks: string[] = [];
  let edge = anchor.startPosition.row;
  let prev = anchor.previousNamedSibling;
  while (prev && prev.type === 'comment' && prev.endPosition.row === edge - 1) {
    blocks.unshift(prev.text);
    edge = prev.startPosition.row;
    prev = prev.previousNamedSibling;
  }
  const lines = afterLastBanner(blocks.flatMap((block) => block.split('\n')));
  const raw = lines
    .map((l) =>
      l
        .replace(/\*\//g, ' ')
        .replace(/^\s*(\/\*\*?|\*|\/\/+|#+)/gm, ' '),
    )
    .join(' ');
  return clip(oneLine(raw), DOC_MAX);
}

const STRING_PARTS = new Set(['string_fragment', 'escape_sequence']);

// The text of a `description:` value built from string literals, joined
// across `+` concatenation and template parts; null for any other value.
function descriptionText(pair: Node): string | null {
  if (pair.childForFieldName('key')?.text.replace(/['"]/g, '') !== 'description') return null;
  const value = pair.childForFieldName('value');
  if (!value || !['string', 'template_string', 'binary_expression', 'parenthesized_expression'].includes(value.type)) {
    return null;
  }
  const parts = value
    .descendantsOfType([...STRING_PARTS])
    .filter((n): n is Node => n !== null)
    .map((n) => n.text);
  const text = oneLine(parts.join(''));
  return /[a-z]{3}/i.test(text) ? text : null;
}

// A definition's text up to its body, on one line.
export function signatureOf(node: Node, src: string): string {
  const body = node.childForFieldName('body');
  const end = body ? body.startIndex : Math.min(node.endIndex, node.startIndex + 160);
  return clip(oneLine(src.slice(node.startIndex, end)), 200);
}

const SQL_HINT = /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|REPLACE)\b/;

function sqlRefs(text: string): Array<[EdgeKind, string]> {
  if (!SQL_HINT.test(text)) return [];
  const out: Array<[EdgeKind, string]> = [];
  for (const m of text.matchAll(
    /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?([A-Za-z_]\w*)/g,
  )) {
    out.push(['writes_table', m[1]!]);
  }
  for (const m of text.matchAll(/\b(?:FROM|JOIN)\s+["`]?([A-Za-z_]\w*)/g)) out.push(['reads_table', m[1]!]);
  for (const m of text.matchAll(/\bALTER\s+TABLE\s+["`]?([A-Za-z_]\w*)/g)) out.push(['writes_table', m[1]!]);
  return out;
}

const CONFIG_KEY = /^[\w.:-]+$/;
const UNKNOWN = '\u0000';
const CONFIG_SELECT = /\bSELECT\b[\s\S]*?\bFROM\s+["`]?plugin_config\b/i;
const SQL_WRITE = /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i;

// The plugin_config keys the SELECTs of a SQL text read, in order: each
// quoted literal a `key =` or `key IN (...)` test names, where a
// `?` or `?N` placeholder reads as params' value at its index (a null or
// missing value names no key).
function configKeyReads(sql: string, params: ReadonlyArray<string | null> = []): string[] {
  if (!/plugin_config/i.test(sql)) return [];
  let next = 0;
  const bound = sql.replace(/\?(\d*)/g, (_, n: string) => {
    const at = n ? Number(n) - 1 : next;
    next = Math.max(next, at + 1);
    const value = params[at];
    return typeof value === 'string' && CONFIG_KEY.test(value) ? `'${value}'` : UNKNOWN;
  });
  const keys = new Set<string>();
  for (const stmt of bound.split(';')) {
    const from = CONFIG_SELECT.exec(stmt);
    if (!from || SQL_WRITE.test(stmt)) continue;
    const where = stmt.slice(from.index + from[0].length);
    for (const m of where.matchAll(/\bkey\s*(?:=\s*'([^']*)'|IN\s*\(([^)]*)\))/gi)) {
      const literals = m[1] !== undefined ? [m[1]] : m[2]!.split(',').map((s) => /^\s*'([^']*)'\s*$/.exec(s)?.[1]);
      for (const k of literals) if (k !== undefined && CONFIG_KEY.test(k)) keys.add(k);
    }
  }
  return [...keys];
}

const literalText = (node: Node): string | null =>
  node.type === 'string' || (node.type === 'template_string' && !named(node).some((c) => c.type === 'template_substitution'))
    ? node.text.slice(1, -1)
    : null;

// Each name a file binds once with `const NAME = 'x'` (or a template literal
// with no substitutions) to its value; a name bound twice is dropped.
function stringConsts(root: Node): Map<string, string> {
  const seen = new Map<string, string | null>();
  for (const d of root.descendantsOfType('variable_declarator')) {
    const n = d?.childForFieldName('name');
    if (n?.type !== 'identifier' || d!.parent?.type !== 'lexical_declaration' || !/^const\b/.test(d!.parent.text)) continue;
    const value = d!.childForFieldName('value');
    const text = value ? literalText(value) : null;
    if (text === null) continue;
    seen.set(n.text, seen.has(n.text) && seen.get(n.text) !== text ? null : text);
  }
  const consts = new Map<string, string>();
  for (const [k, v] of seen) if (v !== null) consts.set(k, v);
  return consts;
}

// A string or template literal's text, with each `${NAME}` of a same-file
// const replaced by its value and every other substitution by UNKNOWN.
function boundSqlText(node: Node, consts: Map<string, string>): string {
  let text = node.text;
  const subs = named(node)
    .filter((c) => c.type === 'template_substitution')
    .sort((a, b) => b.startIndex - a.startIndex);
  for (const s of subs) {
    const expr = named(s);
    const value = expr.length === 1 && expr[0]!.type === 'identifier' ? consts.get(expr[0]!.text) : undefined;
    text = text.slice(0, s.startIndex - node.startIndex) + (value ?? UNKNOWN) + text.slice(s.endIndex - node.startIndex);
  }
  return text;
}

// The values of the parameter array passed right after a SQL literal in the
// same call: string literals and same-file consts, null for anything else.
function callParams(sqlNode: Node, consts: Map<string, string>): Array<string | null> {
  const array = sqlNode.parent?.type === 'arguments' ? sqlNode.nextNamedSibling : null;
  if (array?.type !== 'array') return [];
  return named(array).map((e) => literalText(e) ?? (e.type === 'identifier' ? (consts.get(e.text) ?? null) : null));
}

class Collector {
  readonly symbols: ExtractedSymbol[] = [];
  readonly edges: ExtractedEdge[] = [];
  private readonly byKey = new Map<string, number>();

  symbol(s: ExtractedSymbol): number {
    const key = `${s.kind}\u0000${s.qualified_name}`;
    const known = this.byKey.get(key);
    if (known !== undefined) return known;
    this.symbols.push(s);
    this.byKey.set(key, this.symbols.length - 1);
    return this.symbols.length - 1;
  }

  edge(src: number, kind: EdgeKind, dstName: string, line: number, hint: string | null = null): void {
    this.edges.push({ src, kind, dst_name: dstName, line, hint });
  }
}

function lineCounter(text: string, lineBase: number): (index: number) => number {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lineBase + lo + 1;
  };
}

function statementEnd(text: string, start: number, virtual: boolean): number {
  if (virtual) return text.indexOf(';', start);
  let depth = 0;
  let i = text.indexOf('(', start);
  for (; i >= 0 && i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) break;
  }
  return i;
}

function columnNames(stmt: string): string[] {
  const inner = stmt.slice(stmt.indexOf('(') + 1, stmt.lastIndexOf(')'));
  const cols: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      cols.push(cur);
      cur = '';
    } else cur += ch;
  }
  cols.push(cur);
  return cols
    .map((c) => c.trim().split(/\s+/)[0] ?? '')
    .filter((c) => c && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT|content|content_rowid|tokenize|--)/i.test(c));
}

function extractSqlDdl(text: string, out: Collector, moduleSymbol: number | null, lineBase = 0): void {
  const lineAt = lineCounter(text, lineBase);
  for (const m of text.matchAll(/CREATE\s+(VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi)) {
    const start = m.index;
    let end = statementEnd(text, start, Boolean(m[1]));
    if (end < 0) end = Math.min(text.length, start + 400);
    const stmt = text.slice(start, end + 1);
    const name = m[2]!;
    out.symbol({
      kind: 'sql_table',
      qualified_name: name,
      signature: clip(`${name}(${columnNames(stmt).join(', ')})`, 240),
      doc: '',
      start_line: lineAt(start),
      end_line: lineAt(end),
      body_hash: md5(oneLine(stmt)),
      exported: 0,
    });
  }
  for (const m of text.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)/gi)) {
    const line = lineAt(m.index);
    const id = out.symbol({
      kind: 'sql_index',
      qualified_name: m[1]!,
      signature: oneLine(m[0]),
      doc: '',
      start_line: line,
      end_line: line,
      body_hash: md5(m[0]),
      exported: 0,
    });
    out.edge(id, 'indexes', m[2]!, line);
  }
  for (const m of text.matchAll(/CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+([\s\S]*?)\bON\s+(\w+)([\s\S]*?)\bEND\b/gi)) {
    const line = lineAt(m.index);
    const id = out.symbol({
      kind: 'sql_trigger',
      qualified_name: m[1]!,
      signature: clip(oneLine(`${m[1]} ${m[2]} ON ${m[3]}`), 200),
      doc: '',
      start_line: line,
      end_line: lineAt(m.index + m[0].length),
      body_hash: md5(oneLine(m[0])),
      exported: 0,
    });
    out.edge(id, 'triggers_on', m[3]!, line);
    for (const [kind, table] of sqlRefs(m[4]!)) out.edge(id, kind, table, line);
  }
  if (moduleSymbol !== null) {
    for (const m of text.matchAll(/\bALTER\s+TABLE\s+(\w+)/gi)) out.edge(moduleSymbol, 'writes_table', m[1]!, lineAt(m.index));
  }
}

function named(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function']);

// The key of a self-naming registration pair (GH 1970): its value is a call
// whose argument chain holds a function value and, in some call, a string
// literal equal to the key, as in `x: requireRoles('x', [...], wrap(async () => ...))`.
function registeredKey(pair: Node): string | null {
  const keyNode = pair.childForFieldName('key');
  const value = pair.childForFieldName('value');
  if (!keyNode || value?.type !== 'call_expression') return null;
  const key = keyNode.type === 'property_identifier' ? keyNode.text : literalText(keyNode);
  if (!key) return null;
  let hasFn = false;
  let selfNamed = false;
  const walk = (call: Node): void => {
    const args = call.childForFieldName('arguments');
    if (!args) return;
    for (const arg of named(args)) {
      if (FUNCTION_VALUES.has(arg.type)) hasFn = true;
      else if (arg.type === 'call_expression') walk(arg);
      else if (literalText(arg) === key) selfNamed = true;
    }
  };
  walk(value);
  return hasFn && selfNamed ? key : null;
}

const GATE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const GATE_MENTIONS = [
  /dist\/hooks\.js[ \t]+([\w<>-]+)/g,
  /\brunGate\((['"])([^'"\n]*)\1/g,
  /\bconst\s+GATE\s*=\s*(['"])([^'"\n]*)\1/g,
];

// An l3 hook test runs its gate as a child process and never imports it
// (GH 1839): one 'runs' edge from the test module to each gate module it
// names, on the line of that gate's first mention.
function testGateRuns(src: string, out: Collector, moduleSymbol: number): void {
  const first = new Map<string, number>();
  for (const re of GATE_MENTIONS) {
    for (const m of src.matchAll(re)) {
      const name = m[m.length - 1]!;
      if (!GATE_NAME.test(name)) continue;
      const at = first.get(name);
      if (at === undefined || m.index < at) first.set(name, m.index);
    }
  }
  const lineAt = lineCounter(src, 0);
  for (const [name, index] of [...first].sort((a, b) => a[1] - b[1])) {
    out.edge(moduleSymbol, 'runs', `${GATE_MODULE_DIR}/${name}.ts`, lineAt(index));
  }
}

const annotatedType = (node: Node): string | undefined => {
  const t = node.childForFieldName('type')?.namedChildren[0];
  return t?.type === 'type_identifier' ? t.text : undefined;
};

// A long receiver expression is clipped with a trailing ellipsis so the edge
// stays a member call yet can match no `${type}.${method}` name.
const memberHint = (receiver: string): string =>
  receiver.length < 40 || /^[\w$]+$/.test(receiver) ? receiver : `${receiver.slice(0, 39)}…`;

// Receiver text to its declared or constructed class, per file, ignoring
// scope; a receiver seen with two different types is dropped.
function receiverTypes(root: Node): Map<string, string> {
  const seen = new Map<string, string | null>();
  const add = (key: string, type: string | undefined): void => {
    if (!type) return;
    const prev = seen.get(key);
    seen.set(key, prev === undefined || prev === type ? type : null);
  };
  for (const d of root.descendantsOfType('variable_declarator')) {
    const n = d?.childForFieldName('name');
    if (n?.type !== 'identifier') continue;
    const value = d!.childForFieldName('value');
    const ctor = value?.type === 'new_expression' ? value.childForFieldName('constructor') : null;
    add(n.text, annotatedType(d!) ?? (ctor?.type === 'identifier' ? ctor.text : undefined));
  }
  for (const p of root.descendantsOfType(['required_parameter', 'optional_parameter'])) {
    const n = p?.childForFieldName('pattern');
    if (n?.type !== 'identifier') continue;
    const type = annotatedType(p!);
    add(n.text, type);
    if (named(p!).some((c) => c.type === 'accessibility_modifier' || c.type === 'override_modifier') || /^readonly\b/.test(p!.text)) {
      add(`this.${n.text}`, type);
    }
  }
  for (const f of root.descendantsOfType('public_field_definition')) {
    const n = f?.childForFieldName('name');
    if (n?.type === 'property_identifier' || n?.type === 'private_property_identifier') add(`this.${n.text}`, annotatedType(f!));
  }
  const types = new Map<string, string>();
  for (const [k, v] of seen) if (v) types.set(k, v);
  return types;
}

interface ModuleBindings {
  aliases: Map<string, string>;
  names: Set<string>;
}

const importSource = (specifier: Node): string | undefined => {
  let stmt: Node | null = specifier.parent;
  while (stmt && stmt.type !== 'import_statement') stmt = stmt.parent;
  return stmt?.childForFieldName('source')?.text.slice(1, -1);
};

// The names an identifier may reference by value (GH 1988): each named import
// binding and each module-level function, class or function-valued const. An
// `import { A as B }` alias maps back to `A` only for a relative import of a
// name the file does not declare itself, so the edge resolves through the
// `imports` hint and never to an external module's name or a same-file `A`.
function moduleBindings(root: Node): ModuleBindings {
  const aliases = new Map<string, string>();
  const names = new Set<string>();
  const declared = new Set<string>();
  for (const s of root.descendantsOfType('import_specifier')) {
    const n = s?.childForFieldName('name')?.text;
    if (!n) continue;
    const alias = s!.childForFieldName('alias')?.text;
    names.add(alias ?? n);
    if (alias && importSource(s!)?.startsWith('.')) aliases.set(alias, n);
  }
  for (const top of named(root)) {
    const decl = top.type === 'export_statement' ? top.childForFieldName('declaration') : top;
    if (!decl) continue;
    if (decl.type === 'lexical_declaration' || decl.type === 'variable_declaration') {
      for (const d of named(decl)) {
        const n = d.childForFieldName('name');
        if (n?.type !== 'identifier') continue;
        declared.add(n.text);
        const value = d.childForFieldName('value');
        if (value && FUNCTION_VALUES.has(value.type)) names.add(n.text);
      }
      continue;
    }
    const n = decl.childForFieldName('name')?.text;
    if (!n) continue;
    declared.add(n);
    if (MODULE_CALLABLES.has(decl.type)) names.add(n);
  }
  for (const [alias, original] of aliases) if (declared.has(original)) aliases.delete(alias);
  return { aliases, names };
}

const MODULE_CALLABLES = new Set(['function_declaration', 'generator_function_declaration', 'class_declaration', 'abstract_class_declaration']);
const FUNCTION_SCOPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'function',
  'generator_function',
  'arrow_function',
  'method_definition',
]);
const BLOCK_SCOPES = new Set(['statement_block', 'switch_case', 'switch_default']);
const PATTERN_NAMES = ['identifier', 'shorthand_property_identifier_pattern'];

const bindsName = (pattern: Node | null, name: string): boolean =>
  pattern !== null &&
  (PATTERN_NAMES.includes(pattern.type) ? pattern.text === name : pattern.descendantsOfType(PATTERN_NAMES).some((p) => p?.text === name));

const declaresName = (stmt: Node, name: string): boolean => {
  if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') {
    return named(stmt).some((d) => d.type === 'variable_declarator' && bindsName(d.childForFieldName('name'), name));
  }
  return MODULE_CALLABLES.has(stmt.type) && stmt.childForFieldName('name')?.text === name;
};

// Whether a parameter or a declaration in an enclosing function or block,
// below the module, binds the name `node` reads.
function shadowed(node: Node, name: string): boolean {
  for (let a = node.parent; a && a.type !== 'program'; a = a.parent) {
    if (FUNCTION_SCOPES.has(a.type)) {
      if (bindsName(a.childForFieldName('parameters') ?? a.childForFieldName('parameter'), name)) return true;
      if (a.type !== 'function_declaration' && a.type !== 'generator_function_declaration' && a.childForFieldName('name')?.text === name) return true;
    } else if (BLOCK_SCOPES.has(a.type)) {
      if (named(a).some((s) => declaresName(s, name))) return true;
    } else if (a.type === 'for_statement') {
      const init = a.childForFieldName('initializer');
      if (init && declaresName(init, name)) return true;
    } else if (a.type === 'for_in_statement') {
      if (a.childForFieldName('kind') && bindsName(a.childForFieldName('left'), name)) return true;
    } else if (a.type === 'catch_clause') {
      if (bindsName(a.childForFieldName('parameter'), name)) return true;
    }
  }
  return false;
}

const isField = (parent: Node, field: string, node: Node): boolean => parent.childForFieldName(field)?.id === node.id;

// Whether an identifier sits where it is read as a value (GH 1988): a call
// argument, an object property value, an array element, an assigned or
// initial value, a return value, a local export specifier or a default export.
function inValuePosition(node: Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (node.type === 'shorthand_property_identifier') return p.type === 'object';
  switch (p.type) {
    case 'arguments':
    case 'array':
    case 'return_statement':
      return true;
    case 'pair':
    case 'variable_declarator':
      return isField(p, 'value', node);
    case 'assignment_expression':
      return isField(p, 'right', node);
    case 'export_statement':
      return isField(p, 'value', node);
    case 'export_specifier':
      return isField(p, 'name', node) && !p.parent?.parent?.childForFieldName('source');
    default:
      return false;
  }
}

function extractTs(root: Node, src: string, out: Collector, moduleSymbol: number, relPath: string): void {
  if (isTestPath(relPath)) testGateRuns(src, out, moduleSymbol);
  const types = receiverTypes(root);
  const consts = stringConsts(root);
  const bindings = moduleBindings(root);
  const target = (name: string): string => bindings.aliases.get(name) ?? name;
  const referenced = new Set<string>();
  const reference = (scope: number, kind: EdgeKind, name: string, at: Node): void => {
    const dst = target(name);
    const key = `${scope}\u0000${kind}\u0000${dst}`;
    if (referenced.has(key)) return;
    referenced.add(key);
    out.edge(scope, kind, dst, at.startPosition.row + 1);
  };
  const boundValue = (node: Node, name: string): boolean => bindings.names.has(name) && !shadowed(node, name);
  const definition = (node: Node, kind: SymbolKind, qualifiedName: string): number =>
    out.symbol({
      kind,
      qualified_name: qualifiedName,
      signature: signatureOf(node, src),
      doc: docOf(node),
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      body_hash: normalizedHash(node),
      exported: node.parent?.type === 'export_statement' ? 1 : 0,
    });

  const visit = (node: Node, scope: number, cls: string | null): void => {
    let inner = scope;
    let innerCls = cls;
    const t = node.type;
    const name = (): string | undefined => node.childForFieldName('name')?.text;
    if (t === 'function_declaration' || t === 'generator_function_declaration') {
      const n = name();
      if (n) inner = definition(node, 'function', n);
    } else if (t === 'class_declaration' || t === 'abstract_class_declaration') {
      const n = name();
      if (n) {
        inner = definition(node, 'class', n);
        innerCls = n;
      }
    } else if (t === 'method_definition' && cls) {
      const n = name();
      if (n) inner = definition(node, 'method', `${cls}.${n}`);
    } else if (t === 'interface_declaration') {
      const n = name();
      if (n) definition(node, 'interface', n);
    } else if (t === 'type_alias_declaration' || t === 'enum_declaration') {
      const n = name();
      if (n) definition(node, 'type', n);
    } else if (t === 'variable_declarator' && scope === moduleSymbol) {
      const decl = node.parent;
      const holder = decl?.parent?.type;
      const n = node.childForFieldName('name');
      if (decl && (holder === 'program' || holder === 'export_statement') && n?.type === 'identifier') {
        const value = node.childForFieldName('value');
        const isFn = value !== null && FUNCTION_VALUES.has(value.type);
        const bodyStart = value?.type === 'arrow_function' ? value.childForFieldName('body')?.startIndex : undefined;
        inner = out.symbol({
          kind: isFn ? 'function' : 'const',
          qualified_name: n.text,
          signature: clip(oneLine(src.slice(decl.startIndex, bodyStart ?? Math.min(decl.endIndex, decl.startIndex + 140))), 200),
          doc: docOf(decl),
          start_line: decl.startPosition.row + 1,
          end_line: decl.endPosition.row + 1,
          body_hash: normalizedHash(node),
          exported: holder === 'export_statement' ? 1 : 0,
        });
      }
    } else if (t === 'call_expression' || t === 'new_expression') {
      const fn = node.childForFieldName(t === 'call_expression' ? 'function' : 'constructor');
      let callee: string | undefined;
      let receiver: string | undefined;
      if (fn?.type === 'identifier') callee = target(fn.text);
      else if (fn?.type === 'member_expression') {
        callee = fn.childForFieldName('property')?.text;
        const objectNode = fn.childForFieldName('object');
        const object = objectNode?.text;
        if (objectNode?.type === 'identifier' && object !== undefined) {
          receiver = types.get(object) ?? target(object);
          if (/^[A-Z]/.test(object) && boundValue(objectNode, object)) reference(scope, 'calls', object, objectNode);
        } else receiver = object !== undefined ? (types.get(object) ?? object) : undefined;
      }
      if (callee) {
        out.edge(
          scope,
          t === 'call_expression' ? 'calls' : 'instantiates',
          callee,
          node.startPosition.row + 1,
          receiver === undefined ? null : memberHint(receiver),
        );
      }
    } else if (t === 'import_statement') {
      const spec = node.childForFieldName('source')?.text.slice(1, -1) ?? null;
      for (const s of node.descendantsOfType('import_specifier')) {
        const n = s?.childForFieldName('name')?.text;
        if (n) out.edge(moduleSymbol, 'imports', n, node.startPosition.row + 1, spec);
      }
      return;
    } else if (t === 'pair') {
      const key = registeredKey(node);
      if (key) {
        inner = out.symbol({
          kind: 'function',
          qualified_name: `tool:${key}`,
          signature: clip(src.slice(node.startIndex).split('\n', 1)[0]!.trim(), 200),
          doc: docOf(node),
          start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          body_hash: normalizedHash(node),
          exported: 0,
        });
        if (inner !== scope) out.edge(scope, 'calls', `tool:${key}`, node.startPosition.row + 1);
      } else if (scope !== moduleSymbol) {
        const text = descriptionText(node);
        const owner = out.symbols[scope];
        if (text && owner) owner.doc = clip(owner.doc ? `${owner.doc} ${text}` : text, DOC_MAX);
      }
    } else if (t === 'identifier' || t === 'shorthand_property_identifier') {
      if (inValuePosition(node) && boundValue(node, node.text)) reference(scope, 'calls', node.text, node);
    } else if (t === 'extends_clause') {
      const base = node.childForFieldName('value');
      if (base?.type === 'identifier') out.edge(scope, 'instantiates', target(base.text), base.startPosition.row + 1);
    } else if (t === 'jsx_opening_element' || t === 'jsx_self_closing_element') {
      const tag = node.childForFieldName('name');
      if (tag?.type === 'identifier' && /^[A-Z]/.test(tag.text)) reference(scope, 'instantiates', tag.text, tag);
    } else if (t === 'string' || t === 'template_string') {
      const text = node.text;
      const line = node.startPosition.row + 1;
      for (const [kind, table] of sqlRefs(text)) out.edge(scope, kind, table, line);
      for (const key of configKeyReads(boundSqlText(node, consts), callParams(node, consts))) out.edge(scope, 'reads_config', key, line);
      if (/CREATE\s+(VIRTUAL\s+)?TABLE/i.test(text)) extractSqlDdl(text, out, null, node.startPosition.row);
    }
    for (const c of named(node)) visit(c, inner, innerCls);
  };
  visit(root, moduleSymbol, null);
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

function extractBash(root: Node, out: Collector, moduleSymbol: number): void {
  const visit = (node: Node, scope: number): void => {
    let inner = scope;
    const t = node.type;
    if (t === 'function_definition') {
      const n = node.childForFieldName('name')?.text;
      if (n) {
        inner = out.symbol({
          kind: 'sh_function',
          qualified_name: n,
          signature: `${n}()`,
          doc: docOf(node),
          start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          body_hash: normalizedHash(node),
          exported: 1,
        });
      }
    } else if (t === 'command') {
      const name = node.childForFieldName('name')?.text;
      const args = named(node)
        .filter((c) => c.type !== 'command_name')
        .map((c) => stripQuotes(c.text));
      const line = node.startPosition.row + 1;
      if (name === 'source' || name === '.') {
        if (args[0]) out.edge(scope, 'sources', basename(args[0]), line);
      } else if (name && /\.sh$/.test(name)) out.edge(scope, 'runs', basename(name), line);
      else if ((name === 'bash' || name === 'sh') && args[0] && /\.sh$/.test(args[0])) {
        out.edge(scope, 'runs', basename(args[0]), line);
      } else if (name && /^[A-Za-z_][\w-]*$/.test(name) && !SH_BUILTINS.has(name)) out.edge(scope, 'calls', name, line);
    } else if (t === 'string' || t === 'raw_string' || t === 'heredoc_body') {
      const line = node.startPosition.row + 1;
      for (const [kind, table] of sqlRefs(node.text)) out.edge(scope, kind, table, line);
      for (const key of configKeyReads(node.text)) out.edge(scope, 'reads_config', key, line);
    }
    for (const c of named(node)) visit(c, inner);
  };
  visit(root, moduleSymbol);
}

// The string a body opens with, Python's docstring; '' when it opens with
// anything else.
function pyDocstring(body: Node | null): string {
  const first = body ? named(body).find((c) => c.type !== 'comment') : undefined;
  const str = first?.type === 'expression_statement' ? first.namedChildren[0] : null;
  if (str?.type !== 'string') return '';
  const text = named(str)
    .filter((c) => c.type === 'string_content')
    .map((c) => c.text)
    .join('');
  return clip(oneLine(text), DOC_MAX);
}

const PY_RECEIVERS_OF_CLASS = new Set(['self', 'cls']);

type PyPlace = 'module' | 'class' | 'nested';

// Imports become module-level 'imports' edges whose hint is the dotted module
// ('.a', '..', 'pkg.mod') and whose dst_name is the imported name, or the
// module itself for `import pkg.mod`. Returns each `as` alias's original name
// and every name the imports bind.
function pyImports(root: Node, out: Collector, moduleSymbol: number): { aliases: Map<string, string>; bound: Set<string> } {
  const aliases = new Map<string, string>();
  const bound = new Set<string>();
  for (const stmt of root.descendantsOfType(['import_statement', 'import_from_statement'])) {
    if (!stmt) continue;
    const line = stmt.startPosition.row + 1;
    const from = stmt.type === 'import_from_statement' ? stmt.childForFieldName('module_name')?.text : undefined;
    if (stmt.type === 'import_from_statement' && !from) continue;
    for (const n of stmt.childrenForFieldName('name')) {
      if (!n) continue;
      const original = (n.type === 'aliased_import' ? n.childForFieldName('name') : n)?.text;
      if (!original) continue;
      const alias = n.type === 'aliased_import' ? n.childForFieldName('alias')?.text : undefined;
      if (alias) aliases.set(alias, original);
      bound.add(alias ?? original);
      out.edge(moduleSymbol, 'imports', original, line, from ?? original);
    }
    if (from && named(stmt).some((c) => c.type === 'wildcard_import')) out.edge(moduleSymbol, 'imports', '*', line, from);
  }
  return { aliases, bound };
}

// Module-level classes, functions and `NAME = …` constants, methods of those
// classes, and the calls each makes. A call of a class the file defines, or
// of an imported CapWords name (PEP 8 class naming), is 'instantiates'; a
// call on self/cls carries the enclosing class as its receiver hint.
function extractPython(root: Node, src: string, out: Collector, moduleSymbol: number): void {
  const moduleDocstring = pyDocstring(root);
  const moduleRow = out.symbols[moduleSymbol];
  if (moduleRow && moduleDocstring) moduleRow.doc = moduleDocstring;
  const { aliases, bound } = pyImports(root, out, moduleSymbol);
  const classes = new Set(
    root
      .descendantsOfType('class_definition')
      .map((c) => c?.childForFieldName('name')?.text)
      .filter((n): n is string => n !== undefined),
  );
  const target = (name: string): string => aliases.get(name) ?? name;
  const isClass = (name: string): boolean => classes.has(name) || (bound.has(name) && /^[A-Z]/.test(target(name)));
  const exportedName = (name: string): number => (name.startsWith('_') ? 0 : 1);
  const definition = (node: Node, kind: SymbolKind, qualifiedName: string, exported: number): number => {
    const anchor = node.parent?.type === 'decorated_definition' ? node.parent : node;
    return out.symbol({
      kind,
      qualified_name: qualifiedName,
      signature: signatureOf(node, src),
      doc: pyDocstring(node.childForFieldName('body')) || docOf(anchor),
      start_line: anchor.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      body_hash: normalizedHash(anchor),
      exported,
    });
  };

  const visit = (node: Node, scope: number, cls: string | null, place: PyPlace): void => {
    let inner = scope;
    let innerCls = cls;
    let innerPlace = place;
    const t = node.type;
    if (t === 'import_statement' || t === 'import_from_statement' || t === 'future_import_statement') return;
    if (t === 'class_definition') {
      const n = node.childForFieldName('name')?.text;
      innerPlace = 'nested';
      innerCls = null;
      if (n && place === 'module') {
        inner = definition(node, 'class', n, exportedName(n));
        innerCls = n;
        innerPlace = 'class';
        for (const base of named(node.childForFieldName('superclasses') ?? node).filter((c) => c.type === 'identifier')) {
          out.edge(inner, 'instantiates', target(base.text), base.startPosition.row + 1);
        }
      }
    } else if (t === 'function_definition') {
      const n = node.childForFieldName('name')?.text;
      innerPlace = 'nested';
      if (n && place === 'module') inner = definition(node, 'function', n, exportedName(n));
      else if (n && place === 'class' && cls) inner = definition(node, 'method', `${cls}.${n}`, 0);
    } else if (t === 'expression_statement' && node.parent?.type === 'module') {
      const assignment = node.namedChildren[0];
      const hasValue = assignment?.type === 'assignment' && assignment.childForFieldName('right') !== null;
      const left = hasValue ? assignment.childForFieldName('left') : null;
      if (left?.type === 'identifier') {
        inner = out.symbol({
          kind: 'const',
          qualified_name: left.text,
          signature: clip(oneLine(src.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 140))), 200),
          doc: docOf(node),
          start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          body_hash: normalizedHash(node),
          exported: exportedName(left.text),
        });
      }
    } else if (t === 'call') {
      const fn = node.childForFieldName('function');
      const line = node.startPosition.row + 1;
      if (fn?.type === 'identifier') {
        out.edge(scope, isClass(fn.text) ? 'instantiates' : 'calls', target(fn.text), line);
      } else if (fn?.type === 'attribute') {
        const callee = fn.childForFieldName('attribute')?.text;
        const object = fn.childForFieldName('object');
        if (callee && object) {
          const ofClass = object.type === 'identifier' && PY_RECEIVERS_OF_CLASS.has(object.text) && cls;
          out.edge(scope, 'calls', callee, line, ofClass ? cls : memberHint(target(object.text)));
        }
      }
    }
    for (const c of named(node)) visit(c, inner, innerCls, innerPlace);
  };
  visit(root, moduleSymbol, null, 'module');
}

// The '#' comment block whose last row is right above row `at` (0-based),
// with no blank row between, from after its last banner line on; never the
// shebang.
function hashCommentDoc(lines: string[], at: number): string {
  const block: string[] = [];
  for (let i = at - 1; i >= 0 && /^\s*#/.test(lines[i]!) && !/^#!/.test(lines[i]!); i--) block.unshift(lines[i]!);
  return clip(oneLine(afterLastBanner(block).map((l) => l.replace(/^\s*#+/, ' ')).join(' ')), DOC_MAX);
}

// The rows of Perl code: POD blocks and everything after __END__/__DATA__
// blank out, so line numbers still match the file.
function perlCodeLines(src: string): string[] {
  const lines = src.split('\n');
  let pod = false;
  let done = false;
  return lines.map((l) => {
    if (done) return '';
    if (/^__(END|DATA)__\s*$/.test(l)) {
      done = true;
      return '';
    }
    if (pod) {
      if (/^=cut\b/.test(l)) pod = false;
      return '';
    }
    if (/^=[a-zA-Z]/.test(l)) {
      pod = !/^=cut\b/.test(l);
      return '';
    }
    return l;
  });
}

const PERL_SUB = /^(\s*)sub\s+([A-Za-z_][\w:]*)\b([^{]*)/;
const PERL_CONST = /^\s*use\s+constant\s+(?:([A-Za-z_]\w*)\s*=>|(\{))/;
const PERL_BLOCK_KEY = /\s*['"]?([A-Za-z_]\w*)['"]?\s*=>/y;

// A forward declaration (`sub name;`) declares no body and is no symbol.
function perlForwardDecl(line: string): boolean {
  return /^[^{#]*;\s*(#.*)?$/.test(line);
}

// The column of the `]` closing the `[` at `open` on the same line, so a
// regex class such as `[^}]` hides its braces; `open` when none does.
function bracketEnd(line: string, open: number): number {
  for (let j = open + 1; j < line.length; j++) {
    if (line[j] === '\\') j++;
    else if (line[j] === ']') return j;
  }
  return open;
}

// The row a sub ends on: the row where its braces, counted from its first `{`
// outside '#' comments, quoted strings, same-line `[...]` and backslash
// escapes, balance; when
// they never do, the first later row that opens with `}` at or left of the
// sub's indent.
function perlSubEnd(lines: string[], start: number, indent: number): number {
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    let quote: string | null = null;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]!;
      if (ch === '\\') {
        j++;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '#' && line[j - 1] !== '$') break;
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '[') j = bracketEnd(line, j);
      else if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}' && opened && --depth === 0) return i;
    }
  }
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(\s*)\}/.exec(lines[i]!);
    if (m && m[1]!.length <= indent) return i;
  }
  return start;
}

// The keys of a `use constant { A => ..., B => ... };` block opened at
// (row, col), each with its row: a key is a bareword or quoted name before
// `=>` at brace depth 1, first in the block or after a comma.
function perlConstantKeys(lines: string[], row: number, col: number): { keys: Array<[string, number]>; end: number } {
  const keys: Array<[string, number]> = [];
  let depth = 0;
  let expectKey = false;
  for (let i = row; i < lines.length; i++) {
    const line = lines[i]!;
    let quote: string | null = null;
    for (let j = i === row ? col : 0; j < line.length; j++) {
      const ch = line[j]!;
      if (quote) {
        if (ch === '\\') j++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '#') break;
      if (depth === 1 && expectKey) {
        PERL_BLOCK_KEY.lastIndex = j;
        const m = PERL_BLOCK_KEY.exec(line);
        if (m) {
          keys.push([m[1]!, i]);
          j = PERL_BLOCK_KEY.lastIndex - 1;
          expectKey = false;
          continue;
        }
        if (!/\s/.test(ch)) expectKey = false;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{' || ch === '(' || ch === '[') {
        depth++;
        if (depth === 1) expectKey = true;
      } else if (ch === '}' || ch === ')' || ch === ']') {
        if (--depth === 0) return { keys, end: i };
      } else if (ch === ',' && depth === 1) expectKey = true;
    }
  }
  return { keys, end: lines.length - 1 };
}

// Perl, line by line: each named `sub NAME` is a 'function' and each
// `use constant NAME => ...` or `use constant { A => ..., B => ... }` name a
// 'const'. A leading underscore marks a name private (exported 0).
function extractPerl(src: string, out: Collector): void {
  const lines = perlCodeLines(src);
  const body = (from: number, to: number) =>
    md5(oneLine(lines.slice(from, to + 1).filter((l) => !/^\s*#/.test(l)).join('\n')));
  const exported = (name: string) => (/^_|::_/.test(name) ? 0 : 1);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const sub = PERL_SUB.exec(line);
    if (sub) {
      if (perlForwardDecl(line)) continue;
      const name = sub[2]!;
      const end = perlSubEnd(lines, i, sub[1]!.length);
      out.symbol({
        kind: 'function',
        qualified_name: name,
        signature: clip(oneLine(`sub ${name}${sub[3]!.replace(/;.*$/, '')}`), 200),
        doc: hashCommentDoc(lines, i),
        start_line: i + 1,
        end_line: end + 1,
        body_hash: body(i, end),
        exported: exported(name),
      });
      continue;
    }
    const constant = PERL_CONST.exec(line);
    if (!constant) continue;
    if (constant[1]) {
      const name = constant[1];
      let end = i;
      while (end < lines.length - 1 && !/;\s*(#.*)?$/.test(lines[end]!)) end++;
      out.symbol({
        kind: 'const',
        qualified_name: name,
        signature: clip(oneLine(lines.slice(i, end + 1).join(' ').replace(/^\s*use\s+constant\s+/, '').replace(/;\s*(#.*)?$/, '')), 200),
        doc: hashCommentDoc(lines, i),
        start_line: i + 1,
        end_line: end + 1,
        body_hash: body(i, end),
        exported: exported(name),
      });
      continue;
    }
    const block = perlConstantKeys(lines, i, line.indexOf('{', constant.index + constant[0].length - 1));
    for (const [name, row] of block.keys) {
      out.symbol({
        kind: 'const',
        qualified_name: name,
        signature: clip(oneLine(lines[row]!).replace(/,$/, ''), 200),
        doc: hashCommentDoc(lines, row) || hashCommentDoc(lines, i),
        start_line: row + 1,
        end_line: row + 1,
        body_hash: md5(oneLine(lines[row]!)),
        exported: exported(name),
      });
    }
    i = block.end;
  }
}

function moduleDoc(lang: SourceLanguage, src: string): string {
  const out: string[] = [];
  const comment = lang === 'bash' || lang === 'python' || lang === 'sql' || lang === 'perl' ? /^\s*(?:#|--)\s?(.*)$/ : /^\s*(?:\/\/|\/\*\*?|\*)\s?(.*?)(\*\/)?$/;
  for (const l of src.split('\n')) {
    if (/^#!/.test(l)) continue;
    const m = l.match(comment);
    if (m) {
      if (m[1]!.trim()) out.push(m[1]!.trim());
    } else if (out.length || l.trim()) break;
  }
  return clip(out.join(' '), DOC_MAX);
}

// Every symbol of one file, the per-file 'module' row first, and the
// references each one makes.
export function extractFile(parsers: Parsers | null, relPath: string, lang: SourceLanguage, src: string): Extraction {
  const out = new Collector();
  const moduleSymbol = out.symbol({
    kind: 'module',
    qualified_name: relPath,
    signature: relPath,
    doc: moduleDoc(lang, src),
    start_line: 1,
    end_line: src.split('\n').length,
    body_hash: md5(src),
    exported: 0,
  });
  if (lang === 'sql') {
    extractSqlDdl(src, out, moduleSymbol);
    return out;
  }
  if (lang === 'perl') {
    extractPerl(src, out);
    return out;
  }
  if (!parsers) throw new Error(`no parser loaded for ${lang}`);
  const tree = parsers[lang].parse(src);
  if (!tree) throw new Error(`tree-sitter returned no tree for ${relPath}`);
  try {
    if (lang === 'bash') extractBash(tree.rootNode, out, moduleSymbol);
    else if (lang === 'python') extractPython(tree.rootNode, src, out, moduleSymbol);
    else extractTs(tree.rootNode, src, out, moduleSymbol, relPath);
  } finally {
    tree.delete();
  }
  return out;
}
