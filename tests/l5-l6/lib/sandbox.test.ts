// node:test suite for sandbox.ts: init's env and on-disk setup, and teardown's cleanup.
// Run: node --experimental-strip-types --test tests/l5-l6/lib/sandbox.test.ts

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { CREDENTIAL_VARS, STUBS_DIR, tmbTestSandboxInit, tmbTestSandboxTeardown } from './sandbox.ts';

const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'tmb-sandbox-test.'));
  roots.push(root);
  return join(root, 'project');
}

const credentials = Object.fromEntries(CREDENTIAL_VARS.map((name) => [name, `secret-${name}`]));
const base: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: '/real/home', KEEP_ME: 'yes', ...credentials };

describe('tmbTestSandboxInit', () => {
  test('puts lib/stubs first on PATH and saves the original', () => {
    const { env } = tmbTestSandboxInit(scratch(), base);
    assert.equal(env.PATH, `${STUBS_DIR}${delimiter}${base.PATH}`);
    assert.equal(env.PATH?.split(delimiter)[0], join(import.meta.dirname, 'stubs'));
    assert.equal(env.TMB_SANDBOX_ORIG_PATH, base.PATH);
  });

  test('the stubs on PATH block gh', () => {
    const { env } = tmbTestSandboxInit(scratch(), base);
    const r = spawnSync('gh', ['auth', 'status'], { env, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /gh CLI disabled in test mode/);
  });

  test('points HOME at <scratch>/_home with the test .gitconfig and .ssh', () => {
    const dir = scratch();
    const { env } = tmbTestSandboxInit(dir, base);
    assert.equal(env.HOME, join(dir, '_home'));
    assert.equal(env.TMB_SANDBOX_ORIG_HOME, '/real/home');
    const gitconfig = readFileSync(join(dir, '_home', '.gitconfig'), 'utf8');
    assert.equal(gitconfig, '[user]\n  name = TMB Test\n  email = test@tmb.invalid\n[init]\n  defaultBranch = main\n');
    assert.ok(existsSync(join(dir, '_home', '.ssh')));
  });

  test('drops every credential var the .sh unsets and keeps the rest', () => {
    const { env } = tmbTestSandboxInit(scratch(), base);
    assert.deepEqual(
      [...CREDENTIAL_VARS].sort(),
      [
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'GH_ENTERPRISE_HOSTS',
        'GH_ENTERPRISE_TOKEN',
        'GH_HOST',
        'GH_TOKEN',
        'GITHUB_TOKEN',
        'GITLAB_TOKEN',
        'GL_TOKEN',
        'NPM_TOKEN',
        'SSH_AGENT_PID',
        'SSH_AUTH_SOCK',
      ],
    );
    for (const name of CREDENTIAL_VARS) assert.equal(name in env, false, name);
    assert.equal(env.KEEP_ME, 'yes');
  });

  test('sets GIT_TERMINAL_PROMPT=0 and TRAJECTORY_DB_PATH to the scratch DB', () => {
    const dir = scratch();
    const { env } = tmbTestSandboxInit(dir, base);
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.TRAJECTORY_DB_PATH, join(dir, '.claude', 'tmb', 'trajectory.db'));
  });

  test('creates the bare remote next to the scratch dir', () => {
    const dir = scratch();
    const { env, remote } = tmbTestSandboxInit(dir, base);
    assert.equal(remote, `${dir}_remote.git`);
    assert.equal(env.TMB_TEST_REMOTE, remote);
    const r = spawnSync('git', ['-C', remote, 'rev-parse', '--is-bare-repository'], { encoding: 'utf8' });
    assert.equal(r.stdout.trim(), 'true');
  });

  test('leaves the base env untouched', () => {
    const before = { ...base };
    tmbTestSandboxInit(scratch(), base);
    assert.deepEqual(base, before);
  });
});

describe('tmbTestSandboxTeardown', () => {
  test('removes the remote, restores PATH and HOME and drops the sandbox vars', () => {
    const sandbox = tmbTestSandboxInit(scratch(), base);
    assert.ok(existsSync(sandbox.remote));
    const env = tmbTestSandboxTeardown(sandbox);
    assert.equal(existsSync(sandbox.remote), false);
    assert.equal(env.PATH, base.PATH);
    assert.equal(env.HOME, '/real/home');
    for (const name of ['TMB_SANDBOX_ORIG_PATH', 'TMB_SANDBOX_ORIG_HOME', 'TMB_TEST_REMOTE', 'GIT_TERMINAL_PROMPT', 'TRAJECTORY_DB_PATH']) {
      assert.equal(name in env, false, name);
    }
    for (const name of CREDENTIAL_VARS) assert.equal(name in env, false, name);
    assert.equal(env.KEEP_ME, 'yes');
  });
});
