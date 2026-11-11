/**
 * The changelog and stale-doc checks of a commit against its merge base with the
 * PR target (GH 2866), which swe-verification-gate runs before a swe completion.
 * Where they look is the project's own: DOC_CHECKS_FILE as committed at the
 * checked commit (the working tree never counts) names it.
 *
 *   stale_doc_ref      no path the diff (merge-base..commit) deletes or renames, and no tool
 *                      name it drops from a tool_sources file (group 1 of each
 *                      tool_name_pattern match), appears in a doc_paths file at the commit;
 *                      a removed path the commit's own .gitignore files ignore is untracked
 *                      build output, not removed (GH 2054)
 *   missing_changelog  with a changelog_dir at the base or the commit, the diff adds a file under it
 *
 * No file skips both checks, and an absent key skips its check (the tool-name half
 * needs both tool keys); each skip comes back as a note for the allow. An invalid
 * file fails as doc_checks_config, and a git failure fails the check it was proving.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob } from 'node:path';
import { gitSpawn } from './git.js';

export type DocCheck = 'stale_doc_ref' | 'missing_changelog' | 'doc_checks_config' | 'leak_scan' | 'leak_scan_config';

export interface DocCheckFailure {
  check: DocCheck;
  expected: string | null;
  actual: string | null;
}

export const DOC_CHECKS_FILE = '.config/tmb/doc-checks.json';
export const DOC_CHECKS_SHAPE =
  '{"version":1,"changelog_dir":"<dir>","doc_paths":["<glob>",...],"tool_sources":["<glob>",...],"tool_name_pattern":"<regex with one capture group>"}';
const CONFIG_KEYS = new Set(['version', 'changelog_dir', 'doc_paths', 'tool_sources', 'tool_name_pattern']);

export interface DocChecksConfig {
  changelogDir: string | null;
  docPaths: string[] | null;
  tools: ToolRule | null;
  skipped: string[];
}

interface ToolRule {
  sources: string[];
  name: RegExp;
}

export interface DocChecksResult {
  failure: DocCheckFailure | null;
  notes: string[];
}

const GIT_TIMEOUT_MS = 10_000;
const MAX_LISTED = 10;
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

function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchesGlob(path, glob));
}

function isGlobList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((g) => typeof g === 'string' && g.trim() !== '');
}

/** A repo-relative directory without trailing slashes, or null when <value> is none. */
function repoDir(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const dir = value.replace(/\/+$/, '');
  if (dir === '' || dir.startsWith('/') || dir.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
  return dir;
}

function captureGroups(pattern: string): number {
  return (new RegExp(`${pattern}|`).exec('') ?? []).length - 1;
}

function skipNote(check: string, keys: string): string {
  return `${check} skipped: ${DOC_CHECKS_FILE} sets no ${keys}.`;
}

/** The checks <text> configures, or why it is invalid. */
export function parseDocChecksConfig(text: string): DocChecksConfig | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { error: `not valid JSON: ${(e as Error).message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'not a JSON object' };
  const raw = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(raw).filter((k) => !CONFIG_KEYS.has(k));
  if (unknownKeys.length > 0) return { error: `unknown key(s) ${unknownKeys.join(', ')}` };
  if (raw.version !== 1) return { error: `version must be 1, got ${JSON.stringify(raw.version) ?? 'none'}` };

  const changelogDir = raw.changelog_dir === undefined ? null : repoDir(raw.changelog_dir);
  if (raw.changelog_dir !== undefined && changelogDir === null) {
    return { error: 'changelog_dir must be a repo-relative directory, without . or .. segments' };
  }
  for (const key of ['doc_paths', 'tool_sources'] as const) {
    if (raw[key] !== undefined && !isGlobList(raw[key])) return { error: `${key} must be a non-empty array of non-empty glob strings` };
  }
  let name: RegExp | null = null;
  const pattern = raw.tool_name_pattern;
  if (pattern !== undefined) {
    if (typeof pattern !== 'string' || pattern === '') return { error: 'tool_name_pattern must be a non-empty regex string' };
    try {
      name = new RegExp(pattern, 'gm');
    } catch (e) {
      return { error: `tool_name_pattern is not a valid regex: ${(e as Error).message}` };
    }
    const groups = captureGroups(pattern);
    if (groups !== 1) return { error: `tool_name_pattern must have exactly one capture group, has ${groups}` };
  }

  const docPaths = (raw.doc_paths as string[] | undefined) ?? null;
  const sources = (raw.tool_sources as string[] | undefined) ?? null;
  const skipped: string[] = [];
  if (changelogDir === null) skipped.push(skipNote('missing_changelog', '"changelog_dir"'));
  if (docPaths === null) {
    skipped.push(skipNote('stale_doc_ref', '"doc_paths"'));
  } else if (sources === null || name === null) {
    const missing = [sources === null ? '"tool_sources"' : '', name === null ? '"tool_name_pattern"' : ''].filter(Boolean).join(' or ');
    skipped.push(skipNote("stale_doc_ref's removed-tool-name half", missing));
  }
  const tools = sources !== null && name !== null ? { sources, name } : null;
  return { changelogDir, docPaths, tools, skipped };
}

/** DOC_CHECKS_FILE at <commit>: its config, null when the commit has none, or the failure that denies. */
async function readDocChecksConfig(
  repo: string,
  commit: string,
  env: NodeJS.ProcessEnv,
): Promise<{ config: DocChecksConfig | null } | { failure: DocCheckFailure }> {
  const invalid = (actual: string) => ({
    failure: { check: 'doc_checks_config' as const, expected: `${DOC_CHECKS_FILE} at ${commit} is absent or matches ${DOC_CHECKS_SHAPE}`, actual },
  });
  const file = await fileAtCommit(repo, commit, DOC_CHECKS_FILE, env);
  if ('error' in file) return invalid(file.error);
  if (file.text === null) return { config: null };
  const parsed = parseDocChecksConfig(file.text);
  return 'error' in parsed ? invalid(parsed.error) : { config: parsed };
}

/** The text of <path> as committed at <commit>, null when the commit has none, or why git could not read it. */
export async function fileAtCommit(
  repo: string,
  commit: string,
  path: string,
  env: NodeJS.ProcessEnv,
): Promise<{ text: string | null } | { error: string }> {
  const entry = await gitText(repo, ['ls-tree', '-z', commit, '--', path], env);
  if (entry.code !== 0) return { error: `git ls-tree failed: ${entry.stderr.trim()}` };
  const fields = nulFields(entry.stdout);
  if (fields.length === 0) return { text: null };
  const [, type, oid] = fields[0].slice(0, fields[0].indexOf('\t')).split(' ');
  if (type !== 'blob') return { error: `${path} is a ${type}, not a file` };
  const contents = await readBlobs(repo, [oid], env);
  const text = contents?.get(oid);
  if (text === undefined) return { error: `git cat-file of ${path} failed` };
  return { text };
}

function toolNames(blobs: Map<string, string>, contents: Map<string, string>, tools: ToolRule): Set<string> {
  const names = new Set<string>();
  for (const [path, oid] of blobs) {
    if (!matchesAny(path, tools.sources)) continue;
    for (const m of (contents.get(oid) ?? '').matchAll(tools.name)) {
      if (m[1] !== undefined && m[1] !== '') names.add(m[1]);
    }
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

async function removedInDiff(
  repo: string,
  base: string,
  commit: string,
  tools: ToolRule | null,
  env: NodeJS.ProcessEnv,
): Promise<Removed | string> {
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
    if (tools !== null && (matchesAny(from, tools.sources) || matchesAny(to, tools.sources))) touchesTools = true;
    if (status === 'D' || status.startsWith('R')) paths.push(from);
  }
  if (tools === null || !touchesTools) return { paths, tools: [] };
  const before = await treeBlobs(repo, base, env);
  const after = await treeBlobs(repo, commit, env);
  if (!before || !after) return `git ls-tree of ${base} or ${commit} failed`;
  const sources = (blobs: Map<string, string>) => [...blobs].filter(([p]) => matchesAny(p, tools.sources)).map(([, oid]) => oid);
  const contents = await readBlobs(repo, [...new Set([...sources(before), ...sources(after)])], env);
  if (!contents) return 'git cat-file of the tool sources failed';
  const kept = toolNames(after, contents, tools);
  return { paths, tools: [...toolNames(before, contents, tools)].filter((t) => !kept.has(t)).sort() };
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

async function staleDocRefs(
  repo: string,
  base: string,
  commit: string,
  docPaths: readonly string[],
  tools: ToolRule | null,
  env: NodeJS.ProcessEnv,
): Promise<string[] | string> {
  const removed = await removedInDiff(repo, base, commit, tools, env);
  if (typeof removed === 'string') return removed;
  if (removed.paths.length === 0 && removed.tools.length === 0) return [];
  const blobs = await treeBlobs(repo, commit, env);
  if (!blobs) return `git ls-tree of ${commit} failed`;
  const ignored = await ignoredByTree(repo, blobs, removed.paths, env);
  if (ignored) removed.paths = removed.paths.filter((p) => !ignored.has(p));
  if (removed.paths.length === 0 && removed.tools.length === 0) return [];
  const docs = [...blobs].filter(([p]) => matchesAny(p, docPaths)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const contents = await readBlobs(repo, docs.map(([, oid]) => oid), env);
  if (!contents) return 'git cat-file of the docs failed';
  const toolNamePatterns = removed.tools.map((t) => ({ t, re: toolPattern(t) }));
  const paths = removed.paths.map((p) => ({ p, re: pathPattern(p) }));
  const hits: string[] = [];
  for (const [doc, oid] of docs) {
    const text = contents.get(oid) ?? '';
    const dir = dirOf(doc);
    for (const { p, re } of paths) {
      const local = dir !== '' && p.startsWith(`${dir}/`) ? pathPattern(p.slice(dir.length + 1)) : null;
      if (re.test(text) || local?.test(text)) hits.push(`${doc} mentions removed path '${p}'`);
    }
    for (const { t, re } of toolNamePatterns) {
      if (re.test(text)) hits.push(`${doc} mentions removed tool '${t}'`);
    }
  }
  return hits;
}

/** Whether <rev> has the directory <dir>; null when git cannot tell. */
async function hasDir(repo: string, rev: string, dir: string, env: NodeJS.ProcessEnv): Promise<boolean | null> {
  const r = await gitText(repo, ['ls-tree', '-d', '--name-only', rev, '--', dir], env);
  if (r.code !== 0) return null;
  return r.stdout.trim() !== '';
}

async function missingChangelog(repo: string, base: string, commit: string, dir: string, env: NodeJS.ProcessEnv): Promise<DocCheckFailure | null> {
  const expected = `${base}..${commit} adds a file under ${dir}/`;
  const atCommit = await hasDir(repo, commit, dir, env);
  const atBase = await hasDir(repo, base, dir, env);
  if (atCommit === null || atBase === null) {
    return { check: 'missing_changelog', expected, actual: `git ls-tree of ${base} or ${commit} failed` };
  }
  if (!atCommit && !atBase) return null;
  const added = await gitText(
    repo,
    ['diff', '--no-ext-diff', '--name-only', '--no-renames', '--diff-filter=A', base, commit, '--', `:(literal)${dir}/`],
    env,
  );
  if (added.code !== 0 || added.stdout.trim() === '') {
    return {
      check: 'missing_changelog',
      expected,
      actual: added.code !== 0 ? `git diff failed: ${added.stderr.trim()}` : `no file added under ${dir}/`,
    };
  }
  return null;
}

/**
 * The first doc check <base>..<commit> fails in <repo> under DOC_CHECKS_FILE at <commit>,
 * else no failure and a note per check the file leaves unconfigured.
 */
export async function docChecks(repo: string, base: string, commit: string, env: NodeJS.ProcessEnv): Promise<DocChecksResult> {
  const read = await readDocChecksConfig(repo, commit, env);
  if ('failure' in read) return { failure: read.failure, notes: [] };
  const { config } = read;
  if (config === null) {
    return {
      failure: null,
      notes: [`missing_changelog and stale_doc_ref skipped: no ${DOC_CHECKS_FILE} at ${commit}; commit one shaped ${DOC_CHECKS_SHAPE} to run them.`],
    };
  }

  if (config.docPaths !== null) {
    const stale = await staleDocRefs(repo, base, commit, config.docPaths, config.tools, env);
    if (typeof stale === 'string' || stale.length > 0) {
      const what = config.tools === null ? 'a path' : 'a path or tool name';
      return {
        failure: {
          check: 'stale_doc_ref',
          expected: `no file matching ${config.docPaths.join(', ')} at ${commit} mentions ${what} that ${base}..${commit} removes`,
          actual: typeof stale === 'string' ? stale : listed(stale),
        },
        notes: [],
      };
    }
  }

  if (config.changelogDir !== null) {
    const failure = await missingChangelog(repo, base, commit, config.changelogDir, env);
    if (failure !== null) return { failure, notes: [] };
  }
  return { failure: null, notes: config.skipped };
}
