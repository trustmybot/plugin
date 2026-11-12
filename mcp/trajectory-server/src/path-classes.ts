// GH 3074: a repo's .config/tmb/path-classes.json names its no-code path classes (docs, prompts),
// read at a ref; classifyPath and classifyChange sort changed paths by it, failing safe to code.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { matchesInput } from './hooks/lib/lint-fingerprint.js';
import { gitUnanswered, runGit } from './utils/git-run.js';

export const PATH_CLASSES_FILE = '.config/tmb/path-classes.json';

const FILE_SHAPE = '{"version":1,"docs":{"paths":[globs]},"prompts":{"paths":[globs],"rubric":[files]}}';

export interface PathClasses {
  docs: { paths: string[] } | null;
  prompts: { paths: string[]; rubric: string[] } | null;
}

export type PathClassesRead = { classes: PathClasses | null } | { error: string };

export type PathClass = 'docs' | 'prompts' | 'code';

export type ChangeClass = PathClass | 'mixed';

function gitFailure(res: { error?: Error; stderr?: string | null; status: number | null }): string {
  return res.error?.message.split('\n')[0] || (res.stderr ?? '').trim().split('\n')[0] || `git exited ${res.status}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((s) => typeof s === 'string' && s.trim() !== '');
}

function unknownKeys(obj: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(obj).filter((k) => !allowed.includes(k));
}

export function parsePathClasses(raw: string): PathClassesRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: `not valid JSON: ${(e as Error).message}` };
  }
  if (!isObject(parsed)) return { error: `must be a JSON object ${FILE_SHAPE}` };
  if (parsed['version'] !== 1) return { error: `version must be 1, got ${JSON.stringify(parsed['version']) ?? 'none'}` };
  const extra = unknownKeys(parsed, ['version', 'docs', 'prompts']);
  if (extra.length > 0) return { error: `unknown key ${extra.join(', ')}; the format is ${FILE_SHAPE}` };
  const { docs, prompts } = parsed;
  if (docs !== undefined && (!isObject(docs) || unknownKeys(docs, ['paths']).length > 0 || !isStringList(docs['paths']))) {
    return { error: 'docs must be {"paths":[globs]}, each glob a non-empty string' };
  }
  if (
    prompts !== undefined &&
    (!isObject(prompts) ||
      unknownKeys(prompts, ['paths', 'rubric']).length > 0 ||
      !isStringList(prompts['paths']) ||
      (prompts['rubric'] !== undefined && !isStringList(prompts['rubric'])))
  ) {
    return { error: 'prompts must be {"paths":[globs],"rubric":[files]}, each entry a non-empty string' };
  }
  return {
    classes: {
      docs: docs === undefined ? null : { paths: [...(docs['paths'] as string[])] },
      prompts:
        prompts === undefined
          ? null
          : { paths: [...(prompts['paths'] as string[])], rubric: [...((prompts['rubric'] as string[] | undefined) ?? [])] },
    },
  };
}

// The file as committed at `ref`; the working tree never counts. No repo, no
// ref or no file at a resolving ref means no classes: every path is code.
export function readPathClasses(repoPath: string | null, ref: string | null): PathClassesRead {
  if (!repoPath || !ref) return { classes: null };
  const shown = runGit(repoPath, ['show', `${ref}:${PATH_CLASSES_FILE}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (gitUnanswered(shown)) return { error: `git show failed: ${gitFailure(shown)}` };
  if (shown.status === 0) return parsePathClasses(shown.stdout);
  const head = runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (gitUnanswered(head) || head.status !== 0) return { error: `git cannot resolve ${ref}: ${gitFailure(shown)}` };
  return { classes: null };
}

