// L3: the tmb-regen merge driver (GH 1277, GH 1692): .gitattributes routes the
// generated artefacts to it, `node mcp/trajectory-server/dist/hooks.js
// install-merge-driver` puts it in the repo's .git/config, a merge where both
// sides changed dist/index.js completes with ours and no conflict markers
// (likewise dashboard/dist/web/app.js), and scripts/maintenance/regen-generated.ts
// --check then reports the file stale.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, appendFileSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-merge-driver-')));
after(() => rmSync(TMP, { recursive: true, force: true }));

const HOME = join(TMP, 'home');
mkdirSync(HOME);
const GIT_ENV = {
  ...process.env,
  HOME,
  npm_config_cache: join(HOME, '.npm'),
  GIT_CONFIG_GLOBAL: join(HOME, '.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t.io',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t.io',
};
writeFileSync(GIT_ENV.GIT_CONFIG_GLOBAL, '[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n');

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { env: GIT_ENV, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function git(cwd, ...args) {
  const r = run('git', ['-C', cwd, ...args]);
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const installDriver = (repo, ...args) => run(process.execPath, [join(repo, 'mcp/trajectory-server/dist/hooks.js'), 'install-merge-driver', ...args]);
const regen = (repo, ...args) => run(process.execPath, ['--experimental-strip-types', '--no-warnings', join(repo, 'scripts/maintenance/regen-generated.ts'), ...args]);

// A copy of this checkout (tracked + untracked, not ignored) as a fresh repo.
const REPO = join(TMP, 'repo');
mkdirSync(REPO);
const files = git(ROOT, 'ls-files', '-co', '--exclude-standard')
  .split('\n')
  .filter((p) => p !== '' && !p.startsWith('mcp/trajectory-server/node_modules') && existsSync(join(ROOT, p)));
const tarball = join(TMP, 'checkout.tar');
assert.equal(run('tar', ['-cf', tarball, '-T', '-'], { cwd: ROOT, input: `${files.join('\n')}\n` }).status, 0, 'tar the checkout');
assert.equal(run('tar', ['-xf', tarball, '-C', REPO]).status, 0, 'untar the checkout');
git(REPO, 'init', '-q', '-b', 'dev');
git(REPO, 'add', '-A');
git(REPO, 'commit', '-qm', 'base');
const DIST = 'mcp/trajectory-server/dist/index.js';
const DASH = 'dashboard/dist/web/app.js';

// With the toolchain, regenerate once here and commit, so the bundle's baked
// dependency paths match this location and only the merge makes a file stale.
const HAVE_TOOLCHAIN =
  executable(join(ROOT, 'mcp/trajectory-server/node_modules/.bin/tsc')) &&
  executable(join(ROOT, 'dashboard/node_modules/.bin/esbuild')) &&
  executable(join(ROOT, 'dashboard/node_modules/.bin/tailwindcss'));
if (HAVE_TOOLCHAIN) {
  symlinkSync(join(ROOT, 'mcp/trajectory-server/node_modules'), join(REPO, 'mcp/trajectory-server/node_modules'));
  symlinkSync(join(ROOT, 'dashboard/node_modules'), join(REPO, 'dashboard/node_modules'));
  appendFileSync(join(REPO, '.git/info/exclude'), 'mcp/trajectory-server/node_modules\ndashboard/node_modules\n');
  const r = regen(REPO);
  assert.equal(r.status, 0, `initial regen: ${r.stderr}`);
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-qm', 'regen at this location', '--allow-empty');
}

const sideCommit = (branch, base, path, line) => {
  git(REPO, 'checkout', '-q', '-b', branch, base);
  appendFileSync(join(REPO, path), `${line}\n`);
  git(REPO, 'commit', '-qam', branch);
};
sideCommit('side-a', 'dev', DIST, '// side a');
sideCommit('side-b', 'dev', DIST, '// side b');
sideCommit('dash-a', 'dev', DASH, '// dash a');
sideCommit('dash-b', 'dev', DASH, '// dash b');

const lastLine = (path) => readFileSync(join(REPO, path), 'utf8').replace(/\n$/, '').split('\n').pop();

test('.gitattributes routes the generated artefacts to tmb-regen', () => {
  for (const p of [DIST, 'mcp/trajectory-server/dist/tools/index.js', 'scripts/hooks/lib/audit-events.txt', 'scripts/hooks/lib/data-contracts.json', DASH, 'dashboard/dist/server.mjs']) {
    assert.match(git(REPO, 'check-attr', 'merge', '--', p), /merge: tmb-regen/, p);
  }
  assert.match(git(REPO, 'check-attr', 'merge', '--', 'docs/contributing/ENUMS.md'), /merge: unspecified/, 'ENUMS.md stays text-merged');
});

test('without the driver installed, both sides changing dist/index.js conflict', () => {
  git(REPO, 'checkout', '-q', '-b', 'control', 'side-a');
  const r = run('git', ['-C', REPO, 'merge', '-q', '--no-edit', 'side-b']);
  run('git', ['-C', REPO, 'merge', '--abort']);
  assert.notEqual(r.status, 0, 'expected a conflict without the driver');
});

test("install-merge-driver writes the driver into the repo's .git/config", () => {
  const r = installDriver(REPO, REPO);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `install-merge-driver: merge.tmb-regen installed in ${REPO}/.git/config\n`);
  const driver = git(REPO, 'config', '-f', join(REPO, '.git/config'), '--get', 'merge.tmb-regen.driver');
  assert.match(driver, /node --experimental-strip-types scripts\/maintenance\/regen-generated\.ts/, 'driver in .git/config');
  assert.equal(run('git', ['config', '--global', '--get', 'merge.tmb-regen.driver']).stdout, '', 'nothing global');
  assert.equal(installDriver(REPO, join(TMP, 'home')).status, 1, 'a non-repo dir exits 1');
});

test('with no argument, run from a worktree outside any repo cwd, it targets the main checkout', () => {
  const main = join(TMP, 'main');
  const outside = join(TMP, 'outside');
  mkdirSync(join(main, '.claude-plugin'), { recursive: true });
  mkdirSync(join(main, 'mcp/trajectory-server/dist'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(main, '.claude-plugin/plugin.json'), '{}\n');
  copyFileSync(join(ROOT, 'mcp/trajectory-server/dist/hooks.js'), join(main, 'mcp/trajectory-server/dist/hooks.js'));
  git(main, 'init', '-q', '-b', 'dev');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'base');
  const wt = join(main, '.claude/worktrees/feature');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
  const r = run(process.execPath, [join(wt, 'mcp/trajectory-server/dist/hooks.js'), 'install-merge-driver'], { cwd: outside });
  assert.equal(r.status, 0, r.stderr);
  assert.match(git(main, 'config', '-f', join(main, '.git/config'), '--get', 'merge.tmb-regen.driver'), /regen-generated\.ts/, "driver in the main checkout's common-dir config");
  assert.ok(r.stdout.includes(`${main}/.git/config`), "reports the main checkout's config");
  assert.deepEqual(readdirSync(outside), [], 'nothing written in the cwd');
});

test('with the driver, the merge completes with ours and no conflict markers', () => {
  git(REPO, 'checkout', '-q', 'side-a');
  const r = run('git', ['-C', REPO, 'merge', '--no-edit', 'side-b']);
  assert.equal(r.status, 0, `merge exits 0: ${r.stderr}`);
  assert.doesNotMatch(readFileSync(join(REPO, DIST), 'utf8'), /^(<<<<<<<|>>>>>>>)/m, `no conflict markers in ${DIST}`);
  assert.equal(lastLine(DIST), '// side a', 'ours kept');
  assert.ok(`${r.stdout}${r.stderr}`.includes(`tmb-regen: kept ours for ${DIST}`), 'driver names the file');
  assert.equal(git(REPO, 'status', '--porcelain', '--untracked-files=no'), '', 'merge committed cleanly');
});

test('with the driver, both sides changing dashboard/dist/web/app.js merge with ours and no conflict markers', () => {
  git(REPO, 'checkout', '-q', 'dash-a');
  const r = run('git', ['-C', REPO, 'merge', '--no-edit', 'dash-b']);
  assert.equal(r.status, 0, `merge exits 0: ${r.stderr}`);
  assert.doesNotMatch(readFileSync(join(REPO, DASH), 'utf8'), /^(<<<<<<<|>>>>>>>)/m, `no conflict markers in ${DASH}`);
  assert.equal(lastLine(DASH), '// dash a', 'ours kept');
  assert.ok(`${r.stdout}${r.stderr}`.includes(`tmb-regen: kept ours for ${DASH}`), 'driver names the file');
  assert.equal(git(REPO, 'status', '--porcelain', '--untracked-files=no'), '', 'merge committed cleanly');
  git(REPO, 'checkout', '-q', 'side-a');
});

test('regen-generated.ts --check reports the merged file stale; one regen makes it current', { skip: HAVE_TOOLCHAIN ? false : "build toolchain not installed — run 'bun install --frozen-lockfile' at the plugin root and in dashboard/ first" }, () => {
  const check = regen(REPO, '--check');
  assert.equal(check.status, 1, '--check exits 1');
  const stale = check.stderr.split('\n').filter((l) => l.startsWith('  ')).map((l) => l.slice(2));
  assert.deepEqual(stale, [DIST], 'exactly the merged file is stale');
  assert.equal(lastLine(DIST), '// side a', '--check leaves the checked-out file in place');
  const r = regen(REPO);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(readFileSync(join(REPO, DIST), 'utf8'), /^\/\/ side a$/m, 'regen drops the hand edit');
  git(REPO, 'commit', '-qam', 'regen after merge');
  const clean = regen(REPO, '--check');
  assert.equal(clean.status, 0, `after one regen, --check is clean: ${clean.stderr.slice(0, 500)}`);
  assert.equal(clean.stdout, 'regen-generated: every generated file is current\n');
});
