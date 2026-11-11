// Untracked node_modules installs never reach a fresh git worktree (GH 1541,
// GH 1853): link the main checkout's install, entry by entry, beside each
// tracked package.json.
// Shared by the environment gate (tools/env-gate.ts) and cli.js integrate; standalone it runs as
// `node dist/utils/worktree-deps.js <repoRoot> <worktreePath>`.
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUBPROCESS_TIMEOUT_MS } from './timeouts.js';

export interface WorktreeDepsResult {
  linked: string[];
  skipped: { dir: string; reason: string }[];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pathPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function trackedPackageDirs(worktreePath: string): string[] {
  const out = execFileSync('git', ['-C', worktreePath, 'ls-files', '-z', '--', 'package.json', '*/package.json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: SUBPROCESS_TIMEOUT_MS,
  }).toString();
  return [...new Set(out.split('\0').filter(Boolean).map((p) => dirname(p)))];
}

export function linkWorktreeNodeModules(repoRoot: string, worktreePath: string): WorktreeDepsResult {
  const result: WorktreeDepsResult = { linked: [], skipped: [] };
  let dirs: string[];
  try {
    dirs = trackedPackageDirs(worktreePath);
  } catch (error) {
    result.skipped.push({ dir: '.', reason: `git ls-files failed: ${(error as Error).message}` });
    return result;
  }
  for (const dir of dirs) {
    const src = join(repoRoot, dir, 'node_modules');
    const dest = join(worktreePath, dir, 'node_modules');
    if (!isDirectory(src)) {
      result.skipped.push({ dir, reason: `no install at ${src}` });
      continue;
    }
    const migrate = isWholeDirLinkTo(dest, src);
    if (!migrate && pathPresent(dest)) {
      result.skipped.push({ dir, reason: `${dest} already exists` });
      continue;
    }
    try {
      if (migrate) unlinkSync(dest);
      linkEachEntry(src, dest);
      result.linked.push(dir);
    } catch (error) {
      result.skipped.push({ dir, reason: `could not link ${src}: ${(error as Error).message}` });
    }
  }
  return result;
}

// Older builds linked the whole node_modules dir; `npm ci` in the worktree then
// emptied the main install through that link (GH 2872).
function isWholeDirLinkTo(dest: string, src: string): boolean {
  try {
    return lstatSync(dest).isSymbolicLink() && realpathSync(dest) === realpathSync(src);
  } catch {
    return false;
  }
}

// npm rewrites its hidden lockfile after every install; a link would let a
// worktree install overwrite the main checkout's copy.
const NPM_REGENERATED_ENTRIES = new Set(['.package-lock.json']);

// npm adds, renames and removes entries inside .bin and @scope dirs in place, so
// a whole-dir link would let a worktree install rewrite the main install.
function isWrittenInPlace(name: string): boolean {
  return name === '.bin' || name.startsWith('@');
}

// A real dir of per-entry links: removing it, as `npm ci` does, removes only links.
// A partial dir would read as `already exists` forever, so a failure removes it.
function linkEachEntry(src: string, dest: string): void {
  mkdirSync(dest);
  try {
    for (const name of readdirSync(src)) {
      if (NPM_REGENERATED_ENTRIES.has(name)) continue;
      const entrySrc = join(src, name);
      const entryDest = join(dest, name);
      if (isWrittenInPlace(name) && isDirectory(entrySrc)) linkChildren(entrySrc, entryDest);
      else symlinkSync(entrySrc, entryDest);
    }
  } catch (error) {
    rmSync(dest, { recursive: true, force: true });
    throw error;
  }
}

function linkChildren(src: string, dest: string): void {
  mkdirSync(dest);
  for (const name of readdirSync(src)) symlinkSync(join(src, name), join(dest, name));
}

// The basename check keeps the guard off inside esbuild bundles (dist/index.js,
// dist/hooks.js), where import.meta.url is the bundle's own entry point. The ESM
// loader realpaths import.meta.url but argv[1] keeps symlinks, so both sides are
// compared as real paths.
function isMainModule(): boolean {
  const entry = process.argv[1];
  const self = fileURLToPath(import.meta.url);
  if (entry === undefined || basename(self) !== 'worktree-deps.js') return false;
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const [repoRoot, worktreePath] = process.argv.slice(2);
  if (!repoRoot || !worktreePath) {
    process.stderr.write('usage: node worktree-deps.js <repoRoot> <worktreePath>\n');
  } else {
    for (const s of linkWorktreeNodeModules(repoRoot, worktreePath).skipped) {
      process.stderr.write(`worktree-deps: ${s.dir}: ${s.reason}\n`);
    }
  }
  process.exit(0);
}
