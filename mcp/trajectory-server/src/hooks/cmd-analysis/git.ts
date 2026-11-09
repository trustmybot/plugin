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
import { Encoder, NO_CHARGE, decode, encode } from './encode.js';
import { NOT_LITERAL, gitWord } from './git-word.js';
import { bashParser } from './parser.js';
import { ALT, LOOP_CLOSE, LOOP_OPEN, statementsEnc, type Record } from './statements.js';

/** A listed statement; `src` is its text as the command wrote it, quotes and all, when the listing can find it (GH 2536). */
export type Statement = Record & { readonly src?: string };

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
const ENCODED = /[\x01-\x06\x0e-\x11\x13\x15\x16]/g;
const HD_MARK = /<<[\x1a\x1e]/g;

/** `read -r -a w <<< "$s"`: the first line's words. */
function readWords(s: string): string[] {
  return (s.split('\n')[0] ?? '').split(/[ \t]+/).filter((w) => w !== '');
}

/** What `IFS=$'\t' read -r dir stmt` leaves of a statement: no leading or trailing tabs. */
function readStmt(stmt: string): string {
  return stmt.replace(/^\t+|\t+$/g, '');
}

/** _tmb_cmd_inner: the encoded string `bash|sh|zsh|dash|ksh -c <s>` runs, or the rest of `eval <s>`; "" otherwise. */
function inner(stmt: string): string {
  const words = readWords(stmt);
  const argv0 = words[0] ?? '';
  if (SHELL.test(argv0)) {
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (w === '-c' || /^-[a-zA-Z].*c$/s.test(w) || /^-c[a-zA-Z]/.test(w)) return words[i + 1] ?? '';
      if (!w.startsWith('-')) return '';
    }
    return '';
  }
  if (argv0 === 'eval') return (stmt.startsWith('eval') ? stmt.slice(4) : stmt).replace(/^ /, '');
  return '';
}

