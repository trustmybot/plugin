/**
 * The changelog and stale-doc checks of a commit against its merge base with the
 * PR target (GH 2866), which swe-verification-gate runs before a swe completion:
 *
 *   stale_doc_ref      no path the diff (merge-base..commit) deletes or renames, and no MCP
 *                      tool name it drops from mcp/<server>/src/tools/, appears in the
 *                      agents/, skills/, docs/ *.md, CLAUDE.md or README.md at the commit;
 *                      a removed path the commit's own .gitignore files ignore is untracked
 *                      build output, not removed (GH 2054)
 *   missing_changelog  with a changelog.d/, the diff adds a file under it
 *
 * A git failure fails the check it was proving.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitSpawn } from './git.js';

export type DocCheck = 'stale_doc_ref' | 'missing_changelog';

export interface DocCheckFailure {
  check: DocCheck;
  expected: string | null;
  actual: string | null;
}

const GIT_TIMEOUT_MS = 10_000;
const MAX_LISTED = 10;
const DOC_PATH = /^(?:(?:agents|skills|docs)\/.*\.md|CLAUDE\.md|README\.md)$/;
const TOOL_SOURCE = /^mcp\/[^/]+\/src\/tools\/(?:[^/]+\/)*[^/]+\.ts$/;
const TOOL_NAME = /^\s*name:\s*['"]([a-z][a-z0-9]*(?:_[a-z0-9]+)+)['"]\s*,?\s*$/gm;
const CHANGELOG_DIR = 'changelog.d';
const GITIGNORE = /(?:^|\/)\.gitignore$/;
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE'];

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `git -C <repo> <args>` with no optional locks and a 10 s timeout, stderr kept for a deny's actual. */
export async function gitText(repo: string, args: string[], env: NodeJS.ProcessEnv): Promise<GitResult> {
  const r = await gitSpawn(repo, args, { env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, stderr: 'pipe', timeoutMs: GIT_TIMEOUT_MS });
  return { code: r.code, stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8') || (r.error?.message ?? '') };
}

export async function revParse(repo: string, rev: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const r = await gitText(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], env);
  const sha = r.stdout.trim();
  return r.code === 0 && sha !== '' ? sha : null;
}

export function nulFields(text: string): string[] {
  const fields = text.split('\0');
  if (fields.at(-1) === '') fields.pop();
  return fields;
}

export function listed(items: readonly string[]): string {
  const shown = items.slice(0, MAX_LISTED).join('; ');
  return items.length > MAX_LISTED ? `${shown}; (+${items.length - MAX_LISTED} more)` : shown;
}

/** Tracked blobs of <rev>: path → object id. */
async function treeBlobs(repo: string, rev: string, env: NodeJS.ProcessEnv): Promise<Map<string, string> | null> {
  const r = await gitText(repo, ['ls-tree', '-r', '-z', '--full-tree', rev], env);
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
  const diff = await gitText(repo, ['diff', '--no-ext-diff', '--name-status', '-z', '-M', base, commit], env);
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
    scratch = await mkdtemp(join(tmpdir(), 'tmb-doc-checks-ignore-'));
    for (const [path, oid] of rules) {
      await mkdir(dirname(join(scratch, path)), { recursive: true });
      await writeFile(join(scratch, path), contents.get(oid) ?? '');
    }
    if ((await gitText(scratch, ['init', '-q', '--template='], scratchEnv)).code !== 0) return null;
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

async function staleDocRefs(repo: string, base: string, commit: string, env: NodeJS.ProcessEnv): Promise<string[] | string> {
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

/** Whether <rev> has a changelog.d/; null when git cannot tell. */
async function hasChangelogDir(repo: string, rev: string, env: NodeJS.ProcessEnv): Promise<boolean | null> {
  const r = await gitText(repo, ['ls-tree', '-d', '--name-only', rev, '--', CHANGELOG_DIR], env);
  if (r.code !== 0) return null;
  return r.stdout.trim() !== '';
}

/** The first doc check <base>..<commit> fails in <repo>, or null when both pass. */
export async function docChecks(repo: string, base: string, commit: string, env: NodeJS.ProcessEnv): Promise<DocCheckFailure | null> {
  const stale = await staleDocRefs(repo, base, commit, env);
  if (typeof stale === 'string' || stale.length > 0) {
    return {
      check: 'stale_doc_ref',
      expected: `no agents/, skills/, docs/ *.md, CLAUDE.md or README.md at ${commit} mentions a path or MCP tool that ${base}..${commit} removes`,
      actual: typeof stale === 'string' ? stale : listed(stale),
    };
  }

  const atCommit = await hasChangelogDir(repo, commit, env);
  const atBase = await hasChangelogDir(repo, base, env);
  if (atCommit === null || atBase === null) {
    return {
      check: 'missing_changelog',
      expected: `${base}..${commit} adds a file under ${CHANGELOG_DIR}/`,
      actual: `git ls-tree of ${base} or ${commit} failed`,
    };
  }
  if (!atCommit && !atBase) return null;
  const added = await gitText(repo, ['diff', '--no-ext-diff', '--name-only', '--no-renames', '--diff-filter=A', base, commit, '--', `${CHANGELOG_DIR}/`], env);
  if (added.code !== 0 || added.stdout.trim() === '') {
    return {
      check: 'missing_changelog',
      expected: `${base}..${commit} adds a file under ${CHANGELOG_DIR}/`,
      actual: added.code !== 0 ? `git diff failed: ${added.stderr.trim()}` : `no file added under ${CHANGELOG_DIR}/`,
    };
  }
  return null;
}