// A path that is not plainly repo-relative (absolute, or climbing out with ..)
// never matches a class, so a guard fed an odd spelling still sees code.
function repoRelative(path: string): string | null {
  const normalized = posix.normalize(path);
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

export function classifyPath(path: string, classes: PathClasses | null): PathClass {
  const rel = repoRelative(path);
  if (classes === null || rel === null || rel === PATH_CLASSES_FILE) return 'code';
  const { docs, prompts } = classes;
  if (prompts && (prompts.rubric.includes(rel) || prompts.paths.some((glob) => matchesInput(rel, glob)))) return 'prompts';
  if (docs && docs.paths.some((glob) => matchesInput(rel, glob))) return 'docs';
  return 'code';
}

export function classifyChange(paths: readonly string[], classes: PathClasses | null): ChangeClass {
  if (paths.length === 0) return 'code';
  const seen = new Set(paths.map((path) => classifyPath(path, classes)));
  if (seen.has('code')) return seen.size === 1 ? 'code' : 'mixed';
  return seen.has('prompts') ? 'prompts' : 'docs';
}

export function hasPathClasses(classes: PathClasses): boolean {
  return classes.docs !== null || classes.prompts !== null;
}

const DOCS_DIRS = ['docs', 'doc', 'documentation'];
const ROOT_PROMPT_FILES = ['CLAUDE.md', 'AGENTS.md'];
const PROMPT_DIRS = ['agents', 'skills', 'commands'];
const PLUGIN_MANIFEST = '.claude-plugin/plugin.json';

// Onboarding's proposal from a repo's file list: only conventions some file
// in the list shows, and no rubric.
export function proposePathClasses(files: readonly string[]): PathClasses {
  const present = new Set(files);
  const holds = (dir: string, suffix = ''): boolean => files.some((f) => f.startsWith(`${dir}/`) && f.endsWith(suffix));
  const docs = DOCS_DIRS.filter((dir) => holds(dir, '.md')).map((dir) => `${dir}/**/*.md`);
  docs.push(...files.filter((f) => !f.includes('/') && f.endsWith('.md') && !ROOT_PROMPT_FILES.includes(f)));
  if (holds('changelog.d')) docs.push('changelog.d/**');
  const prompts = ROOT_PROMPT_FILES.filter((f) => present.has(f));
  if (files.some((f) => f.endsWith('/CLAUDE.md'))) prompts.push('**/CLAUDE.md');
  prompts.push(...PROMPT_DIRS.filter((dir) => holds(`.claude/${dir}`)).map((dir) => `.claude/${dir}/**/*.md`));
  if (present.has(PLUGIN_MANIFEST)) prompts.push(...PROMPT_DIRS.filter((dir) => holds(dir)).map((dir) => `${dir}/**/*.md`));
  return {
    docs: docs.length > 0 ? { paths: docs } : null,
    prompts: prompts.length > 0 ? { paths: prompts, rubric: [] } : null,
  };
}

export function proposePathClassesAt(repoPath: string, ref: string): { classes: PathClasses } | { error: string } {
  const listed = runGit(repoPath, ['ls-tree', '-r', '--full-tree', '--name-only', '-z', ref], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (gitUnanswered(listed) || listed.status !== 0) return { error: `git cannot list the files on ${ref}: ${gitFailure(listed)}` };
  return { classes: proposePathClasses(listed.stdout.split('\0').filter((f) => f !== '')) };
}

export function serializePathClasses(classes: PathClasses): string {
  const body: Record<string, unknown> = { version: 1 };
  if (classes.docs) body['docs'] = { paths: classes.docs.paths };
  if (classes.prompts) body['prompts'] = { paths: classes.prompts.paths, rubric: classes.prompts.rubric };
  return `${JSON.stringify(body, null, 2)}\n`;
}

const sameClasses = (a: PathClasses, b: PathClasses): boolean => serializePathClasses(a) === serializePathClasses(b);

export interface PathClassesWrite {
  repo: string;
  path: string;
  classes: PathClasses;
  written: boolean;
  refused: boolean;
  commit_needed: boolean;
  message: string;
}

// Writes the classes file into the repo's working tree, never over a file
// with other classes, and never commits: readers take it from `ref`.
export function writePathClasses(repo: string, repoPath: string, ref: string | null, classes: PathClasses): PathClassesWrite {
  const path = join(repoPath, PATH_CLASSES_FILE);
  let written = false;
  const result = (commit_needed: boolean, message: string, refused = false): PathClassesWrite => ({
    repo,
    path,
    classes,
    written,
    refused,
    commit_needed,
    message,
  });
  if (existsSync(path)) {
    const current = parsePathClasses(readFileSync(path, 'utf8'));
    if ('error' in current || current.classes === null || !sameClasses(current.classes, classes)) {
      return result(false, `${PATH_CLASSES_FILE} already exists with other content and was left unchanged; edit or remove it, then apply again.`, true);
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serializePathClasses(classes));
    written = true;
  }
  const atBase = ref === null ? null : readPathClasses(repoPath, ref);
  if (atBase !== null && !('error' in atBase) && atBase.classes !== null && sameClasses(atBase.classes, classes)) {
    return result(false, `${PATH_CLASSES_FILE} is already committed on ${ref}.`);
  }
  return result(true, `${PATH_CLASSES_FILE} takes effect once it is committed to the PR target${ref ? ` (${ref})` : ''}; the working tree copy is not read.`);
}
