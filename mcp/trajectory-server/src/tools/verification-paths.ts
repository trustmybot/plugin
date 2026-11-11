// Guard G15: refuses a verification[] naming a test file absent at the ref and from files[], and suggests importing tests from the world model (GH 2581).
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { accessSync, constants, readdirSync } from 'node:fs';
import { delimiter, join, posix } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { gitUnanswered, runGit } from '../utils/git-run.js';

// GH 2581: the test files a verification[] command names must exist at the
// task's ref, or be listed verbatim in files[] because the task creates them.

const TEST_BASENAMES = [/\.test\.(?:ts|mts|js|mjs|cjs)$/, /\.spec\.[^/]+$/, /\.suite\.ts$/, /^test_.*\.py$/];
const GLOB_CHARS = /[*?[{]/;
const SUGGESTION_LIMIT = 20;
const LS_TREE_MAX_BUFFER = 64 * 1024 * 1024;

export interface TestPathToken {
  command: string;
  token: string;
  dir: string;
}

export interface MissingTestPath {
  command: string;
  path: string;
  checked_as?: string;
  reason: string;
}

export interface VerificationPathRefusal {
  error: 'verification_path_missing' | 'verification_path_unverified' | 'verification_not_command';
  ref: string | null;
  missing: MissingTestPath[];
}

export interface VerificationSuggestion {
  test_path: string;
  imports: string[];
  source: 'world_model.imports';
}

export interface SuggestedVerification {
  suggested_verification: VerificationSuggestion[];
  suggested_verification_note?: string;
}

export function isTestPath(word: string): boolean {
  const base = posix.basename(word);
  return TEST_BASENAMES.some((re) => re.test(base));
}

type ShellToken = { op: string } | { word: string } | { heredoc: string };

const OPERATORS = ['&&', '||', '|&', ';;', '\n', ';', '|', '&', '(', ')'];

function closingParen(command: string, open: number): number {
  let depth = 0;
  for (let i = open; i < command.length; i++) {
    const c = command[i];
    if (c === '\\') i++;
    else if (c === "'") i = Math.max(i, command.indexOf("'", i + 1));
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return command.length - 1;
}

// Splits a shell command into words and control operators. Quotes are removed,
// `$(…)` and backquotes stay inside their word, and redirections (`2>&1`,
// `> out`, `&>file`) are dropped together with their target word. A heredoc
// body is data: the lines after its newline up to the delimiter are not split
// into words but emitted as one heredoc token, before that newline's operator.
function shellTokens(command: string): ShellToken[] {
  const out: ShellToken[] = [];
  let word = '';
  let inWord = false;
  let dropNext = false;
  let heredocNext: { stripTabs: boolean } | null = null;
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  const endWord = () => {
    if (inWord) {
      if (dropNext) {
        dropNext = false;
        if (heredocNext) heredocs.push({ delimiter: word, ...heredocNext });
        heredocNext = null;
      } else {
        out.push({ word });
      }
    }
    word = '';
    inWord = false;
  };
  const skipHeredocBodies = (from: number): number => {
    let pos = from;
    for (const { delimiter, stripTabs } of heredocs.splice(0)) {
      const body: string[] = [];
      while (pos < command.length) {
        const nl = command.indexOf('\n', pos);
        const raw = command.slice(pos, nl < 0 ? command.length : nl);
        pos = nl < 0 ? command.length : nl + 1;
        const line = stripTabs ? raw.replace(/^\t+/, '') : raw;
        if (line === delimiter) break;
        body.push(line);
      }
      out.push({ heredoc: body.join('\n') });
    }
    return pos;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      const end = close < 0 ? command.length : close;
      word += command.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length) j++;
        word += command[j];
        j++;
      }
      inWord = true;
      i = j;
    } else if (c === '\\' && i + 1 < command.length) {
      if (command[i + 1] !== '\n') {
        word += command[i + 1];
        inWord = true;
      }
      i++;
    } else if (c === '$' && command[i + 1] === '(') {
      const close = closingParen(command, i + 1);
      word += command.slice(i, close + 1);
      inWord = true;
      i = close;
    } else if (c === '`') {
      const close = command.indexOf('`', i + 1);
      const end = close < 0 ? command.length - 1 : close;
      word += command.slice(i, end + 1);
      inWord = true;
      i = end;
    } else if (c === '#' && !inWord) {
      const nl = command.indexOf('\n', i);
      i = (nl < 0 ? command.length : nl) - 1;
    } else if (c === '<' || c === '>' || (c === '&' && command[i + 1] === '>')) {
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      }
      endWord();
      let j = i + 1;
      while (j < command.length && /[<>&|]/.test(command[j]!)) j++;
      if (/\d/.test(command[j] ?? '') && command[j - 1] === '&') {
        while (/\d|-/.test(command[j] ?? '')) j++;
      } else {
        if (command.slice(i, j) === '<<') {
          heredocNext = { stripTabs: command[j] === '-' };
          if (heredocNext.stripTabs) j++;
        }
        dropNext = true;
      }
      i = j - 1;
    } else {
      const op = OPERATORS.find((o) => command.startsWith(o, i));
      if (op) {
        endWord();
        dropNext = false;
        heredocNext = null;
        i += op.length - 1;
        if (op === '\n' && heredocs.length > 0) i = skipHeredocBodies(i + 1) - 1;
        out.push({ op });
      } else if (/\s/.test(c)) {
        endWord();
      } else {
        word += c;
        inWord = true;
      }
    }
  }
  endWord();
  return out;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PREFIX_WORDS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', 'exec', 'command', 'nohup']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);

