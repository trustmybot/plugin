// Rebuilds every generated artefact from its sources, in dependency order:
//   1. npm run build (mcp/trajectory-server)  → dist/**, scripts/hooks/lib/audit-events.txt
//   2. gen-enums-doc.mjs --doc                → the generated section of docs/contributing/ENUMS.md
//   3. emit-data-contracts.mjs                → scripts/hooks/lib/data-contracts.json
//   4. gen-erd-doc.mjs, gen-config-keys-doc.mjs (when present)
//   5. bun run build (dashboard)               → dashboard/dist/** (bundles trajectory-server sources)
//
// Usage: node --experimental-strip-types scripts/maintenance/regen-generated.ts [--check]
//
// Run it after a merge or rebase the tmb-regen merge driver resolved (it keeps
// ours for the generated files), then commit what changed.
// --check rebuilds, lists every file whose regenerated content differs from the
// checked-out one (the committed one on a clean tree), puts the checked-out
// content back and exits 1 when any differ.
// Exit 2: usage error or the build toolchain is missing (run
// `bun install --frozen-lockfile` at the plugin root and in dashboard/).

import { spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER = join(ROOT, 'mcp/trajectory-server');
const DASHBOARD = join(ROOT, 'dashboard');
const INSTALL_HINT = "run 'bun install --frozen-lockfile' at the plugin root and in dashboard/ first";
const SELF = 'node --experimental-strip-types scripts/maintenance/regen-generated.ts';

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function git(args: string[], input?: string): { status: number; stdout: string } {
  const r = spawnSync('git', args, { cwd: ROOT, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] });
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
}

function pathList(text: string): string[] {
  return text.split('\n').filter((p) => p !== '');
}

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

function untracked(): string[] {
  return pathList(git(['ls-files', '--others', '--exclude-standard']).stdout).sort(byteOrder);
}

const arg = process.argv[2] ?? '';
if (arg !== '' && arg !== '--check') {
  process.stderr.write(`Usage: ${process.argv[1] ?? 'regen-generated.ts'} [--check]\n`);
  process.exit(2);
}
const check = arg === '--check';
process.chdir(ROOT);

if (!executable(join(SERVER, 'node_modules/.bin/tsc')) || !executable(join(SERVER, 'node_modules/.bin/esbuild'))) {
  process.stderr.write(`regen-generated: tsc/esbuild not installed in mcp/trajectory-server — ${INSTALL_HINT}\n`);
  process.exit(2);
}
if (!executable(join(DASHBOARD, 'node_modules/.bin/esbuild')) || !executable(join(DASHBOARD, 'node_modules/.bin/tailwindcss'))) {
  process.stderr.write(`regen-generated: esbuild/tailwindcss not installed in dashboard — ${INSTALL_HINT}\n`);
  process.exit(2);
}

const logDir = mkdtempSync(join(tmpdir(), 'tmb-regen-'));
const LOG = join(logDir, 'log');
const untrackedBefore = new Set(untracked());
const stash = git(['stash', 'create']);
const baseline = stash.status === 0 && stash.stdout.trim() !== '' ? stash.stdout.trim() : git(['rev-parse', 'HEAD']).stdout.trim();

const newUntracked = (): string[] => untracked().filter((p) => !untrackedBefore.has(p));
const changedTracked = (): string[] => pathList(git(['diff', '--name-only', baseline]).stdout);

function changedPaths(): string[] {
  return [...new Set([...changedTracked(), ...newUntracked()])].sort(byteOrder);
}

function restore(): void {
  const tracked = changedTracked();
  const created = newUntracked();
  if (tracked.length > 0 && git(['restore', `--source=${baseline}`, '--worktree', '--pathspec-from-file=-'], `${tracked.join('\n')}\n`).status !== 0) {
    process.stderr.write("regen-generated: could not restore the checked-out files — inspect 'git status'\n");
  }
  for (const p of created) rmSync(join(ROOT, p), { force: true });
}

function finish(code: number): never {
  if (check) restore();
  rmSync(logDir, { recursive: true, force: true });
  process.exit(code);
}

process.on('SIGINT', () => finish(130));
process.on('SIGTERM', () => finish(143));

function run(label: string, cmd: string, args: string[], cwd: string = ROOT): void {
  const fd = openSync(LOG, 'a');
  const r = spawnSync(cmd, args, { cwd, stdio: ['inherit', fd, fd] });
  closeSync(fd);
  if (r.status !== 0) {
    const tail = readFileSync(LOG, 'utf8').split('\n');
    if (tail[tail.length - 1] === '') tail.pop();
    process.stderr.write(`regen-generated: ${label} failed:\n${tail.slice(-40).map((l) => `${l}\n`).join('')}`);
    finish(1);
  }
  if (!check) process.stdout.write(`  ✓ ${label}\n`);
}

run('npm run build', 'npm', ['run', 'build'], SERVER);
run('gen-enums-doc.mjs --doc', 'node', ['scripts/maintenance/gen-enums-doc.mjs', '--doc']);
run('emit-data-contracts.mjs', 'node', ['scripts/maintenance/emit-data-contracts.mjs']);
for (const gen of ['gen-erd-doc.mjs', 'gen-config-keys-doc.mjs']) {
  if (existsSync(join(ROOT, 'scripts/maintenance', gen))) run(gen, 'node', [`scripts/maintenance/${gen}`]);
}
run('bun run build (dashboard)', 'bun', ['run', 'build'], DASHBOARD);

const stale = changedPaths();
const listing = stale.map((p) => `  ${p}\n`).join('');
if (check) {
  if (stale.length > 0) {
    process.stderr.write(`regen-generated: stale generated file(s) — run: ${SELF}\n${listing}`);
    finish(1);
  }
  process.stdout.write('regen-generated: every generated file is current\n');
  finish(0);
}
process.stdout.write(stale.length > 0 ? `regen-generated: regenerated — review and commit:\n${listing}` : 'regen-generated: nothing changed\n');
finish(0);
