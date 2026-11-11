// Untracked node_modules installs never reach a fresh git worktree (GH 1541,
// GH 1853): link the main checkout's install, entry by entry, beside each
// tracked package.json. A worktree whose manifests differ from main's would
// build against an install that lacks its new deps (GH 3003), so each lockfile
// root whose manifests differ gets a frozen install of its own instead.
// Shared by the environment gate (tools/env-gate.ts), pr_monitor_worktree and cli.js integrate;
// standalone it runs as `node dist/utils/worktree-deps.js <repoRoot> <worktreePath>`.
import { execFileSync, spawn } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUBPROCESS_TIMEOUT_MS, WORKTREE_DEPS_INSTALL_TIMEOUT_MS } from './timeouts.js';

export interface WorktreeDepsResult {
  linked: string[];
  skipped: { dir: string; reason: string }[];
  installed?: { dir: string; command: string }[];
  install_error?: string;
}

/** Runs argv in cwd; rejects with a message carrying the failure and its output tail. */
export type InstallRunner = (argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<void>;

export interface PrepareWorktreeDepsOptions {
  env?: NodeJS.ProcessEnv;
  runInstall?: InstallRunner;
}

// Checked in this order; the first lockfile an install root holds picks the command.
const LOCKFILE_INSTALLS: readonly (readonly [string, readonly string[]])[] = [
  ['bun.lock', ['bun', 'install', '--frozen-lockfile']],
  ['bun.lockb', ['bun', 'install', '--frozen-lockfile']],
  ['package-lock.json', ['npm', 'ci']],
  ['npm-shrinkwrap.json', ['npm', 'ci']],
  ['pnpm-lock.yaml', ['pnpm', 'install', '--frozen-lockfile']],
  ['yarn.lock', ['yarn', 'install', '--frozen-lockfile']],
];

const INSTALL_TAIL_LINES = 20;
const INSTALL_OUTPUT_CAP = 64 * 1024;

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

function trackedFiles(worktreePath: string, names: readonly string[]): string[] {
  const pathspecs = names.flatMap((name) => [name, `*/${name}`]);
  const out = execFileSync('git', ['-C', worktreePath, 'ls-files', '-z', '--', ...pathspecs], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: SUBPROCESS_TIMEOUT_MS,
  }).toString();
  return out.split('\0').filter(Boolean);
}

function trackedPackageDirs(worktreePath: string): string[] {
  return [...new Set(trackedFiles(worktreePath, ['package.json']).map((p) => dirname(p)))];
}

const LOCKFILE_NAMES = LOCKFILE_INSTALLS.map(([lockfile]) => lockfile);

interface InstallRoot {
  dir: string;
  argv: readonly string[];
  members: string[];
}

function trackedInstallRoots(worktreePath: string): InstallRoot[] {
  const lockfiles = new Set(trackedFiles(worktreePath, LOCKFILE_NAMES));
  const dirs = [...new Set([...lockfiles].map((p) => dirname(p)))].sort();
  return dirs.map((dir) => {
    const [, argv] = LOCKFILE_INSTALLS.find(([lockfile]) => lockfiles.has(join(dir, lockfile)))!;
    return { dir, argv, members: [] };
  });
}

function nearestRoot(dir: string, rootsByDir: ReadonlyMap<string, InstallRoot>): InstallRoot | undefined {
  for (let at = dir; ; at = dirname(at)) {
    const root = rootsByDir.get(at);
    if (root !== undefined || at === '.') return root;
  }
}

export function linkWorktreeNodeModules(repoRoot: string, worktreePath: string): WorktreeDepsResult {
  let dirs: string[];
  try {
    dirs = trackedPackageDirs(worktreePath);
  } catch (error) {
    return gitListingFailed(error);
  }
  return linkPackageDirs(repoRoot, worktreePath, dirs);
}

/**
 * Each tracked dir holding a lockfile is an install root, owning the package
 * dirs whose nearest lockfile-holding ancestor (itself included) it is. A root
 * whose lockfiles or group's package.json files differ from main's gets a
 * frozen install and none of its group is linked: the install owns those dirs
 * (GH 2872). Every other group and every dir outside all groups is linked as
 * linkWorktreeNodeModules does. The first failed install stops the rest; never throws.
 */
export async function prepareWorktreeDeps(
  repoRoot: string,
  worktreePath: string,
  opts: PrepareWorktreeDepsOptions = {},
): Promise<WorktreeDepsResult> {
  let dirs: string[];
  let roots: InstallRoot[];
  try {
    dirs = trackedPackageDirs(worktreePath);
    roots = trackedInstallRoots(worktreePath);
  } catch (error) {
    return gitListingFailed(error);
  }
  const rootsByDir = new Map(roots.map((root) => [root.dir, root]));
  for (const dir of dirs) nearestRoot(dir, rootsByDir)?.members.push(dir);

  const installed: { dir: string; command: string }[] = [];
  const installOwned = new Set<string>();
  for (const root of roots) {
    if (manifestsMatch(repoRoot, worktreePath, root)) continue;
    const command = root.argv.join(' ');
    try {
      await (opts.runInstall ?? spawnInstall)(root.argv, join(worktreePath, root.dir), opts.env ?? process.env);
    } catch (error) {
      return {
        linked: [],
        skipped: [],
        ...(installed.length > 0 ? { installed } : {}),
        install_error: `frozen install failed in ${root.dir}: ${command}: ${(error as Error).message}`,
      };
    }
    installed.push({ dir: root.dir, command });
    for (const dir of root.members) installOwned.add(dir);
  }
  const result = linkPackageDirs(repoRoot, worktreePath, dirs.filter((dir) => !installOwned.has(dir)));
  return installed.length > 0 ? { ...result, installed } : result;
}

function gitListingFailed(error: unknown): WorktreeDepsResult {
  return { linked: [], skipped: [{ dir: '.', reason: `git ls-files failed: ${(error as Error).message}` }] };
}

function readOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function sameBytes(a: string, b: string): boolean {
  const left = readOrNull(a);
  const right = readOrNull(b);
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

function manifestsMatch(repoRoot: string, worktreePath: string, root: InstallRoot): boolean {
  const manifests = [
    ...LOCKFILE_NAMES.map((lockfile) => join(root.dir, lockfile)),
    ...root.members.map((dir) => join(dir, 'package.json')),
  ];
  return manifests.every((rel) => sameBytes(join(repoRoot, rel), join(worktreePath, rel)));
}

function outputTail(text: string): string {
  return text.replace(/\n+$/, '').split('\n').slice(-INSTALL_TAIL_LINES).join('\n');
}

function spawnInstall(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...env, PWD: cwd }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-INSTALL_OUTPUT_CAP);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, WORKTREE_DEPS_INSTALL_TIMEOUT_MS);
    child.on('error', (error) => settle(new Error(`could not start: ${error.message}`)));
    child.on('close', (code, signal) => {
      if (!timedOut && code === 0) return settle();
      const reason = timedOut
        ? `timed out after ${WORKTREE_DEPS_INSTALL_TIMEOUT_MS / 1000}s`
        : `exited ${code ?? `on ${signal}`}`;
      const tail = outputTail(output);
      settle(new Error(tail ? `${reason}\nOutput (last ${INSTALL_TAIL_LINES} lines):\n${tail}` : reason));
    });
  });
}

function linkPackageDirs(repoRoot: string, worktreePath: string, dirs: readonly string[]): WorktreeDepsResult {
  const result: WorktreeDepsResult = { linked: [], skipped: [] };
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
