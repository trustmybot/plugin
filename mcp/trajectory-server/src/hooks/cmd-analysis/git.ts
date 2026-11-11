/**
 * The git-target helpers of scripts/hooks/lib/cmd-analysis.sh (GH 1692):
 * tmb_cmd_statements, tmb_cwd_state, tmb_git_subcommand, tmb_stmt_repo_root
 * and tmb_deny_ambiguous_git_target, on the tree-sitter-bash skeleton of
 * encode.ts. Where encode() cannot parse the command, or a `bash -c` / `eval`
 * body in it, cmdStatements fails closed instead of listing the statements it
 * could read (GH 1927).
 */
import type { Node, Parser } from 'web-tree-sitter';
import { gitOk, gitOut, cdPwd, isDir } from '../lib/git.js';
import { denyJson } from '../lib/deny.js';
import { shellPwd } from '../lib/project-env.js';
import { Encoder, NO_CHARGE, decode, encode, heredocEncoder } from './encode.js';
import { bashParser } from './parser.js';
import { ALT, DECLARE, LOOP_CLOSE, LOOP_OPEN, PS4_WORD, REDIRECT_WORD, isGitCommand, operandWords, statementsEnc, type Record } from './statements.js';

/** A listed statement; `src` is its text as the command wrote it, quotes and all, when the listing can find it (GH 2536); `opaque` when it runs code the listing cannot read (GH 2635). */
export type Statement = Record & { readonly src?: string; readonly opaque?: true };

/** <statement> with a `src` that <get> works out on its first read, so a gate that never quotes the statement never pays for it. */
export function withSource<T extends Record>(statement: T, get: () => string | undefined): T & { readonly src?: string } {
  let src: string | undefined;
  let read = false;
  return Object.defineProperty(statement, 'src', {
    get: () => {
      if (!read) [src, read] = [get(), true];
      return src;
    },
  });
}

export type GitStatements = { ok: true; statements: Statement[] } | { ok: false };

const MAX_DEPTH = 3;
const SHELL = /^(.*\/)?(bash|sh|zsh|dash|ksh)$/;
const ENCODED_BYTE = /[\x01-\x06\x0e-\x11\x13\x15\x16]/;
const ENCODED = new RegExp(ENCODED_BYTE.source, 'g');
const HD_MARK = /<<[\x1a\x1e]/g;

/** `read -r -a w <<< "$s"`: the first line's words. */
function readWords(s: string): string[] {
  return (s.split('\n')[0] ?? '').split(/[ \t]+/).filter((w) => w !== '');
}

/** What `IFS=$'\t' read -r dir stmt` leaves of a statement: no leading or trailing tabs. */
function readStmt(stmt: string): string {
  return stmt.replace(/^\t+|\t+$/g, '');
}

/** An encoded code string a statement runs, `later` when it runs at some other time, in an unknown dir. */
interface Code {
  readonly text: string;
  readonly later: boolean;
}

/** The code strings a statement runs, the indices of the words that must be literal for them to be read, and whether it runs code read from stdin. */
interface CodeRead {
  readonly codes: Code[];
  readonly check: number[];
  readonly stdin: boolean;
}