// Flags whose value is the next word, per runner; the value is never a test file.
const NODE_VALUE_FLAGS = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type',
  '--env-file', '--test-name-pattern', '--test-skip-pattern', '--test-reporter', '--test-reporter-destination',
  '--test-concurrency', '--test-timeout', '--test-shard', '--watch-path', '--title', '--inspect-port',
]);
const NODE_NO_SCRIPT_FLAGS = new Set(['-e', '--eval', '-p', '--print', '--run', '-v', '--version', '-h', '--help', '-c', '--check']);
const BUN_TEST_VALUE_FLAGS = new Set([
  '-t', '--test-name-pattern', '--timeout', '--preload', '--rerun-each', '--coverage-reporter', '--coverage-dir',
  '--reporter', '--reporter-outfile', '--cwd',
]);
const JS_RUNNER_VALUE_FLAGS = new Set([
  '-c', '--config', '-r', '--root', '--dir', '-t', '--testNamePattern', '-g', '--grep', '--fgrep', '-R', '--reporter',
  '--reporter-options', '--require', '--timeout', '--project', '--environment', '--shard', '--exclude', '--ignore',
  '--testPathIgnorePatterns', '--outputFile', '--spec', '--file', '--extension', '--ui', '--mode',
]);
const PYTEST_VALUE_FLAGS = new Set([
  '-k', '-m', '-c', '-p', '-o', '-W', '-n', '-r', '--rootdir', '--ignore', '--ignore-glob', '--deselect', '--junitxml',
  '--junit-xml', '--basetemp', '--confcutdir', '--tb', '--maxfail', '--durations', '--cov', '--cov-report',
  '--log-level', '--override-ini', '--import-mode', '--capture', '--dist', '--maxprocesses',
]);
const JS_RUNNERS = new Set(['vitest', 'jest', 'mocha']);
const VITEST_SUBCOMMANDS = new Set(['run', 'watch', 'dev', 'bench']);

// The positional words after `argv[from]`, skipping flags and the value of
// each flag in valueFlags; `--` makes every later word positional.
function positionals(argv: readonly string[], from: number, valueFlags: ReadonlySet<string>): string[] {
  const out: string[] = [];
  let flagsDone = false;
  for (let i = from; i < argv.length; i++) {
    const w = argv[i]!;
    if (!flagsDone && w === '--') flagsDone = true;
    else if (!flagsDone && w.startsWith('-') && w.length > 1) {
      if (!w.includes('=') && valueFlags.has(w)) i++;
    } else out.push(w);
  }
  return out;
}

function nodeTestFiles(argv: readonly string[]): string[] {
  const testMode = argv.some((w) => w === '--test' || w.startsWith('--test='));
  const files: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i]!;
    if (w === '--') {
      files.push(...argv.slice(i + 1));
      break;
    }
    if (w.startsWith('-') && w.length > 1) {
      const flag = w.split('=')[0]!;
      if (NODE_NO_SCRIPT_FLAGS.has(flag)) return [];
      if (!w.includes('=') && NODE_VALUE_FLAGS.has(w)) i++;
      continue;
    }
    files.push(w);
    if (!testMode) break;
  }
  return testMode ? files : files.slice(0, 1);
}

