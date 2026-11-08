import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { posix } from 'node:path';
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
  error: 'verification_path_missing' | 'verification_path_unverified';
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

function statements(command: string): string[][] {
  const out: string[][] = [[]];
  let word = '';
  let inWord = false;
  let redirect = false;
  const endWord = () => {
    if (inWord && !redirect) out[out.length - 1]!.push(word);
    if (inWord) redirect = false;
    word = '';
    inWord = false;
  };
  const endStatement = () => {
    endWord();
    redirect = false;
    if (out[out.length - 1]!.length > 0) out.push([]);
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
      word += command[i + 1];
      inWord = true;
      i++;
    } else if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      endStatement();
    } else if (/\s/.test(c)) {
      endWord();
    } else if (c === '<' || c === '>') {
      endWord();
      redirect = true;
    } else {
      word += c;
      inWord = true;
    }
  }
  endWord();
  return out.filter((s) => s.length > 0);
}

// The test path words of one command. A leading `cd <dir> &&` sets the
// directory every later word resolves under; otherwise words resolve from the
// repo root.
export function testPathTokens(command: string): TestPathToken[] {
  const stmts = statements(command);
  let dir = '';
  let rest = stmts;
  const first = stmts[0];
  if (stmts.length > 1 && first && first.length === 2 && first[0] === 'cd') {
    dir = first[1]!;
    rest = stmts.slice(1);
  }
  const out: TestPathToken[] = [];
  for (const words of rest) {
    for (const w of words) {
      if (!w.startsWith('-') && isTestPath(w)) out.push({ command, token: w, dir });
    }
  }
  return out;
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

// Refuses (returns non-null) when a test path a verification[] command names
// is not proven by git at `ref` and not listed verbatim in files[]. A git
// error, an unresolvable ref or no repo path refuses too.
export function checkVerificationPaths(input: {
  repoPath: string | null;
  ref: string | null;
  verification: readonly string[];
  files: readonly string[];
}): VerificationPathRefusal | null {
  const { repoPath, ref, verification, files } = input;
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
    `${tool}: verification[] names test file(s) not proven at ${refusal.ref ?? '(no ref)'}: ${listed}. ` +
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