const NO_CODE: CodeRead = { codes: [], check: [], stdin: false };
const PROMPT_EXPANSION = /\$\{[^}]*@P\}/;
/** A `${!name=…}` or `${!name:=…}`: an assignment to the variable another one names. */
const INDIRECT_ASSIGN = /\$\{![^}]*=/;
const NAMEREF = /^-[A-Za-z]*n/;
const DYNAMIC = /[$`]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
/** Builtins that set a variable an operand names. */
const ASSIGNER = /^(export|declare|typeset|local|readonly|read|printf|getopts|mapfile|readarray)$/;
/** Nodes whose text bash expands, so a git argument's PS4 inside one is not plain text. */
const EXPANDING = new Set(['expansion', 'simple_expansion', 'command_substitution', 'process_substitution', 'arithmetic_expansion']);

/** The `PS4` of a variable_assignment's name, `PS4` or `PS4[i]`; null for any other name. */
function ps4Name(assignment: Node): Node | null {
  const name = assignment.childForFieldName('name');
  const base = name?.type === 'subscript' ? name.childForFieldName('name') : name;
  return base?.type === 'variable_name' && base.text === 'PS4' ? base : null;
}

/** Whether a declaration_command makes its names namerefs: `declare` / `typeset` / `local` with an option holding `n`. */
function nameref(decl: Node): boolean {
  const word = decl.firstChild?.text ?? '';
  return (word === 'declare' || word === 'typeset' || word === 'local') && decl.namedChildren.some((c) => c?.type === 'word' && NAMEREF.test(c.text));
}

/**
 * Whether shell source <cmd> may set PS4 out of the listing's sight (GH 2635,
 * an allowlist): it writes `PS4` anywhere but as the name of an assignment
 * (bare, before a command, behind export / declare / typeset / local /
 * readonly but not a nameref, or an `env` assignment before its command), the
 * plain text of a git argument, or a quoted-delimiter heredoc body; or it
 * holds a `${!name=…}` indirect assignment. The listing checks the value of
 * each assignment it admits.
 */
function hiddenPs4(parser: Parser, cmd: string): boolean {
  if (INDIRECT_ASSIGN.test(cmd)) return true;
  if (!cmd.includes('PS4')) return false;
  const tree = parser.parse(cmd);
  if (!tree) return true;
  try {
    const starts = new Set<number>();
    const spans: Array<[number, number]> = [];
    const plainText = (node: Node): void => {
      if (EXPANDING.has(node.type)) return;
      if (node.childCount === 0) spans.push([node.startIndex, node.endIndex]);
      for (const child of node.children) if (child) plainText(child);
    };
    const walk = (node: Node): void => {
      if (node.type === 'variable_assignment' && !(node.parent?.type === 'declaration_command' && nameref(node.parent))) {
        const name = ps4Name(node);
        if (name) starts.add(name.startIndex);
      } else if (node.type === 'command' && isGitCommand(node.childForFieldName('name')?.text ?? '')) {
        for (const arg of node.childrenForFieldName('argument')) if (arg) plainText(arg);
      } else if (node.type === 'command' && node.childForFieldName('name')?.text === 'env') {
        for (const arg of node.childrenForFieldName('argument')) {
          if (!arg || !/^(-[A-Za-z-]*|[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?=.*)$/s.test(arg.text)) break;
          if (PS4_WORD.test(arg.text) && !arg.text.includes('+=')) starts.add(arg.startIndex);
        }
      } else if (node.type === 'heredoc_redirect') {
        const start = node.children.find((c) => c?.type === 'heredoc_start');
        const body = node.children.find((c) => c?.type === 'heredoc_body');
        if (start && body && /['"\\]/.test(start.text)) spans.push([body.startIndex, body.endIndex]);
      }
      for (const child of node.children) if (child) walk(child);
    };
    walk(tree.rootNode);
    for (const m of cmd.matchAll(/PS4/g)) {
      const at = m.index;
      if (!starts.has(at) && !spans.some(([from, to]) => at >= from && at + 3 <= to)) return true;
    }
    return false;
  } finally {
    tree.delete();
  }
}

/**
 * Whether an encoded statement's words <w> name PS4 where the listing does
 * not admit it (GH 2635): a word holding `PS4` once quotes are removed
 * (`read P\S4`, `printf -v "PS4"`), unless the statement is git's or is
 * itself a PS4 assignment record, or the word is a `PS4=` assignment of a
 * declaration builtin that is no nameref.
 */
function ps4Word(w: readonly string[]): boolean {
  if (isGitCommand(w[0] ?? '') || PS4_WORD.test(w[0] ?? '')) return false;
  const decl = DECLARE.test(w[0] ?? '') && !(w[0] !== 'export' && w[0] !== 'readonly' && w.some((x) => NAMEREF.test(x)));
  return w.some((x, i) => {
    const word = decode(x);
    return word.includes('PS4') && !(decl && i > 0 && PS4_WORD.test(word));
  });
}

/** Whether an option cluster or operand list <w> names a variable through an expansion: an operand (the first only, unless <every>), or the value of an option in <targets>; <values> are the options that take a value. */
function dynamicOperand(w: readonly string[], values: string, targets: string, every: boolean): boolean {
  for (let i = 0; i < w.length; i++) {
    const x = w[i];
    if (x === '--') return w.slice(i + 1, every ? undefined : i + 2).some((y) => DYNAMIC.test(y));
    if (x.length > 1 && x.startsWith('-') && !DYNAMIC.test(x)) {
      for (let j = 1; j < x.length; j++) {
        if (!values.includes(x[j])) continue;
        const value = x.slice(j + 1) || (w[++i] ?? '');
        if (targets.includes(x[j]) && DYNAMIC.test(value)) return true;
        break;
      }
      continue;
    }
    if (DYNAMIC.test(x)) return true;
    if (!every) return false;
  }
  return false;
}

/**
 * Whether a builtin that sets a variable an operand names may set one whose
 * name is an expansion (GH 2635), read from the statement's source words
 * <words> as written, argv0 first, its decoded form <argv0>: a declaration
 * builtin's name (a nameref's value too), a `read` operand or `-a` array, a
 * `printf -v` name (or a first word that may expand to `-v`), a `getopts`
 * name, or a `mapfile` / `readarray` array. True when <words> is null.
 */
function dynamicName(argv0: string, words: readonly string[] | null): boolean {
  if (words === null) return true;
  const ops = operandWords(words);
  if (DECLARE.test(argv0)) {
    const ref = argv0 !== 'export' && argv0 !== 'readonly' && ops.some((x) => NAMEREF.test(x));
    return ops.some((x) => DYNAMIC.test(ref ? x : x.split('=')[0]));
  }
  switch (argv0) {
    case 'read':
      return dynamicOperand(ops, 'adinNptu', 'a', true);
    case 'printf': {
      const first = ops[0] ?? '';
      if (DYNAMIC.test(first)) return true;
      return first.startsWith('-v') && DYNAMIC.test(first === '-v' ? (ops[1] ?? '') : first.slice(2));
    }
    case 'getopts':
      return DYNAMIC.test(ops[1] ?? '');
    case 'mapfile':
    case 'readarray':
      return dynamicOperand(ops, 'dnOsuCc', '', false);
    default:
      return false;
  }
}

/** Shell source <src>'s words as written, quotes and all; null when they cannot be read. */
function rawWords(src: string | undefined): string[] | null {
  const words = src === undefined ? null : sourceWords(src);
  return words === null || src === undefined ? null : words.map((word) => src.slice(word.start, word.end));
}

const upTo = (k: number): number[] => Array.from({ length: k }, (_, i) => i + 1);
/** Text the shell expands as a double-quoted word, as code that runs only its expansions. */
const expanded = (value: string): string => `: "${value}"`;

/** A shell's `-c` string (its first operand once an option cluster holds `c`), or stdin code: `-s`, or no operand. */
function shellCode(w: readonly string[]): CodeRead {
  let c = false;
  let s = false;
  let i = 1;
  for (; i < w.length; i++) {
    const x = w[i];
    const redirect = REDIRECT_WORD.exec(x);
    if (redirect) {
      if (redirect[0] === x && redirect[2] !== '<<') i++;
      continue;
    }
    if (x === '--' || x === '-') {
      i++;
      break;
    }
    if (!/^[-+]./.test(x)) break;
    if (x.startsWith('--')) {
      if (x === '--rcfile' || x === '--init-file') i++;
      continue;
    }
    const flags = x.slice(1);
    if (x[0] === '-' && flags.includes('c')) c = true;
    if (flags.includes('s')) s = true;
    i += (flags.match(/[oO]/g) ?? []).length;
  }
  if (c) return i < w.length ? { codes: [{ text: w[i], later: false }], check: upTo(i), stdin: false } : NO_CODE;
  return { codes: [], check: [], stdin: s || i >= w.length };
}

/** The code an option of <codes> names, for a builtin whose options <values> take a value; a `W` value is a word list the shell expands. */
function optionCode(w: readonly string[], values: string, codes: string): CodeRead {
  const found: Code[] = [];
  let last = 0;
  for (let i = 1; i < w.length; i++) {
    const x = w[i];
    if (x === '--' || !x.startsWith('-') || x === '-') break;
    for (let j = 1; j < x.length; j++) {
      if (!values.includes(x[j])) continue;
      const joined = x.slice(j + 1);
      const value = joined === '' ? (w[++i] ?? '') : joined;
      if (codes.includes(x[j])) {
        found.push({ text: x[j] === 'W' ? expanded(decode(value)) : value, later: true });
        last = i;
      }
      break;
    }
  }
  return found.length === 0 ? NO_CODE : { codes: found, check: upTo(last), stdin: false };
}

/** `trap <action> <signal>…`: the action, unless it is `-` or a signal number, which reset the signals. */
function trapCode(w: readonly string[]): CodeRead {
  let i = 1;
  while (i < w.length && /^-[lpP]+$/.test(w[i])) i++;
  if (w[i] === '--') i++;
  if (w.length - i < 2 || w[i] === '-' || /^[0-9]+$/.test(w[i])) return NO_CODE;
  return { codes: [{ text: w[i], later: true }], check: upTo(i), stdin: false };
}

/** Each `name=value` of `alias`: the value runs wherever the name is a command word. */
function aliasCode(w: readonly string[]): CodeRead {
  const at = w.flatMap((x, i) => (i > 0 && !x.startsWith('-') && x.includes('=') ? [i] : []));
  return at.length === 0 ? NO_CODE : { codes: at.map((i) => ({ text: w[i].slice(w[i].indexOf('=') + 1), later: true })), check: at, stdin: false };
}

/**
 * The code strings an encoded statement runs (GH 2635): a shell's `-c`
 * string or stdin, the rest of `eval`, a `trap` action, an `alias` value,
 * `mapfile` / `readarray -C`, `compgen` / `complete -C` (and a `-W` word list
 * they expand), and a PS4 value holding `$` or a backtick, which `set -x`
 * expands before each command (its backslashes dropped, as prompt decoding
 * turns `\$` into `$`).
 */
function codeOf(stmt: string): CodeRead {
  if (PS4_WORD.test(stmt)) {
    const value = decode(stmt.slice(stmt.indexOf('=') + 1));
    return /[$`]/.test(value) ? { codes: [{ text: expanded(value.replace(/\\/g, '')), later: true }], check: [0], stdin: false } : NO_CODE;
  }
  const w = readWords(stmt);
  const argv0 = w[0] ?? '';
  if (SHELL.test(argv0)) return shellCode(w);
  switch (argv0) {
    case 'eval':
      return w.length > 1 ? { codes: [{ text: stmt.slice(4).replace(/^ /, ''), later: false }], check: upTo(w.length - 1), stdin: false } : NO_CODE;
    case 'trap':
      return trapCode(w);
    case 'alias':
      return aliasCode(w);
    case 'mapfile':
    case 'readarray':
      return optionCode(w, 'dnOsuCc', 'C');
    case 'compgen':
    case 'complete':
      return optionCode(w, 'oAGWFCXPS', 'CW');
    default:
      return NO_CODE;
  }
}