function jsRunnerFiles(argv: readonly string[], at: number): string[] {
  const name = posix.basename(argv[at]!).replace(/(?<=.)@.*$/, '');
  if (!JS_RUNNERS.has(name)) return [];
  const words = positionals(argv, at + 1, JS_RUNNER_VALUE_FLAGS);
  return name === 'vitest' && VITEST_SUBCOMMANDS.has(words[0] ?? '') ? words.slice(1) : words;
}

// The index of the vitest/jest/mocha word a package-runner prefix launches.
function packageRunnerAt(argv: readonly string[]): number | null {
  const prog = posix.basename(argv[0]!);
  let i: number;
  if (prog === 'npx' || prog === 'bunx') i = 1;
  else if ((prog === 'pnpm' || prog === 'yarn') && (argv[1] === 'exec' || argv[1] === 'dlx')) i = 2;
  else if (prog === 'bun' && argv[1] === 'x') i = 2;
  else return JS_RUNNERS.has(prog) ? 0 : null;
  for (; i < argv.length; i++) {
    const w = argv[i]!;
    if (w === '-c' || w === '--call') return null;
    if (w === '-p' || w === '--package') i++;
    else if (!w.startsWith('-')) return i;
  }
  return null;
}

// The words a test-runner statement hands its runner as test files; any other
// program's words are never test files.
function runnerTestFiles(argv: readonly string[]): string[] {
  const prog = posix.basename(argv[0]!);
  if (prog === 'node' || prog === 'nodejs') return nodeTestFiles(argv);
  if (prog === 'bun' && argv[1] === 'test') return positionals(argv, 2, BUN_TEST_VALUE_FLAGS);
  if (prog === 'pytest' || prog === 'py.test') return positionals(argv, 1, PYTEST_VALUE_FLAGS).map((w) => w.split('::')[0]!);
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(prog)) {
    const m = argv.indexOf('-m');
    return m > 0 && argv[m + 1] === 'pytest'
      ? positionals(argv, m + 2, PYTEST_VALUE_FLAGS).map((w) => w.split('::')[0]!)
      : [];
  }
  const at = packageRunnerAt(argv);
  return at === null ? [] : jsRunnerFiles(argv, at);
}

// The `-c` script of a `bash|sh|zsh|dash -c '<cmd>'` statement, else null.
function shellScript(argv: readonly string[]): string | null {
  if (!SHELLS.has(posix.basename(argv[0]!))) return null;
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i]!;
    if (!/^[-+]/.test(w)) return null;
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(w)) return argv[i + 1] ?? null;
    if (/^[-+][a-zA-Z]*o$/.test(w)) i++;
  }
  return null;
}

function stripPrefix(words: readonly string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (PREFIX_WORDS.has(w) || ASSIGNMENT.test(w)) i++;
    else if (w === 'env') {
      i++;
      while (i < words.length && (ASSIGNMENT.test(words[i]!) || words[i] === '-i')) i++;
    } else break;
  }
  return words.slice(i);
}

