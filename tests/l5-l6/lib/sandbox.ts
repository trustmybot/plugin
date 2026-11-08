// TypeScript port of sandbox.sh (GH 1692), the per-step sandbox of the L5/L6 runs.
// Init returns a new env: stubs/ first on PATH (blocking gh, glab, curl, wget and the git
// HTTP(S) transports), HOME at <scratch>/_home with a test .gitconfig, every credential var
// dropped, GIT_TERMINAL_PROMPT=0 and TRAJECTORY_DB_PATH pinned to the scratch DB. It also
// creates the bare repo TMB_TEST_REMOTE names, the push target. Teardown removes that repo and
// returns the env with PATH and HOME restored. Neither touches process.env.

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STUBS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'stubs');

export const CREDENTIAL_VARS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_HOST',
  'GH_ENTERPRISE_TOKEN',
  'GH_ENTERPRISE_HOSTS',
  'GITLAB_TOKEN',
  'GL_TOKEN',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'NPM_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
] as const;

const SANDBOX_VARS = ['TMB_SANDBOX_ORIG_PATH', 'TMB_SANDBOX_ORIG_HOME', 'TMB_TEST_REMOTE', 'GIT_TERMINAL_PROMPT', 'TRAJECTORY_DB_PATH'];

const GITCONFIG = `[user]
  name = TMB Test
  email = test@tmb.invalid
[init]
  defaultBranch = main
`;

export interface Sandbox {
  env: NodeJS.ProcessEnv;
  remote: string;
}

/** tmb_test_sandbox_init <scratch_dir>. */
export function tmbTestSandboxInit(scratch: string, baseEnv: NodeJS.ProcessEnv = process.env): Sandbox {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  env.TMB_SANDBOX_ORIG_PATH = baseEnv.PATH ?? '';
  env.PATH = `${STUBS_DIR}${delimiter}${baseEnv.PATH ?? ''}`;
  for (const name of CREDENTIAL_VARS) delete env[name];

  const home = join(scratch, '_home');
  env.TMB_SANDBOX_ORIG_HOME = baseEnv.HOME ?? '';
  env.HOME = home;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.gitconfig'), GITCONFIG);
  mkdirSync(join(home, '.ssh'), { recursive: true });

  const remote = join(dirname(scratch), `${basename(scratch)}_remote.git`);
  env.TMB_TEST_REMOTE = remote;
  spawnSync('git', ['init', '--bare', remote], { env, stdio: 'ignore' });

  env.GIT_TERMINAL_PROMPT = '0';
  env.TRAJECTORY_DB_PATH = join(scratch, '.claude', 'tmb', 'trajectory.db');
  return { env, remote };
}

/** tmb_test_sandbox_teardown: removes the bare remote; returns the env with PATH and HOME restored. */
export function tmbTestSandboxTeardown(sandbox: Sandbox): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...sandbox.env };
  if (env.TMB_SANDBOX_ORIG_PATH) env.PATH = env.TMB_SANDBOX_ORIG_PATH;
  if (env.TMB_SANDBOX_ORIG_HOME) env.HOME = env.TMB_SANDBOX_ORIG_HOME;
  if (sandbox.remote !== '') rmSync(sandbox.remote, { recursive: true, force: true });
  for (const name of SANDBOX_VARS) delete env[name];
  return env;
}