/** A word bash may turn into other text: a parameter, command or arithmetic expansion, or a brace or glob pattern. */
const MAY_EXPAND = /[$`*?[{]/;

/** Whether the words at <check> of <stmt> are literal text, read from the statement's source <src> when the decoded word alone cannot tell. */
function literalWords(stmt: string, check: readonly number[], src: () => string | undefined): boolean {
  const w = readWords(stmt);
  if (check.every((i) => !MAY_EXPAND.test(decode(w[i] ?? '')))) return true;
  const text = src();
  const words = text === undefined ? null : sourceWords(text);
  return words !== null && words.length === w.length && check.every((i) => !words[i].expands);
}

/** The nodes a statement's source can be: a command or declaration, unless it is a redirected statement's body, a redirected statement, and an assignment (a PS4 record); children first. */
function candidates(node: Node, out: Node[] = []): Node[] {
  for (const child of node.namedChildren) if (child) candidates(child, out);
  const body = node.parent?.type === 'redirected_statement' && node.parent.childForFieldName('body')?.id === node.id;
  if (node.type === 'redirected_statement' || node.type === 'variable_assignment' || ((node.type === 'command' || node.type === 'declaration_command') && !body)) out.push(node);
  return out;
}

/** The starts of a candidate's words: its named children, and those of a command among them. */
const STATEMENT_GROUPS = new Set(['list', 'pipeline', 'negated_command', 'redirected_statement', 'subshell', 'compound_statement']);

function wordStarts(node: Node): number[] {
  const starts: number[] = [];
  for (const child of node.namedChildren) {
    if (child?.type === 'command') starts.push(...child.namedChildren.flatMap((word) => (word ? [word.startIndex] : [])));
    else if (child) starts.push(child.startIndex, ...(STATEMENT_GROUPS.has(child.type) ? wordStarts(child) : []));
  }
  return starts.sort((a, b) => a - b);
}

/**
 * Each listed statement's source in `cmd` (GH 2536): the innermost candidate
 * node whose own listing still holds that statement, from its last word on
 * that still lists it, so a leading assignment, `time` or wrapper the listing
 * drops is dropped here too. A statement listed inside a node counts against
 * that node and every candidate around it; undefined when no node holds it.
 */
function sources(parser: Parser, cmd: string, home: string, stmts: readonly string[]): Array<string | undefined> {
  const tree = parser.parse(cmd);
  if (!tree) return stmts.map(() => undefined);
  try {
    const encoder = new Encoder(cmd, NO_CHARGE, false, false, heredocEncoder(parser));
    const listed = (node: Node, at: number): string[] =>
      statementsEnc(encoder.from(node, at), '@', home, false)
        .map((record) => readStmt(record.stmt))
        .filter((stmt) => stmt !== '');
    const left = new Map<number, Map<string, number>>();
    const holders = new Map<string, Node[]>();
    for (const node of candidates(tree.rootNode)) {
      const counts = new Map<string, number>();
      for (const stmt of listed(node, node.startIndex)) {
        const n = (counts.get(stmt) ?? 0) + 1;
        counts.set(stmt, n);
        if (n > 1) continue;
        const nodes = holders.get(stmt);
        if (nodes) nodes.push(node);
        else holders.set(stmt, [node]);
      }
      left.set(node.id, counts);
    }
    return stmts.map((stmt) => {
      const node = holders.get(stmt)?.find((n) => (left.get(n.id)?.get(stmt) ?? 0) > 0);
      if (!node) return undefined;
      for (let up: Node | null = node; up; up = up.parent) {
        const counts = left.get(up.id);
        const n = counts?.get(stmt) ?? 0;
        if (n > 0) counts!.set(stmt, n - 1);
      }
      const start = wordStarts(node)
        .reverse()
        .find((at) => listed(node, at).includes(stmt));
      return cmd.slice(start ?? node.startIndex, node.endIndex);
    });
  } finally {
    tree.delete();
  }
}

/**
 * _tmb_cmd_statements_enc <cmd> <base> <depth> without assign, loops and
 * function calls framed (GH 2065, GH 2630): a statement a loop's back-edge or
 * a call can bring to more dirs is listed once per dir. Null when the command
 * or a body in it does not parse. An `eval` body is `escaped`: the functions
 * it defines outlive it, so their statements run in `-`. Code a statement
 * runs later (codeOf) is listed in `-` after the statement itself, and is
 * `opaque` where it does not parse. A statement whose code cannot be read is
 * `opaque` (GH 2635): a code word that is not literal (a PS4 value that
 * expands as it is assigned, whose result `set -x` expands again), a command
 * word that is an expansion, a statement an unquoted $( ) or backtick cut
 * (a builtin that sets a variable only when the name it sets may expand), a
 * shell reading stdin, a `${…@P}` prompt expansion, a PS4 written other than
 * as a literal assignment (hiddenPs4, ps4Word: `${PS4:=…}`, `printf -v PS4`,
 * `read PS4`, a nameref), a variable name a builtin takes from an expansion
 * (dynamicName: `declare "$X=…"`, `printf -v "$X"`, `read "$X"`, `mapfile
 * "$X"`), or code past MAX_DEPTH; the code it can read is still listed.
 */
function listing(parser: Parser, cmd: string, base: string, depth: number, home: string, escaped = false): Statement[] | null {
  if (cmd.trim() === '') return [];
  const encoded = encode(parser, cmd, NO_CHARGE, false, false, true);
  if (!encoded.ok) return null;
  const out: Statement[] = [];
  const records = statementsEnc(encoded.text, base, home, false, NO_CHARGE, escaped ? 'escaped' : 'calls')
    .filter((record) => record.dir !== LOOP_OPEN && record.dir !== LOOP_CLOSE)
    .map((record) => ({ dir: record.dir, stmt: readStmt(record.stmt), tail: record.tail === true, ...(record.cut ? { cut: record.cut } : {}) }))
    .filter((record) => record.stmt !== '');
  let srcs: Array<string | undefined> | undefined;
  const srcAt = (k: number): string | undefined => (srcs ??= sources(parser, cmd, home, records.map((record) => record.stmt)))[k];
  const ps4 = hiddenPs4(parser, cmd);
  const ps4Stmts = ps4 && records.some((record) => decode(record.stmt).includes('PS4'));
  for (const [k, { dir, stmt, tail, cut }] of records.entries()) {
    const own = (opaque: boolean): void => {
      for (const one of dir.split(ALT)) out.push(withSource({ dir: one, stmt, ...(cut ? { cut } : {}), ...(opaque ? { opaque: true as const } : {}) }, () => srcAt(k)));
    };
    const { codes, check, stdin } = dir.startsWith('=') ? NO_CODE : codeOf(stmt);
    const words = readWords(stmt);
    const argv0 = words[0] ?? '';
    const prompt = PROMPT_EXPANSION.test(decode(stmt));
    const assigner = ASSIGNER.test(argv0);
    const unreadable =
      (ps4 && (!ps4Stmts || decode(stmt).includes('PS4'))) ||
      ps4Word(words) ||
      (!tail && DYNAMIC.test(decode(argv0)) && !ASSIGNMENT.test(decode(argv0))) ||
      (cut !== undefined && !isGitCommand(argv0) && !assigner) ||
      (assigner && (cut !== undefined || DYNAMIC.test(decode(stmt))) && dynamicName(argv0, rawWords(srcAt(k))));
    if (codes.length === 0 || stdin || prompt || depth >= MAX_DEPTH) {
      own(stdin || prompt || unreadable || codes.length > 0);
      continue;
    }
    let opaque = unreadable || !literalWords(stmt, check, () => srcAt(k));
    const bodies: Statement[] = [];
    for (const code of codes) {
      const nested = listing(parser, decode(code.text).replace(/\n+$/, ''), code.later ? '-' : dir, depth + 1, home, code.later || readWords(stmt)[0] === 'eval');
      if (nested === null && !code.later) return null;
      if (nested === null) opaque = true;
      else bodies.push(...nested);
    }
    if (opaque || codes.some((code) => code.later)) own(opaque);
    out.push(...bodies);
  }
  return out;
}

/**
 * tmb_cwd_state <cwd>: `-` for no dir, `?` for a checkout with linked
 * worktrees, else <cwd>. A cwd git proves is inside a linked worktree (its
 * git dir is not the common dir) is that one checkout (GH 2510), unless
 * `unresolved`: a statement whose dir hides behind a variable may name any
 * checkout of the repo, so only a repo with one checkout falls back to <cwd>.
 */
export async function cwdState(cwd: string, env: NodeJS.ProcessEnv = process.env, { unresolved = false } = {}): Promise<string> {
  if (!isDir(cwd)) return '-';
  if (await gitOk(cwd, ['rev-parse', '--git-dir'], env)) {
    if (!unresolved) {
      const [gitDir = '', commonDir = ''] = (await gitOut(cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], env)).split('\n');
      if (gitDir !== '' && commonDir !== '' && gitDir !== commonDir) return cwd;
    }
    const n = (await gitOut(cwd, ['worktree', 'list', '--porcelain'], env))
      .split('\n')
      .filter((l) => l.startsWith('worktree ')).length;
    if (n > 1) return '?';
  }
  return cwd;
}

/**
 * tmb_cmd_statements <cmd> <cwd>: each executable statement with the dir it
 * runs in (`@` made the cwd's state, `@/x` made <cwd>/x), its encoded bytes
 * shown as `_` and encode.ts's heredoc marks dropped, and with `src`, its
 * text as written, when the listing finds it.
 */
export async function cmdStatements(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<GitStatements> {
  const parser = await bashParser();
  const listed = listing(parser, command, '@', 0, env.HOME ?? '');
  if (listed === null) return { ok: false };
  let state: string | undefined;
  const statements: Statement[] = [];
  for (const entry of listed) {
    let dir = entry.dir;
    if (dir.startsWith('@/')) dir = isDir(cwd) ? `${cwd.replace(/\/$/, '')}${dir.slice(1)}` : '-';
    else if (dir === '@') dir = state ??= await cwdState(cwd, env);
    const stmt = entry.stmt.replace(HD_MARK, '<<').replace(ENCODED, '_');
    statements.push(withSource({ dir, stmt, ...(entry.cut ? { cut: entry.cut } : {}), ...(entry.opaque ? { opaque: entry.opaque } : {}) }, () => entry.src));
  }
  return { ok: true, statements };
}

/** tmb_git_subcommand <stmt>: the words from git's subcommand on, "" when <stmt> is no git command. */
export function gitSubcommand(stmt: string): string {
  const w = readWords(stmt);
  if (w[0] !== 'git') return '';
  const k = subcommandAt(w);
  return k < w.length ? w.slice(k).join(' ') : '';
}

const VALUE_OPTIONS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace'];
const VALUE_JOINED = /^--(git-dir|work-tree|namespace)=/;
/** A word bash may turn into other words (a parameter, command or arithmetic expansion, a brace or glob pattern), or a redirect, which leaves git's words. */
const NOT_LITERAL = /[$`*?[{]|^[0-9]*[<>]|^&>/;
/** The same for a value-taking option's argument, where a parameter, command or arithmetic expansion cannot move the subcommand. */
const NOT_LITERAL_VALUE = /[*?[]|(^|[^$]){|^[0-9]*[<>]|^&>/;

type SubcommandInput = string | (Pick<Statement, 'stmt'> & Partial<Pick<Statement, 'cut' | 'src'>>);

/**
 * git's subcommand in <statement> and the words after it, as gitSubcommand
 * gives them, git named bare or by a path to it (GH 2987), or undefined when
 * it is unknown (GH 2634): the subcommand word,
 * or an option word before it that is no value-taking option's argument,
 * holds an expansion, a brace or glob pattern, or is a redirect; an
 * argument of `-C` / `-c` / `--git-dir` / `--work-tree` / `--namespace`
 * (or the `=value` of the last three) only when it is a pattern or a
 * redirect. Where an unquoted $( ) or backtick cut the statement inside that
 * span, the words are read from its `src`, read only then, and a `src` that
 * is missing or does not line up leaves it unknown.
 */
export function gitSubcommandOf(statement: SubcommandInput): string | undefined {
  const { stmt, cut } = typeof statement === 'string' ? { stmt: statement, cut: undefined } : statement;
  let w = readWords(stmt);
  if (!isGitCommand(w[0] ?? '')) return '';
  let k = subcommandAt(w);
  if (cut !== undefined && typeof statement !== 'string') {
    const at = cut === 'glued' ? w.length - 1 : w.length;
    if (k >= at) {
      const src = statement.src;
      const words = src === undefined ? null : sourceWords(src);
      if (words === null || !isGitCommand(words[0]?.text ?? '') || words.findIndex((word) => word.sub) !== at) return undefined;
      w = words.map((word) => word.text);
      k = subcommandAt(w);
    }
  }
  return spanLiteral(w) ? (k < w.length ? w.slice(k).join(' ') : '') : undefined;
}

/** Whether git's words up to its subcommand are literal, each value-taking option's argument judged by NOT_LITERAL_VALUE. */
function spanLiteral(w: readonly string[]): boolean {
  let k = 1;
  while (k < w.length) {
    const word = w[k];
    if (VALUE_OPTIONS.includes(word)) {
      if (k + 1 < w.length && NOT_LITERAL_VALUE.test(w[k + 1])) return false;
      k += 2;
    } else if (VALUE_JOINED.test(word)) {
      if (NOT_LITERAL_VALUE.test(word.replace(VALUE_JOINED, ''))) return false;
      k += 1;
    } else if (word.startsWith('-')) {
      if (NOT_LITERAL.test(word)) return false;
      k += 1;
    } else break;
  }
  return k >= w.length || !NOT_LITERAL.test(w[k]);
}

/** Whether git's subcommand in <statement> is unknown: gitSubcommandOf gives undefined (GH 2634). */
export function gitSubcommandUnknown(statement: SubcommandInput): boolean {
  return gitSubcommandOf(statement) === undefined;
}

const CONTINUATION = /\\\n/g;
const UNQUOTE = /['"\\]/g;
const GIT_WORD = /\bgit\b/;
const EXPANDS = /[$`*?[{]/;

/** <command> with its line continuations joined and its quotes and backslashes dropped: the text a keyword prefilter reads, so `g''it` or `che"ck"out` is not missed (GH 2634, GH 2641). */
export function unquotedCommand(command: string): string {
  return command.replace(CONTINUATION, '').replace(UNQUOTE, '');
}

/**
 * Whether a keyword prefilter must hand <command> to the analyzer: <command>
 * holds a `$'…'` word, whose bytes only parsing decodes, or <hasKeyword> holds
 * on <command> as written or on unquotedCommand(<command>), so a keyword split
 * by a line continuation or quotes is not missed (GH 2758).
 */
export function prefilterPasses(command: string, hasKeyword: (text: string) => boolean): boolean {
  return command.includes("$'") || hasKeyword(command) || hasKeyword(unquotedCommand(command));
}

/**
 * Whether <command>, unquoted, holds a git word and an expansion, a pattern
 * or an encoded byte: a command a keyword prefilter must hand to parsing,
 * since only gitSubcommandOf can tell what its git statements run (GH 2634,
 * GH 2641).
 */
export function gitBesideExpansion(command: string): boolean {
  const bare = unquotedCommand(command);
  return GIT_WORD.test(bare) && (EXPANDS.test(bare) || ENCODED_BYTE.test(bare));
}

/** The deny reason for the git statement <what> whose subcommand is unknown, the guard unable to tell whether it <verb> (GH 2634, GH 2641). */
export function ambiguousSubcommandReason(what: string, verb: string): string {
  return `BLOCKED: ambiguous_git_subcommand: \`${what}\` takes git's subcommand, or an option before it, from an expansion, a pattern or a redirect the guard cannot resolve, so it cannot tell whether the statement ${verb}. Write the subcommand and git's options before it literally.`;
}

/** The index of git's subcommand in a git statement's words: past git's own options. */
function subcommandAt(w: readonly string[]): number {
  let k = 1;
  while (k < w.length) {
    const word = w[k];
    if (VALUE_OPTIONS.includes(word)) k += 2;
    else if (word.startsWith('-')) k += 1;
    else break;
  }
  return k;
}

/**
 * Where each word of the first line of shell source `src` starts and ends, with its
 * unquoted text, whether an unquoted $( ) or backtick is in it (`sub`), and
 * whether the shell may turn it into other text (`expands`: an unquoted `$`,
 * backtick, brace or glob char, or an unescaped `$` or backtick in double
 * quotes); null at an unclosed quote or substitution.
 */
function sourceWords(src: string): Array<{ start: number; end: number; text: string; sub: boolean; expands: boolean }> | null {
  const words: Array<{ start: number; end: number; text: string; sub: boolean; expands: boolean }> = [];
  let i = 0;
  for (;;) {
    while (src[i] === ' ' || src[i] === '\t') i++;
    if (i >= src.length || src[i] === '\n') return words;
    const start = i;
    let text = '';
    let sub = false;
    let expands = false;
    while (i < src.length && !/[ \t\n]/.test(src[i])) {
      const c = src[i];
      if (c === "'") {
        const close = src.indexOf("'", i + 1);
        if (close < 0) return null;
        text += src.slice(i + 1, close);
        i = close + 1;
      } else if (c === '"') {
        let j = i + 1;
        for (; j < src.length && src[j] !== '"'; j++) {
          if (src[j] === '$' || src[j] === '`') expands = true;
          if (src[j] === '\\') j++;
          if (j < src.length) text += src[j];
        }
        if (j >= src.length) return null;
        i = j + 1;
      } else if (c === '\\') {
        text += src[i + 1] ?? '';
        i += 2;
      } else if (c === '$' && src[i + 1] === '(') {
        let depth = 0;
        let j = i + 1;
        for (; j < src.length; j++) {
          const d = src[j];
          if (d === '\\') {
            j++;
          } else if (d === "'") {
            j = src.indexOf("'", j + 1);
            if (j < 0) return null;
          } else if (d === '"') {
            for (j++; j < src.length && src[j] !== '"'; j++) {
              if (src[j] === '\\') j++;
            }
          } else if (d === '(') {
            depth++;
          } else if (d === ')' && --depth === 0) {
            break;
          }
        }
        if (j >= src.length) return null;
        text += src.slice(i, j + 1);
        sub = true;
        i = j + 1;
      } else if (c === '`') {
        let j = i + 1;
        for (; j < src.length && src[j] !== '`'; j++) if (src[j] === '\\') j++;
        if (j >= src.length) return null;
        text += src.slice(i, j + 1);
        sub = true;
        i = j + 1;
      } else {
        if (MAY_EXPAND.test(c)) expands = true;
        text += c;
        i++;
      }
    }
    words.push({ start, end: i, text, sub, expands: expands || sub });
  }
}

/** The allowed form and the quoted command of an ambiguous-target deny: from the statement's source as written when it has one that lines up with `stmt`. */
function deniedForm(stmt: string, src: string | undefined): { what: string; allowed: string } {
  const git = stmt === 'git' || stmt.startsWith('git ');
  if (src !== undefined && src.trim() !== '') {
    if (!git) return { what: src, allowed: `cd <path> && ${src}` };
    const words = sourceWords(src);
    const w = readWords(stmt);
    const k = subcommandAt(w);
    if (words !== null && words[0]?.text === 'git' && words.length === w.length) {
      const sub = k < words.length ? src.slice(words[k].start).replace(/\s+$/, '') : '';
      return { what: src, allowed: `git -C <path>${sub === '' ? '' : ` ${sub}`}` };
    }
  }
  if (!git) return { what: stmt, allowed: `cd <path> && ${stmt}` };
  const sub = gitSubcommand(stmt);
  return { what: stmt, allowed: `git -C <path>${sub === '' ? '' : ` ${sub}`}` };
}

/** tmb_stmt_repo_root <dir> <cwd>: the main checkout of the repo a statement's dir is in, "" when none. */
export async function stmtRepoRoot(dir: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (dir === '?') dir = cwd || shellPwd(env);
  else if (dir === '-' || dir === '') return '';
  while (!isDir(dir)) {
    const slash = dir.lastIndexOf('/');
    if (slash < 0) return '';
    dir = dir.slice(0, slash) || '/';
  }
  const common = await gitOut(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env);
  if (common === '') return '';
  if (common.endsWith('/.git')) return cdPwd(common.slice(0, -5), shellPwd(env));
  return await gitOut(dir, ['rev-parse', '--show-toplevel'], env);
}

/** tmb_deny_ambiguous_git_target <stmt> [unresolved]: the deny JSON line, quoting a statement's `src` as written when it has one (GH 2536). */
export function denyAmbiguousGitTarget(statement: string | Pick<Statement, 'stmt' | 'src'>, unresolved = false): string {
  const { stmt, src } = typeof statement === 'string' ? { stmt: statement, src: undefined } : statement;
  const { what, allowed } = deniedForm(stmt || 'git', src);
  const reason = unresolved
    ? `BLOCKED: ambiguous_git_target: \`${what}\` runs in a directory that comes through a variable, \`cd -\` or popd the guard cannot resolve, and this repo has linked worktrees, so the guard cannot tell which checkout (and branch) it runs in. Pass the literal path.`
    : `BLOCKED: ambiguous_git_target: \`${what}\` names no directory and this repo has linked worktrees, so the guard cannot tell which checkout (and branch) it runs in. Name the checkout's literal path.`;
  return `${denyJson(reason, { allowed })}\n`;
}
