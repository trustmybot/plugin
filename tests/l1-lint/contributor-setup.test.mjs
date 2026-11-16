// L1 lint: contributor setup stays wired (GH 3151, GH 3146) — package.json pins the Bun of .bun-version, worktree setup installs missing deps before build:payload, and install-deps.ts installs only the lockfile roots with no node_modules.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALL_SCRIPT = 'scripts/maintenance/install-deps.ts';
const INSTALL_CMD = `node --experimental-strip-types ${INSTALL_SCRIPT}`;

function readJson(root, rel) {
  return JSON.parse(readFileSync(join(root, rel), 'utf8'));
}

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? m.slice(1).map(Number) : null;
}

function atLeast(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

// Returns the problems between package.json's Bun declarations and .bun-version, the one source of the version.
export function bunPinProblems(root) {
  const bunVersion = readFileSync(join(root, '.bun-version'), 'utf8').trim();
  const pkg = readJson(root, 'package.json');
  const problems = [];
  if (pkg.packageManager !== `bun@${bunVersion}`) {
    problems.push(`packageManager is ${JSON.stringify(pkg.packageManager)}, expected "bun@${bunVersion}" (.bun-version)`);
  }
  const range = pkg.engines?.bun;
  const floor = typeof range === 'string' && range.startsWith('>=') ? parseVersion(range.slice(2)) : null;
  const pinned = parseVersion(bunVersion);
  if (!floor) problems.push(`engines.bun is ${JSON.stringify(range)}, expected a ">=X.Y.Z" range`);
  else if (!pinned || !atLeast(pinned, floor)) problems.push(`engines.bun ${range} does not admit .bun-version ${bunVersion}`);
  return problems;
}

test('package.json pins the Bun version of .bun-version', () => {
  assert.deepEqual(bunPinProblems(ROOT), []);
});

test('bunPinProblems flags a packageManager that disagrees with .bun-version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contributor-setup-pin-'));
  try {
    writeFileSync(join(dir, '.bun-version'), '1.4.4\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ packageManager: 'bun@1.3.0', engines: { bun: '>=1.4.4' } }));
    assert.equal(bunPinProblems(dir).length, 1);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ packageManager: 'bun@1.4.4', engines: { bun: '>=1.5.0' } }));
    assert.equal(bunPinProblems(dir).length, 1);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ packageManager: 'bun@1.4.4', engines: { bun: '>=1.4.0' } }));
    assert.deepEqual(bunPinProblems(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setup runs the install script before build:payload', () => {
  const { commands } = readJson(ROOT, '.config/tmb/worktree-setup.json');
  const install = commands.indexOf(INSTALL_CMD);
  const build = commands.indexOf('bun run build:payload');
  assert.ok(install >= 0, `worktree-setup.json commands lack "${INSTALL_CMD}": ${JSON.stringify(commands)}`);
  assert.ok(build > install, `worktree-setup.json runs build:payload before the install script: ${JSON.stringify(commands)}`);
  assert.equal(readJson(ROOT, 'package.json').scripts.setup, `${INSTALL_CMD} && bun run build:payload`);
});

// A temp copy of the repo pieces install-deps.ts reads, plus a PATH dir with a stub bun that logs each call's cwd and args.
function sandbox({ rootModules, dashboardModules, withBun }) {
  const dir = mkdtempSync(join(tmpdir(), 'contributor-setup-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'scripts', 'maintenance'), { recursive: true });
  mkdirSync(join(repo, 'dashboard'));
  copyFileSync(join(ROOT, INSTALL_SCRIPT), join(repo, INSTALL_SCRIPT));
  copyFileSync(join(ROOT, '.bun-version'), join(repo, '.bun-version'));
  if (rootModules) mkdirSync(join(repo, 'node_modules'));
  if (dashboardModules) mkdirSync(join(repo, 'dashboard', 'node_modules'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'bun-calls.log');
  if (withBun) {
    const stub = join(bin, 'bun');
    writeFileSync(stub, `#!/bin/sh\necho "$PWD|$*" >> '${log}'\n`);
    chmodSync(stub, 0o755);
  }
  const run = () =>
    spawnSync(process.execPath, ['--experimental-strip-types', join(repo, INSTALL_SCRIPT)], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PATH: bin },
    });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  return { dir, repo, run, calls };
}

test('install-deps never calls bun when every root has node_modules', () => {
  const s = sandbox({ rootModules: true, dashboardModules: true, withBun: true });
  try {
    const r = s.run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(s.calls(), []);
    assert.match(r.stdout, /dashboard: node_modules present, skipped/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('install-deps installs only the root missing node_modules, in that root', () => {
  const s = sandbox({ rootModules: true, dashboardModules: false, withBun: true });
  try {
    const r = s.run();
    assert.equal(r.status, 0, r.stderr);
    const calls = s.calls();
    assert.equal(calls.length, 1, `expected one bun call, got ${JSON.stringify(calls)}`);
    const [cwd, args] = calls[0].split('|');
    assert.equal(cwd.replace(/^\/private/, ''), join(s.repo, 'dashboard').replace(/^\/private/, ''));
    assert.equal(args, 'install --frozen-lockfile');
    assert.match(r.stdout, /dashboard: installed/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('install-deps exits 127 naming Bun, its version and bun.sh when bun is not on PATH', () => {
  const s = sandbox({ rootModules: false, dashboardModules: false, withBun: false });
  try {
    const r = s.run();
    const version = readFileSync(join(ROOT, '.bun-version'), 'utf8').trim();
    assert.equal(r.status, 127);
    assert.ok(r.stderr.includes(`Bun ${version}`) && r.stderr.includes('https://bun.sh'), r.stderr);
    assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('install-deps exits non-zero when an install fails', () => {
  const s = sandbox({ rootModules: false, dashboardModules: true, withBun: true });
  try {
    writeFileSync(join(s.dir, 'bin', 'bun'), '#!/bin/sh\nexit 3\n');
    const r = s.run();
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /\.: bun install --frozen-lockfile --ignore-scripts failed/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});
