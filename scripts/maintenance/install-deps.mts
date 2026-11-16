// Installs the dependencies of each lockfile root (the repo root and dashboard/) that has no node_modules yet, so a fresh clone or worktree can build (GH 3151, GH 3146).
//
//   node --experimental-strip-types scripts/maintenance/install-deps.mts
//
// .mts, not .ts: the root package.json has no "type", so Node would print a module-type warning for a .ts file.
//
// A root that already has node_modules (installed, or linked from the main checkout by the
// env gate) is skipped. Uses only node: built-ins because it runs before any install.
// Exit 0: every root installed or skipped. Exit 127: bun is not on PATH (nothing installed).
// Otherwise: the exit code of the first install that failed.

import { spawnSync } from 'node:child_process';
import { accessSync, constants, lstatSync, readFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

// Matches .github/workflows/dev-build.yml: the root skips lifecycle scripts because build:payload builds afterwards.
const INSTALL_ROOTS: readonly { dir: string; args: string[] }[] = [
  { dir: '.', args: ['install', '--frozen-lockfile', '--ignore-scripts'] },
  { dir: 'dashboard', args: ['install', '--frozen-lockfile'] },
];
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

function hasEntry(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// Looks bun up on PATH without running it, so a run that installs nothing never calls bun.
function bunOnPath(): boolean {
  const names = process.platform === 'win32' ? ['bun.exe', 'bun.cmd', 'bun'] : ['bun'];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const name of names) {
      try {
        accessSync(join(dir, name), constants.X_OK);
        return true;
      } catch {
        // not in this PATH entry
      }
    }
  }
  return false;
}

function main(): number {
  if (!bunOnPath()) {
    const version = readFileSync(join(ROOT, '.bun-version'), 'utf8').trim();
    process.stderr.write(`install-deps: Bun ${version} is required but bun is not on PATH; install it from https://bun.sh\n`);
    return 127;
  }
  for (const { dir, args } of INSTALL_ROOTS) {
    const cwd = join(ROOT, dir);
    if (hasEntry(join(cwd, 'node_modules'))) {
      process.stdout.write(`install-deps: ${dir}: node_modules present, skipped\n`);
      continue;
    }
    process.stdout.write(`install-deps: ${dir}: installing (bun ${args.join(' ')})\n`);
    const r = spawnSync('bun', args, { cwd, stdio: 'inherit', timeout: INSTALL_TIMEOUT_MS });
    if (r.error || r.status !== 0) {
      process.stderr.write(`install-deps: ${dir}: bun ${args.join(' ')} failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status ?? r.signal})`}\n`);
      return r.status || 1;
    }
    process.stdout.write(`install-deps: ${dir}: installed\n`);
  }
  return 0;
}

process.exit(main());
