/**
 * The two built-in diff checks (GH 1740, moved here by GH 2570) that the close
 * lints run after a repo's own lints and code-reviewer-preflight runs before a
 * review, both over git objects only:
 *
 *   stale_doc_ref      no path the diff (base..commit) deletes or renames, and no MCP
 *                      tool name it drops from mcp/<server>/src/tools/, appears in the
 *                      agents/, skills/, docs/ *.md, CLAUDE.md or README.md at the commit;
 *                      a removed path the commit's own .gitignore files ignore is untracked
 *                      build output, not removed (GH 2054)
 *   missing_changelog  with a changelog.d/ at base or commit, the diff adds a file under it
 *
 * builtinLints gives both as close-lint results, exit 0 or 1 with the failure
 * text as output. A change to either check's behavior bumps
 * BUILTIN_LINTS_VERSION (lint-fingerprint.ts).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitSpawn } from './git.js';

export const MISSING_CHANGELOG = 'missing_changelog';
export const STALE_DOC_REF = 'stale_doc_ref';
export const CHANGELOG_DIR = 'changelog.d';

const GIT_TIMEOUT_MS = 10_000;
const DOC_PATH = /^(?:(?:agents|skills|docs)\/.*\.md|CLAUDE\.md|README\.md)$/;
const TOOL_SOURCE = /^mcp\/[^/]+\/src\/tools\/(?:[^/]+\/)*[^/]+\.ts$/;
const TOOL_NAME = /^\s*name:\s*['"]([a-z][a-z0-9]*(?:_[a-z0-9]+)+)['"]\s*,?\s*$/gm;
const GITIGNORE = /(?:^|\/)\.gitignore$/;
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE'];

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function git(repo: string, args: string[], env: NodeJS.ProcessEnv): Promise<GitResult> {
  const r = await gitSpawn(repo, args, { env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, stderr: 'pipe', timeoutMs: GIT_TIMEOUT_MS });
  return { code: r.code, stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8') || (r.error?.message ?? '') };
}

export function nulFields(text: string): string[] {
  const fields = text.split('\0');
  if (fields.at(-1) === '') fields.pop();
  return fields;
}

/** Tracked blobs of <rev>: path → object id. */
async function treeBlobs(repo: string, rev: string, env: NodeJS.ProcessEnv): Promise<Map<string, string> | null> {
  const r = await git(repo, ['ls-tree', '-r', '-z', '--full-tree', rev], env);
  if (r.code !== 0) return null;
  const blobs = new Map<string, string>();
  for (const entry of nulFields(r.stdout)) {
    const tab = entry.indexOf('\t');
    const [, type, oid] = entry.slice(0, tab).split(' ');
    if (type === 'blob') blobs.set(entry.slice(tab + 1), oid);
  }
  return blobs;
}

