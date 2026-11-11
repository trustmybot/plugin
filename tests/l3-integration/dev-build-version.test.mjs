// L3: dev-build versions (GH 1604, GH 1692): scripts/maintenance/dev-build-version.ts
// derives X.Y.Z-dev.<n>[.gh<PR>] from the highest stable tag, and
// bump-version.ts --version-only stamps it into the five version files without
// touching CHANGELOG.md or changelog.d/.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEVVER = join(ROOT, 'scripts/maintenance/dev-build-version.ts');
const TMP = mkdtempSync(join(tmpdir(), 'tmb-dev-build-version-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t.io',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t.io',
};
const TS = ['--experimental-strip-types', '--no-warnings'];

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env: GIT_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

// As in the real repo, the release tag sits on a main merge commit that dev
// never contains. main: init (v1.0.0). dev: feat/1, feat/2 (--no-ff). main
// merges dev, tagged v1.1.0. dev: feat/3, feat/4 (--no-ff), tagged v1.2.0-rc.1;
// dev never merges main back, so v1.0.0 is the only stable tag dev reaches.
const REPO = join(TMP, 'repo');
mkdirSync(REPO);
git(REPO, 'init', '-q', '-b', 'main');
writeFileSync(join(REPO, 'f.txt'), 'base\n');
git(REPO, 'add', 'f.txt');
git(REPO, 'commit', '-qm', 'init');
git(REPO, 'tag', 'v1.0.0');
git(REPO, 'checkout', '-q', '-b', 'dev');
const feature = (n) => {
  git(REPO, 'checkout', '-q', '-b', `feat/${n}`, 'dev');
  appendFileSync(join(REPO, 'f.txt'), `${n}\n`);
  git(REPO, 'commit', '-qam', `feat ${n}`);
  git(REPO, 'checkout', '-q', 'dev');
  git(REPO, 'merge', '-q', '--no-ff', '-m', `merge feat/${n}`, `feat/${n}`);
};
feature(1);
feature(2);
git(REPO, 'checkout', '-q', 'main');
git(REPO, 'merge', '-q', '--no-ff', '-m', 'release 1.1.0', 'dev');
git(REPO, 'tag', 'v1.1.0');
git(REPO, 'checkout', '-q', 'dev');
feature(3);
feature(4);
git(REPO, 'tag', 'v1.2.0-rc.1');

function devver(cwd, ...args) {
  return spawnSync(process.execPath, [...TS, DEVVER, ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
}

const version = (...args) => {
  const r = devver(REPO, ...args);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test("n counts dev's first-parent commits since the highest stable tag, which dev does not contain", () => {
  const ancestor = spawnSync('git', ['-C', REPO, 'merge-base', '--is-ancestor', 'v1.1.0', 'dev'], { env: GIT_ENV });
  assert.equal(ancestor.status, 1, 'fixture: v1.1.0 not on dev');
  assert.equal(version('--next', '1.2.0', '--pr', '1594'), '1.2.0-dev.2.gh1594\n', 'with --pr');
});

test('the rc tag is ignored', () => {
  assert.equal(version('--next', '1.1.1'), '1.1.1-dev.2\n', '--next 1.1.1 is above v1.1.0, not v1.2.0-rc.1');
});

test('without --pr there is no gh suffix', () => {
  assert.equal(version('--next', '1.2.0'), '1.2.0-dev.2\n');
});

test('--ref stamps an earlier commit', () => {
  assert.equal(version('--next', '1.2.0', '--ref', 'dev~1'), '1.2.0-dev.1\n');
});

test('--next at or below the latest release exits 1', () => {
  for (const next of ['1.1.0', '1.0.9', '0.9.0']) {
    const r = devver(REPO, '--next', next);
    assert.equal(r.status, 1, `--next ${next}`);
    assert.equal(r.stderr, `Error: --next '${next}' is not above the latest release v1.1.0\n`);
  }
});

test('with no stable tag n counts every first-parent commit', () => {
  const notag = join(TMP, 'notag');
  mkdirSync(notag);
  git(notag, 'init', '-q', '-b', 'main');
  git(notag, 'commit', '-q', '--allow-empty', '-m', 'one');
  git(notag, 'commit', '-q', '--allow-empty', '-m', 'two');
  const r = devver(notag, '--next', '0.1.0');
  assert.equal(r.stdout, '0.1.0-dev.2\n', r.stderr);
});

test('bad --next and --pr exit 1', () => {
  for (const args of [
    ['--next', '1.2'],
    ['--next', 'v1.2.0'],
    ['--next', '1.2.0-rc.1'],
    ['--next', '1.2.0', '--pr', 'abc'],
    ['--next', '1.2.0', '--pr', '#12'],
    ['--pr', '12'],
  ]) {
    assert.equal(devver(REPO, ...args).status, 1, args.join(' '));
  }
  assert.match(devver(REPO, '--next', '1.2.0', '--ref', 'nope').stderr, /Error: 'nope' is not a commit/, 'unknown --ref');
});

const VERSION_FILES = ['.claude-plugin/plugin.json', 'package.json', 'mcp/trajectory-server/package.json', 'bun.lock'];
const B = join(TMP, 'bump');
mkdirSync(join(B, 'scripts/maintenance/lib'), { recursive: true });
mkdirSync(join(B, 'changelog.d'));
for (const f of VERSION_FILES) {
  mkdirSync(dirname(join(B, f)), { recursive: true });
  copyFileSync(join(ROOT, f), join(B, f));
}
copyFileSync(join(ROOT, 'scripts/maintenance/bump-version.ts'), join(B, 'scripts/maintenance/bump-version.ts'));
copyFileSync(join(ROOT, 'scripts/maintenance/lib/changelog-fragments.ts'), join(B, 'scripts/maintenance/lib/changelog-fragments.ts'));
copyFileSync(join(ROOT, 'scripts/maintenance/lib/measured-impact.ts'), join(B, 'scripts/maintenance/lib/measured-impact.ts'));
writeFileSync(join(B, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n### Fixed\n- **Old** (GH 100): old.\n');
writeFileSync(join(B, 'changelog.d/77-dummy.md'), '### Tweaked\n- **Not validated** (GH 77): a malformed fragment does not block a version-only bump.\n');

const bump = (...args) =>
  spawnSync(process.execPath, [...TS, join(B, 'scripts/maintenance/bump-version.ts'), ...args], { cwd: TMP, encoding: 'utf8' });

test('--version-only sets all five versions and leaves CHANGELOG.md and fragments alone', () => {
  const changelog = readFileSync(join(B, 'CHANGELOG.md'), 'utf8');
  const fragment = readFileSync(join(B, 'changelog.d/77-dummy.md'), 'utf8');
  const r = bump('--version-only', '1.2.0-dev.2.gh1594');
  assert.equal(r.status, 0, r.stderr);
  for (const f of VERSION_FILES) assert.match(readFileSync(join(B, f), 'utf8'), /"version": "1\.2\.0-dev\.2\.gh1594"/, `${f} bumped`);
  assert.equal(readFileSync(join(B, 'CHANGELOG.md'), 'utf8'), changelog, 'CHANGELOG.md unchanged');
  assert.equal(readFileSync(join(B, 'changelog.d/77-dummy.md'), 'utf8'), fragment, 'fragment unchanged');
});

test('--version-only refuses --dry-run', () => {
  const r = bump('--version-only', '--dry-run', '1.2.0');
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'Error: --version-only takes no --dry-run or --date\n');
});
