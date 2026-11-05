/**
 * The l5-l6 sandbox (tests/l5-l6/lib/sandbox.sh) isolation proof, the l3 bash
 * suite's cases in node:test (GH 1692): its gh, glab and git-remote-https stubs
 * fail loudly with "tmb sandbox" and never reach the network, and teardown
 * restores PATH and HOME. One bash run sources the lib unchanged, records each
 * probe NUL-separated, and the cases assert on that record.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeSandbox, PLUGIN_ROOT, type Sandbox } from './hook-sandbox.js';
import { has } from './git-push-guard-l3.js';

const SANDBOX_LIB = join(PLUGIN_ROOT, 'tests/l5-l6/lib/sandbox.sh');

const PROBE = `
. "$1"
scratch="$2"
probe_repo="$3"
mkdir -p "$scratch" "$probe_repo"
tmb_test_sandbox_init "$scratch"
gh_out=$(gh repo create "probe-repo-$$" 2>&1) && gh_exit=0 || gh_exit=$?
glab_out=$(glab repo create "probe-$$" 2>&1) && glab_exit=0 || glab_exit=$?
git -C "$probe_repo" init -q -b main
git -C "$probe_repo" config user.email "test@tmb.invalid"
git -C "$probe_repo" config user.name "TMB Test"
echo "probe" > "$probe_repo/README.md"
git -C "$probe_repo" add .
git -C "$probe_repo" commit -qm "probe"
https_out=$(git -C "$probe_repo" push "https://github.com/probe/probe.git" main 2>&1) && https_exit=0 || https_exit=$?
rm -rf "$probe_repo"
orig_path="$TMB_SANDBOX_ORIG_PATH"
orig_home="$TMB_SANDBOX_ORIG_HOME"
tmb_test_sandbox_teardown
printf '%s\\0' "$gh_exit" "$gh_out" "$glab_exit" "$glab_out" "$https_exit" "$https_out" \\
  "$orig_path" "$PATH" "$orig_home" "$HOME" "\${TMB_SANDBOX_ORIG_PATH:-}" "\${TMB_TEST_REMOTE:-}"
`;

const NETWORK_BLOCKED =
  /transport|blocked|disabled|Couldn.t connect|Failed to connect|Connection refused|Connection reset|Connection timed out|SSL_ERROR_SYSCALL|Could not resolve host|unable to access|terminal prompts disabled|could not read Username|Device not configured|Authentication failed/i;

describe('sandbox isolation l3', () => {
  let sb: Sandbox;
  let probe: Record<string, string>;

  before(() => {
    sb = makeSandbox('sandbox-isolation');
    const r = spawnSync('bash', ['-c', PROBE, 'bash', SANDBOX_LIB, join(sb.dir, 'scratch'), join(sb.dir, 'probe')], {
      env: { ...sb.env, CLAUDE_PROJECT_DIR: sb.dir },
      cwd: sb.dir,
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (r.error) throw r.error;
    const keys = ['ghExit', 'ghOut', 'glabExit', 'glabOut', 'httpsExit', 'httpsOut', 'origPath', 'path', 'origHome', 'home', 'origPathVar', 'remoteVar'];
    const values = r.stdout.split('\0');
    assert.ok(values.length > keys.length, `probe run failed: ${r.stderr}`);
    probe = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  });
  after(() => sb.remove());

  it('gh repo create fails with sandbox message', () => {
    assert.equal(probe.ghExit, '1', 'gh exit code');
    has(probe.ghOut, 'tmb sandbox', 'gh stderr');
  });

  it('glab repo create fails with sandbox message', () => {
    assert.equal(probe.glabExit, '1', 'glab exit code');
    has(probe.glabOut, 'tmb sandbox', 'glab stderr');
  });

  it('git push to https remote is blocked — exit non-zero', () => {
    assert.notEqual(probe.httpsExit, '0', 'git push https: expected non-zero exit, got 0');
  });

  it('git push to https remote is blocked — sandbox, transport, or credential-prompt suppressed', () => {
    assert.ok(
      probe.httpsOut.includes('tmb sandbox') || NETWORK_BLOCKED.test(probe.httpsOut),
      `git push https: expected sandbox or network-blocked or credential-suppressed message, got: ${probe.httpsOut}`,
    );
  });

  it('PATH restored after teardown', () => {
    assert.equal(probe.path, probe.origPath, 'PATH after teardown');
  });

  it('HOME restored after teardown', () => {
    assert.equal(probe.home, probe.origHome, 'HOME after teardown');
  });

  it('TMB_SANDBOX_ORIG_PATH unset after teardown', () => {
    assert.equal(probe.origPathVar, '', `TMB_SANDBOX_ORIG_PATH still set after teardown: ${probe.origPathVar}`);
  });

  it('TMB_TEST_REMOTE unset after teardown', () => {
    assert.equal(probe.remoteVar, '', `TMB_TEST_REMOTE still set after teardown: ${probe.remoteVar}`);
  });
});