/** The contents of <oids>, read through one `git cat-file --batch`. */
async function readBlobs(repo: string, oids: readonly string[], env: NodeJS.ProcessEnv): Promise<Map<string, string> | null> {
  const contents = new Map<string, string>();
  if (oids.length === 0) return contents;
  const r = await gitSpawn(repo, ['cat-file', '--batch'], {
    input: `${oids.join('\n')}\n`,
    env: { ...env, GIT_OPTIONAL_LOCKS: '0' },
    stderr: 'pipe',
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (r.code !== 0) return null;
  const out = r.stdout;
  let at = 0;
  while (at < out.length) {
    const eol = out.indexOf(0x0a, at);
    if (eol < 0) return null;
    const [oid, type, size] = out.subarray(at, eol).toString('utf8').split(' ');
    if (type === undefined || size === undefined) return null;
    const start = eol + 1;
    const end = start + Number(size);
    contents.set(oid, out.subarray(start, end).toString('utf8'));
    at = end + 1;
  }
  return contents;
}

function toolNames(blobs: Map<string, string>, contents: Map<string, string>): Set<string> {
  const names = new Set<string>();
  for (const [path, oid] of blobs) {
    if (!TOOL_SOURCE.test(path) || path.includes('/test/')) continue;
    for (const m of (contents.get(oid) ?? '').matchAll(TOOL_NAME)) names.add(m[1]);
  }
  return names;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A repo path as a doc mentions it: bare or after ./ or ../, never inside a longer path or name. */
function pathPattern(path: string): RegExp {
  return new RegExp(`(?:^|(?<=\\./)|(?<![A-Za-z0-9_./-]))${escapeRegExp(path)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'm');
}

/** A tool name as a word, or as the tail of an mcp__<server>__<tool> id. */
function toolPattern(name: string): RegExp {
  return new RegExp(`(?:(?<=__)|(?<![A-Za-z0-9_]))${escapeRegExp(name)}(?![A-Za-z0-9_])`, 'm');
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

interface Removed {
  paths: string[];
  tools: string[];
}

async function removedInDiff(repo: string, base: string, commit: string, env: NodeJS.ProcessEnv): Promise<Removed | string> {
  const diff = await git(repo, ['diff', '--no-ext-diff', '--name-status', '-z', '-M', base, commit], env);
  if (diff.code !== 0) return `git diff ${base}..${commit} failed: ${diff.stderr.trim()}`;
  const fields = nulFields(diff.stdout);
  const paths: string[] = [];
  let touchesTools = false;
  for (let i = 0; i < fields.length; ) {
    const status = fields[i];
    const renamed = status.startsWith('R') || status.startsWith('C');
    const from = fields[i + 1];
    const to = renamed ? fields[i + 2] : from;
    i += renamed ? 3 : 2;
    if (TOOL_SOURCE.test(from) || TOOL_SOURCE.test(to)) touchesTools = true;
    if (status === 'D' || status.startsWith('R')) paths.push(from);
  }
  if (!touchesTools) return { paths, tools: [] };
  const before = await treeBlobs(repo, base, env);
  const after = await treeBlobs(repo, commit, env);
  if (!before || !after) return `git ls-tree of ${base} or ${commit} failed`;
  const sources = (blobs: Map<string, string>) =>
    [...blobs].filter(([p]) => TOOL_SOURCE.test(p) && !p.includes('/test/')).map(([, oid]) => oid);
  const contents = await readBlobs(repo, [...new Set([...sources(before), ...sources(after)])], env);
  if (!contents) return 'git cat-file of the tool sources failed';
  const kept = toolNames(after, contents);
  return { paths, tools: [...toolNames(before, contents)].filter((t) => !kept.has(t)).sort() };
}

/**
 * The <paths> the .gitignore files in <blobs> ignore, judged by `git check-ignore --no-index`
 * in a scratch repo holding only those files, or null when that fails.
 */
async function ignoredByTree(
  repo: string,
  blobs: Map<string, string>,
  paths: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<Set<string> | null> {
  const rules = [...blobs].filter(([p]) => GITIGNORE.test(p));
  if (rules.length === 0 || paths.length === 0) return new Set();
  const contents = await readBlobs(repo, rules.map(([, oid]) => oid), env);
  if (!contents) return null;
  const scratchEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of REPO_ENV) delete scratchEnv[key];
  let scratch: string | null = null;
  try {
    scratch = await mkdtemp(join(tmpdir(), 'tmb-preflight-ignore-'));
    for (const [path, oid] of rules) {
      await mkdir(dirname(join(scratch, path)), { recursive: true });
      await writeFile(join(scratch, path), contents.get(oid) ?? '');
    }
    if ((await git(scratch, ['init', '-q', '--template='], scratchEnv)).code !== 0) return null;
    const r = await gitSpawn(
      scratch,
      ['-c', `core.excludesFile=${join(scratch, '.no-excludes')}`, 'check-ignore', '--no-index', '-z', '--stdin'],
      { input: `${paths.join('\0')}\0`, env: { ...scratchEnv, GIT_OPTIONAL_LOCKS: '0' }, stderr: 'pipe', timeoutMs: GIT_TIMEOUT_MS },
    );
    if (r.code === 1) return new Set();
    if (r.code !== 0) return null;
    return new Set(nulFields(r.stdout.toString('utf8')));
  } catch {
    return null;
  } finally {
    if (scratch !== null) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Each doc mention of a path or MCP tool base..commit removes, or why the check could not run. */
export async function staleDocRefs(repo: string, base: string, commit: string, env: NodeJS.ProcessEnv): Promise<string[] | string> {
  const removed = await removedInDiff(repo, base, commit, env);
  if (typeof removed === 'string') return removed;
  if (removed.paths.length === 0 && removed.tools.length === 0) return [];
  const blobs = await treeBlobs(repo, commit, env);
  if (!blobs) return `git ls-tree of ${commit} failed`;
  const ignored = await ignoredByTree(repo, blobs, removed.paths, env);
  if (ignored) removed.paths = removed.paths.filter((p) => !ignored.has(p));
  if (removed.paths.length === 0 && removed.tools.length === 0) return [];
  const docs = [...blobs].filter(([p]) => DOC_PATH.test(p)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const contents = await readBlobs(repo, docs.map(([, oid]) => oid), env);
  if (!contents) return 'git cat-file of the docs failed';
  const tools = removed.tools.map((t) => ({ t, re: toolPattern(t) }));
  const paths = removed.paths.map((p) => ({ p, re: pathPattern(p) }));
  const hits: string[] = [];
  for (const [doc, oid] of docs) {
    const text = contents.get(oid) ?? '';
    const dir = dirOf(doc);
    for (const { p, re } of paths) {
      const local = dir !== '' && p.startsWith(`${dir}/`) ? pathPattern(p.slice(dir.length + 1)) : null;
      if (re.test(text) || local?.test(text)) hits.push(`${doc} mentions removed path '${p}'`);
    }
    for (const { t, re } of tools) {
      if (re.test(text)) hits.push(`${doc} mentions removed MCP tool '${t}'`);
    }
  }
  return hits;
}

async function hasChangelogDir(repo: string, rev: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const r = await git(repo, ['ls-tree', '-d', '--name-only', rev, '--', CHANGELOG_DIR], env);
  return r.code === 0 && r.stdout.trim() !== '';
}

/** Why base..commit misses its changelog.d/ fragment, or null when it adds one or neither side has changelog.d/. */
export async function missingChangelog(repo: string, base: string, commit: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (!(await hasChangelogDir(repo, commit, env)) && !(await hasChangelogDir(repo, base, env))) return null;
  const added = await git(repo, ['diff', '--no-ext-diff', '--name-only', '--no-renames', '--diff-filter=A', base, commit, '--', `${CHANGELOG_DIR}/`], env);
  if (added.code !== 0) return `git diff failed: ${added.stderr.trim()}`;
  return added.stdout.trim() === '' ? `no file added under ${CHANGELOG_DIR}/` : null;
}

export function staleDocRefExpected(base: string, commit: string): string {
  return `no agents/, skills/, docs/ *.md, CLAUDE.md or README.md at ${commit} mentions a path or MCP tool that ${base}..${commit} removes`;
}

export function missingChangelogExpected(base: string, commit: string): string {
  return `${base}..${commit} adds a file under ${CHANGELOG_DIR}/`;
}

export interface BuiltinLintResult {
  name: typeof MISSING_CHANGELOG | typeof STALE_DOC_REF;
  exitCode: 0 | 1;
  output: string;
}

/** missing_changelog then stale_doc_ref on base..commit, each exit 0, or 1 with what it expected and what it found. */
export async function builtinLints(repo: string, base: string, commit: string, env: NodeJS.ProcessEnv): Promise<BuiltinLintResult[]> {
  const changelog = await missingChangelog(repo, base, commit, env);
  const stale = await staleDocRefs(repo, base, commit, env);
  const failed = (expected: string, actual: string): string => `expected: ${expected}\nactual: ${actual}`;
  return [
    changelog === null
      ? { name: MISSING_CHANGELOG, exitCode: 0, output: '' }
      : { name: MISSING_CHANGELOG, exitCode: 1, output: failed(missingChangelogExpected(base, commit), changelog) },
    typeof stale !== 'string' && stale.length === 0
      ? { name: STALE_DOC_REF, exitCode: 0, output: '' }
      : { name: STALE_DOC_REF, exitCode: 1, output: failed(staleDocRefExpected(base, commit), typeof stale === 'string' ? stale : stale.join('\n')) },
  ];
}
