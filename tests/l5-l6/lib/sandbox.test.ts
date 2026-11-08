// node:test suite for sandbox.ts: init's env and on-disk setup, gh, glab and an https git push
// failing inside the sandbox, each stub's exact output, and teardown's cleanup.
// Run: node --experimental-strip-types --test tests/l5-l6/lib/sandbox.test.ts

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

const NETWORK_BLOCKED =
  /transport|blocked|disabled|Couldn.t connect|Failed to connect|Connection refused|Connection reset|Connection timed out|SSL_ERROR_SYSCALL|Could not resolve host|unable to access|terminal prompts disabled|could not read Username|Device not configured|Authentication failed/i;

describe('isolation inside the sandbox', () => {
  for (const [cli, args] of [
    ['gh', ['repo', 'create', `probe-repo-${process.pid}`]],
    ['glab', ['repo', 'create', `probe-${process.pid}`]],
  ] as const) {
    test(`${cli} repo create fails with the sandbox message`, () => {
      const { env } = tmbTestSandboxInit(scratch(), base);
      const r = spawnSync(cli, args, { env, encoding: 'utf8', timeout: 30_000 });
      assert.equal(r.status, 1, `${cli} exit code`);
      assert.match(r.stderr, /tmb sandbox/);
    });
  }

  test('git push to an https remote is blocked', () => {
    const dir = scratch();
    const { env } = tmbTestSandboxInit(dir, base);
    const repo = join(dir, 'probe');
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', timeout: 60_000 });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), 'probe\n');
    git('add', '.');
    assert.equal(git('commit', '-qm', 'probe').status, 0);
    const r = git('push', 'https://github.com/probe/probe.git', 'main');
    assert.notEqual(r.status, 0, 'git push https exit code');
    const out = `${r.stdout}${r.stderr}`;
    assert.ok(out.includes('tmb sandbox') || NETWORK_BLOCKED.test(out), `git push https output: ${out}`);
  });
});

const STUB_HEADERS: Record<string, { lines: string[]; remote: boolean }> = {
  curl: { lines: ['tmb sandbox: curl disabled in test mode.', 'Reason: prevents accidental outbound network requests.'], remote: false },
  wget: { lines: ['tmb sandbox: wget disabled in test mode.', 'Reason: prevents accidental outbound network requests.'], remote: false },
  gh: { lines: ['tmb sandbox: gh CLI disabled in test mode.', 'Reason: prevents accidental real-API calls + abuse-detection triggers.'], remote: true },
  glab: { lines: ['tmb sandbox: glab CLI disabled in test mode.', 'Reason: prevents accidental real-API calls + abuse-detection triggers.'], remote: true },
  'git-remote-http': { lines: ['tmb sandbox: HTTP git transport disabled in sandbox.', 'Reason: prevents accidental real-remote git push/fetch.'], remote: true },
  'git-remote-https': { lines: ['tmb sandbox: HTTPS git transport disabled in sandbox.', 'Reason: prevents accidental real-remote git push/fetch.'], remote: true },
};

describe('stub scripts', () => {
  test('every stub is a node script and nothing else lives in lib/stubs', () => {
    assert.deepEqual(readdirSync(STUBS_DIR).sort(), Object.keys(STUB_HEADERS).sort());
    for (const name of Object.keys(STUB_HEADERS)) {
      const path = join(STUBS_DIR, name);
      assert.equal(readFileSync(path, 'utf8').split('\n')[0], '#!/usr/bin/env node', name);
      assert.equal(statSync(path).mode & 0o111, 0o111, `${name} is executable`);
    }
  });

  for (const [name, { lines, remote }] of Object.entries(STUB_HEADERS)) {
    for (const remoteValue of remote ? [undefined, '', '/tmp/probe_remote.git'] : [undefined, '/tmp/probe_remote.git']) {
      for (const stdin of ['piped', 'closed'] as const) {
        test(`${name}: exact stderr, empty stdout, exit 1 (TMB_TEST_REMOTE=${remoteValue ?? 'unset'}, stdin ${stdin})`, () => {
          const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
          if (remoteValue !== undefined) env.TMB_TEST_REMOTE = remoteValue;
          const r = spawnSync(join(STUBS_DIR, name), ['repo', 'create', 'two  spaces'], {
            env,
            encoding: 'utf8',
            timeout: 30_000,
            ...(stdin === 'piped' ? { input: 'payload\n'.repeat(10_000) } : { stdio: ['ignore', 'pipe', 'pipe'] }),
          });
          const expected = [...lines];
          if (remote) expected.push(`For git remote tests, use: $TMB_TEST_REMOTE = ${remoteValue || '<not set>'}`);
          expected.push(`Attempted: ${name} repo create two  spaces`);
          assert.equal(r.stderr, `${expected.join('\n')}\n`);
          assert.equal(r.stdout, '');
          assert.equal(r.status, 1);
        });
      }
    }
  }

  test('gh with no arguments keeps the trailing space after its name', () => {
    const r = spawnSync(join(STUBS_DIR, 'gh'), [], { env: { PATH: process.env.PATH }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(r.stderr.split('\n').at(-2), 'Attempted: gh ');
    assert.equal(r.status, 1);
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