function cdTarget(dir: string, argv: readonly string[]): string {
  const args = argv.slice(1).filter((w) => !/^-[LPe@]+$/.test(w) && w !== '--');
  const target = args[0];
  if (target === undefined || target === '-') return '~';
  if (target.startsWith('/') || target.startsWith('~') || /[$`]/.test(target)) return target;
  return posix.normalize(posix.join(dir || '.', target)).replace(/^\.$/, '');
}

function collectTokens(command: string, script: string, startDir: string, out: TestPathToken[]): void {
  let dir = startDir;
  const subshells: string[] = [];
  const pushed: string[] = [];
  let words: string[] = [];
  let prevOp = '';
  const finish = (op: string) => {
    const argv = stripPrefix(words);
    words = [];
    const inPipe = prevOp === '|' || prevOp === '|&' || op === '|' || op === '|&' || op === '&';
    prevOp = op;
    if (argv.length === 0) return;
    const prog = argv[0]!;
    if (prog === 'cd' || prog === 'pushd') {
      if (inPipe) return;
      if (prog === 'pushd') pushed.push(dir);
      dir = cdTarget(dir, argv);
    } else if (prog === 'popd') {
      if (!inPipe) dir = pushed.pop() ?? '~';
    } else {
      const inner = shellScript(argv);
      if (inner !== null) collectTokens(command, inner, dir, out);
      for (const w of runnerTestFiles(argv)) if (isTestPath(w)) out.push({ command, token: w, dir });
    }
  };
  for (const t of shellTokens(script)) {
    if ('word' in t) {
      words.push(t.word);
    } else if ('heredoc' in t) {
      const argv = stripPrefix(words);
      const prog = argv[0];
      if (prog !== undefined && SHELLS.has(posix.basename(prog)) && shellScript(argv) === null) {
        collectTokens(command, t.heredoc, dir, out);
      }
    } else if (t.op === '(') {
      finish(';');
      subshells.push(dir);
    } else if (t.op === ')') {
      finish(';');
      dir = subshells.pop() ?? dir;
    } else {
      finish(t.op);
    }
  }
  finish(';');
}

// The test files one verification command hands a test runner (node, bun
// test, vitest/jest/mocha, pytest), each with the directory it resolves under:
// a `cd` at any step sets it for the steps after, a `( … )` subshell restores
// it at its close, and `bash -c '<cmd>'` or a heredoc fed to a bare shell is
// read as its own command.
export function testPathTokens(command: string): TestPathToken[] {
  const out: TestPathToken[] = [];
  collectTokens(command, command, '', out);
  return out;
}

const ENGLISH_WORD = /^[A-Z][a-z]+$/;
const SHELL_BUILTINS = new Set([
  'cd', 'pushd', 'popd', 'test', '[', '[[', 'true', 'false', 'echo', 'printf', 'export', 'set', 'unset', 'source', '.',
  ':', 'eval', 'exit', 'return', 'read', 'shift', 'trap', 'wait', 'type', 'alias', 'ulimit', 'umask', 'local',
]);

// The first command word of every simple command, env assignments and
// prefix words skipped; `bash -c '<cmd>'` contributes its own commands.
function firstCommandWords(script: string): string[] {
  const out: string[] = [];
  let words: string[] = [];
  const finish = () => {
    const argv = stripPrefix(words);
    words = [];
    const [prog] = argv;
    if (prog === undefined) return;
    out.push(prog);
    const inner = shellScript(argv);
    if (inner !== null) out.push(...firstCommandWords(inner));
  };
  for (const t of shellTokens(script)) {
    if ('word' in t) words.push(t.word);
    else if ('op' in t) finish();
  }
  finish();
  return out;
}

// Exact-name lookup: a case-insensitive filesystem would answer `Test` for
// `test`, so each PATH dir is listed once instead of probed per word.
class PathExecutables {
  private readonly listings = new Map<string, ReadonlySet<string>>();

  has(word: string): boolean {
    for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
      if (!dir) continue;
      if (this.listing(dir).has(word) && this.executable(join(dir, word))) return true;
    }
    return false;
  }

  private listing(dir: string): ReadonlySet<string> {
    let names = this.listings.get(dir);
    if (!names) {
      try {
        names = new Set(readdirSync(dir));
      } catch {
        names = new Set();
      }
      this.listings.set(dir, names);
    }
    return names;
  }

  private executable(path: string): boolean {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function resolvesAsCommand(word: string, onPath: PathExecutables): boolean {
  return word.includes('/') || SHELL_BUILTINS.has(word) || onPath.has(word);
}

// GH 2955: a verification[] entry whose command word is a capitalized English
// word that runs as nothing is a prose sentence the close gate would fail on
// with exit 127. Lower-case words are never refused for missing from PATH.
export function checkVerificationProse(verification: readonly string[], ref: string | null): VerificationPathRefusal | null {
  const onPath = new PathExecutables();
  const missing: MissingTestPath[] = [];
  for (const command of verification) {
    const word = firstCommandWords(command).find((w) => ENGLISH_WORD.test(w) && !resolvesAsCommand(w, onPath));
    if (word !== undefined) {
      missing.push({ command, path: word, reason: `"${word}" is not a runnable command; give a shell command the close gate can run` });
    }
  }
  return missing.length > 0 ? { error: 'verification_not_command', ref, missing } : null;
}

export function resolveTestPath(
  repoPath: string | null,
  dir: string,
  token: string,
): { path: string } | { reason: string } {
  if (/[$`]/.test(dir + token) || dir.startsWith('~') || token.startsWith('~')) {
    return { reason: 'uses a shell expansion git cannot check' };
  }
  let p = token.startsWith('/') ? token : posix.join(dir || '.', token);
  if (p.startsWith('/')) {
    if (!repoPath) return { reason: 'is an absolute path and no repo path resolves' };
    p = posix.relative(repoPath, p);
  }
  p = posix.normalize(p);
  if (p === '..' || p.startsWith('../') || p.startsWith('/')) return { reason: 'resolves outside the repo' };
  return { path: p.replace(/^\.\//, '') };
}

// A built dist/**/*.js path maps to the src/**/*.ts it is compiled from.
export function srcSourceOf(path: string): string | null {
  const m = /^((?:.*\/)?)dist\/(.+)\.js$/.exec(path);
  return m ? `${m[1]}src/${m[2]}.ts` : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export function globRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[' && glob.indexOf(']', i + 2) > 0) {
      const close = glob.indexOf(']', i + 2);
      const body = glob.slice(i + 1, close);
      re += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`.replace(/\\/g, '\\\\');
      i = close;
    } else if (c === '{' && glob.indexOf('}', i + 1) > 0) {
      const close = glob.indexOf('}', i + 1);
      re += `(?:${glob.slice(i + 1, close).split(',').map(escapeRe).join('|')})`;
      i = close;
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp(`^${re}$`);
}

type Tracked = 'yes' | 'no' | { error: string };

function gitFailure(res: { error?: Error; stderr?: string | null; status: number | null }): string {
  return res.error?.message.split('\n')[0] || (res.stderr ?? '').trim().split('\n')[0] || `git exited ${res.status}`;
}

class TreeProbe {
  private readonly listings = new Map<string, string[] | { error: string }>();

  constructor(
    private readonly repoPath: string,
    private readonly ref: string,
  ) {}

  blob(path: string): Tracked {
    const res = runGit(this.repoPath, ['cat-file', '-e', `${this.ref}:${path}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (gitUnanswered(res)) return { error: gitFailure(res) };
    return res.status === 0 ? 'yes' : 'no';
  }

  glob(pattern: string): Tracked {
    const literal = pattern.slice(0, pattern.search(GLOB_CHARS));
    const prefix = literal.slice(0, literal.lastIndexOf('/') + 1);
    let listing = this.listings.get(prefix);
    if (!listing) {
      const res = runGit(
        this.repoPath,
        ['ls-tree', '-r', '-z', '--name-only', '--full-tree', this.ref, ...(prefix ? ['--', prefix] : [])],
        { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: LS_TREE_MAX_BUFFER },
      );
      listing = gitUnanswered(res) || res.status !== 0 ? { error: gitFailure(res) } : res.stdout.split('\0').filter(Boolean);
      this.listings.set(prefix, listing);
    }
    if (!Array.isArray(listing)) return listing;
    const re = globRegExp(pattern);
    return listing.some((p) => re.test(p)) ? 'yes' : 'no';
  }
}

function admitted(probe: TreeProbe, files: readonly string[], path: string): Tracked {
  if (GLOB_CHARS.test(path)) {
    const re = globRegExp(path);
    return files.some((f) => re.test(f)) ? 'yes' : probe.glob(path);
  }
  return files.includes(path) ? 'yes' : probe.blob(path);
}

// Refuses (returns non-null) when a verification[] entry is prose, not a
// command, or when a test path a verification[] command names is not proven by git at `ref` and not listed verbatim in files[]. A git
// error, an unresolvable ref or no repo path refuses too.
export function checkVerificationPaths(input: {
  repoPath: string | null;
  ref: string | null;
  verification: readonly string[];
  files: readonly string[];
}): VerificationPathRefusal | null {
  const { repoPath, ref, verification, files } = input;
  const prose = checkVerificationProse(verification, ref);
  if (prose) return prose;
  const tokens = verification.flatMap(testPathTokens);
  if (tokens.length === 0) return null;
  const resolved = tokens.map((t) => ({ ...t, ...resolveTestPath(repoPath, t.dir, t.token) }));
  const named = (t: (typeof resolved)[number]) => ('path' in t ? t.path : t.token);

  if (!repoPath || !ref) {
    const reason = !repoPath ? 'no git repo path resolves for the task' : 'the ref to check does not resolve';
    return {
      error: 'verification_path_unverified',
      ref,
      missing: resolved.map((t) => ({ command: t.command, path: named(t), reason })),
    };
  }
  const head = runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (gitUnanswered(head) || head.status !== 0) {
    const reason = `git cannot resolve ${ref}: ${gitFailure(head)}`;
    return {
      error: 'verification_path_unverified',
      ref,
      missing: resolved.map((t) => ({ command: t.command, path: named(t), reason })),
    };
  }

  const probe = new TreeProbe(repoPath, ref);
  const missing: MissingTestPath[] = [];
  const gitErrors: MissingTestPath[] = [];
  const seen = new Set<string>();
  for (const t of resolved) {
    const key = `${t.command}\0${named(t)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!('path' in t)) {
      missing.push({ command: t.command, path: t.token, reason: t.reason });
      continue;
    }
    let answer = admitted(probe, files, t.path);
    const src = answer === 'no' ? srcSourceOf(t.path) : null;
    if (src) answer = admitted(probe, files, src);
    if (typeof answer === 'object') {
      gitErrors.push({ command: t.command, path: t.path, ...(src ? { checked_as: src } : {}), reason: `git failed: ${answer.error}` });
    } else if (answer === 'no') {
      const glob = GLOB_CHARS.test(t.path);
      missing.push({
        command: t.command,
        path: t.path,
        ...(src ? { checked_as: src } : {}),
        reason: glob ? `no tracked file at ${ref} matches the glob` : `not tracked at ${ref}`,
      });
    }
  }
  if (gitErrors.length > 0) return { error: 'verification_path_unverified', ref, missing: [...gitErrors, ...missing] };
  if (missing.length > 0) return { error: 'verification_path_missing', ref, missing };
  return null;
}

export function verificationPathResult(tool: string, refusal: VerificationPathRefusal): CallToolResult {
  const listed = refusal.missing
    .map((m) => `${m.path}${m.checked_as ? ` (checked as ${m.checked_as})` : ''} in "${m.command}": ${m.reason}`)
    .join('; ');
  const message =
    refusal.error === 'verification_not_command'
      ? `${tool}: verification[] holds prose, not shell commands: ${listed}. ` +
        `Write each entry as a command whose exit code proves the criterion. Nothing was written.`
      : `${tool}: verification[] names test file(s) not proven at ${refusal.ref ?? '(no ref)'}: ${listed}. ` +
        `List a test the task creates verbatim in files[], commit it first, or fix the command. Nothing was written.`;
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: refusal.error, message, ref: refusal.ref, missing: refusal.missing }) }],
  };
}

function namedMatchers(repoPath: string | null, verification: readonly string[]): Array<(p: string) => boolean> {
  const out: Array<(p: string) => boolean> = [];
  for (const t of verification.flatMap(testPathTokens)) {
    const r = resolveTestPath(repoPath, t.dir, t.token);
    if (!('path' in r)) continue;
    for (const p of [r.path, srcSourceOf(r.path)]) {
      if (!p) continue;
      if (GLOB_CHARS.test(p)) {
        const re = globRegExp(p);
        out.push((x) => re.test(x));
      } else {
        out.push((x) => x === p);
      }
    }
  }
  return out;
}

// The existing tests whose module imports a files[] module, read from the
// world model's 'imports' edges; tests verification[] already names are left
// out. Never blocks.
export function suggestVerification(
  db: TrajectoryDB,
  repo: string | null,
  repoPath: string | null,
  files: readonly string[],
  verification: readonly string[],
): SuggestedVerification {
  const hasRows = repo !== null && db.get<{ one: number }>(`SELECT 1 AS one FROM wm_symbols WHERE repo = ? LIMIT 1`, [repo]);
  if (!hasRows) {
    return {
      suggested_verification: [],
      suggested_verification_note: `the world model has no rows for repo '${repo ?? ''}'; run /scan to get import-based suggestions`,
    };
  }
  const rows = db.all<{ test_path: string; imports: string }>(
    `SELECT DISTINCT o.path AS test_path, d.path AS imports
       FROM wm_edges e JOIN wm_symbols d ON d.id = e.dst_id JOIN wm_symbols o ON o.id = e.src_id
      WHERE e.kind = 'imports' AND d.repo = ? AND o.repo = ? AND o.path <> d.path
        AND d.path IN (SELECT value FROM json_each(?))
      ORDER BY o.path, d.path`,
    [repo, repo, JSON.stringify(files)],
  );
  const named = namedMatchers(repoPath, verification);
  const byTest = new Map<string, string[]>();
  for (const r of rows) {
    if (!isTestPath(r.test_path) || named.some((m) => m(r.test_path))) continue;
    const list = byTest.get(r.test_path) ?? [];
    list.push(r.imports);
    byTest.set(r.test_path, list);
  }
  const suggested_verification = [...byTest.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, SUGGESTION_LIMIT)
    .map(([test_path, imports]) => ({ test_path, imports, source: 'world_model.imports' as const }));
  return { suggested_verification };
}
