import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dockerBuild } from './run-docker.ts';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'run-docker.ts');
const REPO_ROOT = join(dirname(RUNNER), '..', '..');
const BUN_PINNED_DOCKERFILES = ['install-smoke.Dockerfile', 'release-canary.Dockerfile'];

function bunPinProblems(dockerfile: string): string[] {
  const problems: string[] = [];
  if (/bun-v\d/.test(dockerfile)) problems.push('hardcodes bun-v<version>');
  if (/BUN_VERSION=\d/.test(dockerfile)) problems.push('hardcodes BUN_VERSION=<version>');
  if (!/^COPY \.bun-version \/tmp\/\.bun-version$/m.test(dockerfile)) problems.push('lacks COPY .bun-version');
  if (!dockerfile.includes("bun-v$(tr -d '[:space:]' < /tmp/.bun-version)")) problems.push('does not install bun-v<.bun-version>');
  return problems;
}

test('install builds install-smoke.Dockerfile tagged with the plugin version', () => {
  assert.deepEqual(dockerBuild('install', { version: '1.2.3' }), {
    argv: ['build', '-f', 'tests/l0-install/install-smoke.Dockerfile', '-t', 'tmb-install-smoke:1.2.3', '--progress=plain', '.'],
    env: {},
  });
});

test('canary without a token builds install-only, no secret', () => {
  assert.deepEqual(dockerBuild('canary', { version: '1.2.3' }), {
    argv: [
      'build',
      '--build-arg',
      'PLUGIN_VERSION=1.2.3',
      '-f',
      'tests/l0-install/release-canary.Dockerfile',
      '-t',
      'tmb-release-canary:1.2.3',
      '--progress=plain',
      '.',
    ],
    env: { DOCKER_BUILDKIT: '1' },
  });
});

test('canary with a token passes CLAUDE_CODE_OAUTH_TOKEN as a BuildKit secret, never its value', () => {
  const build = dockerBuild('canary', { version: '1.2.3', token: 'sk-secret' });
  assert.deepEqual(build, {
    argv: [
      'build',
      '--secret',
      'id=cc_token,env=CLAUDE_CODE_OAUTH_TOKEN',
      '--build-arg',
      'PLUGIN_VERSION=1.2.3',
      '-f',
      'tests/l0-install/release-canary.Dockerfile',
      '-t',
      'tmb-release-canary:1.2.3',
      '--progress=plain',
      '.',
    ],
    env: { DOCKER_BUILDKIT: '1' },
  });
  assert.ok(!build.argv.join(' ').includes('sk-secret'));
});

test('upgrade passes the archived v1.0.2 tree as the v102 build context', () => {
  assert.deepEqual(dockerBuild('upgrade', { version: '1.2.3', oldTree: '/tmp/old' }), {
    argv: [
      'build',
      '-f',
      'tests/l0-install/upgrade-smoke.Dockerfile',
      '--build-context',
      'v102=/tmp/old',
      '-t',
      'tmb-upgrade-smoke:1.2.3',
      '--progress=plain',
      '.',
    ],
    env: { DOCKER_BUILDKIT: '1' },
  });
});

test('upgrade without an old tree throws', () => {
  assert.throws(() => dockerBuild('upgrade', { version: '1.2.3' }), /oldTree/);
});

for (const args of [['bogus'], [], ['install', 'extra']]) {
  test(`run-docker.ts ${JSON.stringify(args)} prints usage and exits 2`, () => {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', RUNNER, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Usage: .*run-docker\.ts <install\|canary\|upgrade>/);
  });
}

test('run-docker.ts runs when invoked through a symlinked directory', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'run-docker-link-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = join(dir, 'root');
  symlinkSync(join(dirname(RUNNER), '..', '..'), link);
  const r = spawnSync(process.execPath, ['--experimental-strip-types', join(link, 'tests/l0-install/run-docker.ts'), '--bogus'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /Usage: .*run-docker\.ts <install\|canary\|upgrade>/);
});

test('.bun-version holds a bare bun version', () => {
  assert.match(readFileSync(join(REPO_ROOT, '.bun-version'), 'utf8'), /^\d+\.\d+\.\d+\s*$/);
});

for (const name of BUN_PINNED_DOCKERFILES) {
  test(`${name} installs the bun version from .bun-version, never a literal`, () => {
    assert.deepEqual(bunPinProblems(readFileSync(join(dirname(RUNNER), name), 'utf8')), []);
  });
}

test('the bun pin check flags a hardcoded version or a missing .bun-version COPY', () => {
  const pinned = readFileSync(join(dirname(RUNNER), 'install-smoke.Dockerfile'), 'utf8');
  assert.deepEqual(bunPinProblems(`${pinned}\nRUN bash -s bun-v1.3.4\n`), ['hardcodes bun-v<version>']);
  assert.deepEqual(bunPinProblems(`${pinned}\nARG BUN_VERSION=1.3.4\n`), ['hardcodes BUN_VERSION=<version>']);
  assert.deepEqual(bunPinProblems(pinned.replace('COPY .bun-version /tmp/.bun-version\n', '')), ['lacks COPY .bun-version']);
});
