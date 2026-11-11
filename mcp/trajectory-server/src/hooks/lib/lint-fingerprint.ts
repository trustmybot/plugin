/**
 * The close-lint fingerprint (GH 2570): a sha256 over the (path, blob oid)
 * pairs `git ls-tree -r --full-tree` lists at a commit, kept to the paths a
 * repo's close-lints.json fingerprint_inputs globs match plus the config itself.
 * It reads git objects only, never the
 * worktree, so the gate that records a lint run and the reviewer preflight that checks it
 * compute the same value for the same commit.
 */
import { createHash } from 'node:crypto';
import { matchesGlob } from 'node:path';
import { gitRun } from './git.js';

export const CLOSE_LINTS_PATH = '.config/tmb/close-lints.json';

const DOT_MASK = '\u0001';

function maskDots(s: string): string {
  return s.replace(/(^|\/)\./g, `$1${DOT_MASK}`);
}

/**
 * path.matchesGlob, except that `*` and `**` also match a segment that starts
 * with a dot (matchesGlob alone skips them, F636-1): `**` matches
 * `.github/x.yml`. A leading dot the glob spells out still matches literally.
 */
export function matchesInput(path: string, glob: string): boolean {
  return matchesGlob(path, glob) || matchesGlob(maskDots(path), maskDots(glob));
}

/**
 * `v1:` + the sha256 hex of `<path>\0<oid>\n` for each matched blob at
 * <commitSha>, sorted by path; null when git fails or a glob cannot be applied.
 */
export async function lintFingerprint(
  repoPath: string,
  commitSha: string,
  inputs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (commitSha === '' || commitSha.startsWith('-')) return null;
  const r = await gitRun(repoPath, ['ls-tree', '-r', '--full-tree', '-z', commitSha], env);
  if (r.code !== 0) return null;
  const entries: Array<{ path: string; oid: string }> = [];
  try {
    for (const record of r.stdout.split('\0')) {
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const [, type, oid] = record.slice(0, tab).split(' ');
      const path = record.slice(tab + 1);
      if (type !== 'blob' || oid === undefined) continue;
      if (path === CLOSE_LINTS_PATH || inputs.some((glob) => matchesInput(path, glob))) entries.push({ path, oid });
    }
  } catch {
    return null;
  }
  return fingerprintDigest(entries);
}

/** The v1 digest of (path, oid) entries, sorted here by path. */
export function fingerprintDigest(entries: ReadonlyArray<{ path: string; oid: string }>): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash('sha256');
  for (const e of sorted) hash.update(`${e.path}\0${e.oid}\n`);
  return `v1:${hash.digest('hex')}`;
}
