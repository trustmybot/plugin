// README drift for the world model (GH 1680): how many commits a directory has
// taken since its README last changed, and which paths the README names that
// git has since deleted. Every git call is bounded; any failure yields null so
// the scan stores NULL instead of failing.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { SUBPROCESS_TIMEOUT_MS } from './utils/timeouts.js';

export interface ReadmeDrift {
  summary_sha: string;
  commits_behind: number;
  dead_refs: string[];
}

export interface RepoHistory {
  root: string;
  deleted: Set<string>;
  deletedByBasename: Map<string, string[]>;
  trackedBasenames: Set<string>;
  trackedDirs: Set<string>;
}

const HISTORY_TIMEOUT_MS = 30_000;
const HISTORY_MAX_BUFFER = 64 * 1024 * 1024;

function git(root: string, args: string[], timeout = SUBPROCESS_TIMEOUT_MS): string | null {
  try {
    const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout, maxBuffer: HISTORY_MAX_BUFFER });
    return r.status === 0 && !r.error ? r.stdout : null;
  } catch {
    return null;
  }
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function lines(out: string): string[] {
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// One `git log --diff-filter=D` per repo per scan for every path ever deleted,
// and one `git ls-files` for the basenames tracked today.
export function readRepoHistory(root: string, trackedDirs: Set<string>): RepoHistory | null {
  const out = git(root, ['log', '--diff-filter=D', '--name-only', '--format='], HISTORY_TIMEOUT_MS);
  if (out === null) return null;
  const tracked = git(root, ['-c', 'core.quotePath=false', 'ls-files'], HISTORY_TIMEOUT_MS);
  if (tracked === null) return null;
  const deleted = new Set(lines(out));
  const trackedBasenames = new Set(lines(tracked).map(basename));
  const deletedByBasename = new Map<string, string[]>();
  for (const p of [...deleted].sort()) {
    const name = basename(p);
    const list = deletedByBasename.get(name);
    if (list) list.push(p);
    else deletedByBasename.set(name, [p]);
  }
  return { root, deleted, deletedByBasename, trackedBasenames, trackedDirs };
}

function stripUntrustedFraming(text: string): string {
  return text.replace(/<\/?untrusted-content\b[^>]*>/g, '');
}

const LINK_TARGET = /!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const BACKTICK_SPAN = /(?<!`)`([^`\n]+)`(?!`)/g;
const PATH_SHAPE = /^[A-Za-z0-9_.\-/@+]+$/;
const FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

interface Candidate {
  ref: string;
  link: boolean;
}

function skipped(ref: string): boolean {
  return (
    ref.length === 0 ||
    ref.startsWith('..') ||
    /(^|\/)dist\//.test(ref) ||
    ref.includes('${') ||
    ref.includes('<') ||
    ref.includes('*')
  );
}

function linkCandidate(target: string): string | null {
  if (URL_SCHEME.test(target) || target.startsWith('#')) return null;
  const path = target.replace(/[?#].*$/, '').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  return path.length > 0 ? path : null;
}

function backtickCandidate(span: string, dir: string, trackedDirs: Set<string>): string | null {
  const ref = span.trim().replace(/:\d+(-\d+)?$/, '').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!PATH_SHAPE.test(ref) || ref.startsWith('/') || ref.includes('://')) return null;
  const slash = ref.indexOf('/');
  if (slash < 0) return FILE_EXTENSION.test(ref) ? ref : null;
  const first = ref.slice(0, slash);
  const tracked = trackedDirs.has(first) || (dir !== '' && trackedDirs.has(`${dir}/${first}`));
  return tracked ? ref : null;
}

export function readmeCandidates(readme: string, dir: string, trackedDirs: Set<string>): Candidate[] {
  const text = stripUntrustedFraming(readme);
  const seen = new Map<string, Candidate>();
  for (const m of text.matchAll(LINK_TARGET)) {
    const ref = linkCandidate(m[1]!);
    if (ref && !skipped(ref)) seen.set(ref, { ref, link: true });
  }
  for (const m of text.matchAll(BACKTICK_SPAN)) {
    const ref = backtickCandidate(m[1]!, dir, trackedDirs);
    if (ref && !skipped(ref) && !seen.has(ref)) seen.set(ref, { ref, link: false });
  }
  return [...seen.values()];
}

function relativeToDir(dir: string, ref: string): string {
  return dir === '' ? posix.normalize(ref) : posix.normalize(`${dir}/${ref}`);
}

// A candidate is dead when it exists neither relative to the README's dir nor
// to the repo root, and it is a markdown link or git deleted it: a ref with a
// `/` must match a deleted path exactly; a bare filename matches a deleted
// basename only when no file tracked today has that basename. Reported as the
// repo-relative path git deleted when there is one, else the README-relative
// resolution.
function deletedBareName(ref: string, history: RepoHistory): string | undefined {
  if (ref.includes('/') || history.trackedBasenames.has(ref)) return undefined;
  return history.deletedByBasename.get(ref)?.[0];
}

export function deadRefs(readme: string, dir: string, history: RepoHistory): string[] {
  const dead = new Set<string>();
  for (const { ref, link } of readmeCandidates(readme, dir, history.trackedDirs)) {
    const fromDir = relativeToDir(dir, ref);
    if (existsSync(join(history.root, fromDir)) || existsSync(join(history.root, ref))) continue;
    const deletedHit = history.deleted.has(fromDir)
      ? fromDir
      : history.deleted.has(ref)
        ? ref
        : deletedBareName(ref, history);
    if (deletedHit) dead.add(deletedHit);
    else if (link) dead.add(fromDir);
  }
  return [...dead].sort();
}

// summary_sha: the last commit touching the README. commits_behind: commits
// since then touching the directory outside the README.
export function readmeDrift(
  history: RepoHistory,
  dir: string,
  readmeName: string,
  readme: string,
): ReadmeDrift | null {
  const readmePath = dir === '' ? readmeName : `${dir}/${readmeName}`;
  const sha = git(history.root, ['log', '-1', '--format=%H', '--', `:(literal)${readmePath}`])?.trim();
  if (!sha) return null;
  const dirSpec = dir === '' ? ':(literal).' : `:(literal)${dir}`;
  const count = git(history.root, [
    'rev-list',
    '--count',
    `${sha}..HEAD`,
    '--',
    dirSpec,
    `:(exclude,literal)${readmePath}`,
  ]);
  const commits_behind = count === null ? NaN : Number.parseInt(count.trim(), 10);
  if (!Number.isFinite(commits_behind)) return null;
  return { summary_sha: sha, commits_behind, dead_refs: deadRefs(readme, dir, history) };
}
