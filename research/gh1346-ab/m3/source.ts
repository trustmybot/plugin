import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, WORK_DIR } from '../lib/paths.ts';

export const SOURCE_REV = process.env['GH1346_SOURCE_REV'] ?? 'b1dee644';

/** A clean tree at a fixed commit, so agents cannot grep this harness's own answer key under research/. */
export function exportSource(): string {
  const dst = join(WORK_DIR, `plugin-src-${SOURCE_REV}`);
  if (existsSync(join(dst, 'package.json'))) return dst;
  mkdirSync(dst, { recursive: true });
  const archive = spawnSync('git', ['-C', REPO_ROOT, 'archive', '--format=tar', SOURCE_REV], { maxBuffer: 1 << 30 });
  if (archive.status !== 0) throw new Error(`git archive: ${archive.stderr}`);
  const untar = spawnSync('tar', ['-x', '-C', dst], { input: archive.stdout });
  if (untar.status !== 0) throw new Error(`tar: ${untar.stderr}`);
  return dst;
}