/** The nodes a statement's source can be: a command, unless it is a redirected statement's body, and a redirected statement; children first. */
function candidates(node: Node, out: Node[] = []): Node[] {
  for (const child of node.namedChildren) if (child) candidates(child, out);
  const body = node.parent?.type === 'redirected_statement' && node.parent.childForFieldName('body')?.id === node.id;
  if (node.type === 'redirected_statement' || (node.type === 'command' && !body)) out.push(node);
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
    const encoder = new Encoder(cmd, NO_CHARGE);
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
 * it defines outlive it, so their statements run in `-`.
 */
function listing(parser: Parser, cmd: string, base: string, depth: number, home: string, escaped = false): Statement[] | null {
  if (cmd.trim() === '') return [];
  const encoded = encode(parser, cmd);
  if (!encoded.ok) return null;
  const out: Statement[] = [];
  const records = statementsEnc(encoded.text, base, home, false, NO_CHARGE, escaped ? 'escaped' : 'calls')
    .filter((record) => record.dir !== LOOP_OPEN && record.dir !== LOOP_CLOSE)
    .map((record) => ({
      dir: record.dir,
      stmt: readStmt(record.stmt),
      ...(record.cut ? { cut: record.cut } : {}),
      ...(record.wrappers ? { wrappers: record.wrappers } : {}),
    }))
    .filter((record) => record.stmt !== '');
  let srcs: Array<string | undefined> | undefined;
  const srcAt = (k: number): string | undefined => (srcs ??= sources(parser, cmd, home, records.map((record) => record.stmt)))[k];
  for (const [k, { dir, stmt, cut, wrappers }] of records.entries()) {
    const body = depth < MAX_DEPTH && !dir.startsWith('=') ? inner(stmt) : '';
    if (body === '') {
      for (const one of dir.split(ALT)) out.push(withSource({ dir: one, stmt, ...(cut ? { cut } : {}), ...(wrappers ? { wrappers } : {}) }, () => srcAt(k)));
      continue;
    }
    const nested = listing(parser, decode(body).replace(/\n+$/, ''), dir, depth + 1, home, readWords(stmt)[0] === 'eval');
    if (nested === null) return null;
    out.push(...nested);
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
  const shown = (text: string): string => text.replace(HD_MARK, '<<').replace(ENCODED, '_');
  for (const entry of listed) {
    let dir = entry.dir;
    if (dir.startsWith('@/')) dir = isDir(cwd) ? `${cwd.replace(/\/$/, '')}${dir.slice(1)}` : '-';
    else if (dir === '@') dir = state ??= await cwdState(cwd, env);
    const stmt = shown(entry.stmt);
    const extra = { ...(entry.cut ? { cut: entry.cut } : {}), ...(entry.wrappers ? { wrappers: shown(entry.wrappers) } : {}) };
    statements.push(withSource({ dir, stmt, ...extra }, () => entry.src));
  }
  return { ok: true, statements };
}

/** git's words in <w> from the word gitWord finds, that word made `git`. */
function fromGit(w: readonly string[], at: number): string[] {
  return ['git', ...w.slice(at + 1)];
}

/**
 * tmb_git_subcommand <stmt>: the words from git's subcommand on, "" when
 * <stmt> is no git command; git behind wrappers or by path as gitWord finds
 * it, an unsure place included (GH 2797).
 */
export function gitSubcommand(stmt: string): string {
  const words = readWords(stmt);
  const found = gitWord(words);
  if (found === null) return '';
  const w = fromGit(words, found.at);
  const k = subcommandAt(w);
  return k < w.length ? w.slice(k).join(' ') : '';
}

const VALUE_OPTIONS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace'];
const VALUE_JOINED = /^--(git-dir|work-tree|namespace)=/;
/** The same for a value-taking option's argument, where a parameter, command or arithmetic expansion cannot move the subcommand. */
const NOT_LITERAL_VALUE = /[*?[]|(^|[^$]){|^[0-9]*[<>]|^&>/;

type SubcommandInput = string | (Pick<Statement, 'stmt'> & Partial<Pick<Statement, 'cut' | 'src' | 'wrappers'>>);

/**
 * git's subcommand in <statement> and the words after it, as gitSubcommand
 * gives them, or undefined when it is unknown (GH 2634): the subcommand word,
 * or an option word before it that is no value-taking option's argument,
 * holds an expansion, a brace or glob pattern, or is a redirect; an
 * argument of `-C` / `-c` / `--git-dir` / `--work-tree` / `--namespace`
 * (or the `=value` of the last three) only when it is a pattern or a
 * redirect. Where an unquoted $( ) or backtick cut the statement inside that
 * span, the words are read from its `src`, read only then, and a `src` that
 * is missing or does not line up leaves it unknown. git behind wrappers or
 * by path counts (GH 2797); an unsure place (gitWord), the `wrappers` the
 * listing skipped reading another one or reaching a git the statement's own
 * words do not (`env $X git push`), or an `xargs` git with no subcommand
 * word, which stdin supplies, leaves it unknown.
 */
export function gitSubcommandOf(statement: SubcommandInput): string | undefined {
  const { stmt, cut, wrappers } = typeof statement === 'string' ? { stmt: statement, cut: undefined, wrappers: undefined } : statement;
  let w = readWords(stmt);
  const found = gitWord(w);
  if (found === null) return wrappers !== undefined && gitWord([...readWords(wrappers), ...w]) !== null ? undefined : '';
  if (!found.sure) return undefined;
  let xargs = found.xargs;
  if (wrappers !== undefined) {
    const lead = readWords(wrappers);
    const whole = gitWord([...lead, ...w]);
    if (whole === null || !whole.sure || whole.at !== lead.length + found.at) return undefined;
    xargs ||= whole.xargs;
  }
  let g = fromGit(w, found.at);
  let k = found.at + subcommandAt(g);
  if (cut !== undefined && typeof statement !== 'string') {
    const at = cut === 'glued' ? w.length - 1 : w.length;
    if (k >= at) {
      const src = statement.src;
      const words = src === undefined ? null : sourceWords(src);
      if (words === null || words.findIndex((word) => word.sub) !== at) return undefined;
      w = words.map((word) => word.text);
      const again = gitWord(w);
      if (again === null || !again.sure || again.at !== found.at) return undefined;
      g = fromGit(w, found.at);
    }
  }
  k = subcommandAt(g);
  if (xargs && k >= g.length) return undefined;
  return spanLiteral(g) ? (k < g.length ? g.slice(k).join(' ') : '') : undefined;
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

/** Where each word of the first line of shell source `src` starts, with its unquoted text and whether an unquoted $( ) or backtick is in it; null at an unclosed quote or substitution. */
function sourceWords(src: string): Array<{ start: number; text: string; sub: boolean }> | null {
  const words: Array<{ start: number; text: string; sub: boolean }> = [];
  let i = 0;
  for (;;) {
    while (src[i] === ' ' || src[i] === '\t') i++;
    if (i >= src.length || src[i] === '\n') return words;
    const start = i;
    let text = '';
    let sub = false;
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
        text += c;
        i++;
      }
    }
    words.push({ start, text, sub });
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
