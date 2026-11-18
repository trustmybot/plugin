/**
 * SessionStart gate (GH 3281 slice 2): installs TMB's config-defined pre-push
 * hook, in observe mode, in the project's git repo and in every registered
 * repo, and marks the session's shell as an agent's. Per repo it writes
 * `<git-common-dir>/tmb/pre-push` and the repo-local `hook.tmb.*` keys, only
 * what differs, so a second run changes nothing (hooks/lib/prepush-hook.ts).
 * A non-git dir and an exempt repo (lib/repo isExempt) are skipped. Below git 2.54, which
 * cannot run a hook git config defines, it installs nothing. Linked worktrees
 * share the repo-local config, so one install covers them. stderr only, one
 * line per repo changed or skipped; it never denies. The Human's switch,
 * TMB_DISABLE_PREPUSH_INSTALL=1, is never silent and fails safe: it removes the
 * hook instead and prints one line naming the switch (switchOff); the
 * prepush-hook-guard keeps an agent from setting it.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { ALLOW, type Gate } from './gate.js';
import { candidateDirs } from './ensure-gitignore.js';
import { dbPath } from './lib/db.js';
import { gitRun, isDir } from './lib/git.js';
import { gitCommonDir, installPrepushHook, pluginCliPath, PREPUSH_SWITCH, prepushSwitchedOff, uninstallPrepushHook } from './lib/prepush-hook.js';
import { isExempt, repoGitRoot, repoNameForRoot } from './lib/repo.js';

export const GATE_NAME = 'prepush-install';

/** The first git that runs a hook defined by `hook.<name>.*` config. */
const MIN_GIT: readonly [number, number] = [2, 54];
export const AGENT_SHELL_MARK = 'export TMB_AGENT_SHELL=1';

/** [major, minor] of `git version` output, null when it is not that shape. */
export function parseGitVersion(text: string): [number, number] | null {
  const m = /^git version (\d+)\.(\d+)/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function supportsConfigHooks(version: readonly [number, number]): boolean {
  return version[0] > MIN_GIT[0] || (version[0] === MIN_GIT[0] && version[1] >= MIN_GIT[1]);
}

const note = (line: string): void => void process.stderr.write(`tmb: ${line}\n`);

/** Appends the agent-shell mark to <envFile> unless a line of it already is the mark. */
export function markAgentShell(envFile: string): void {
  let text = '';
  try {
    text = readFileSync(envFile, 'utf8');
  } catch {
    /* a missing file is created */
  }
  if (text.split('\n').includes(AGENT_SHELL_MARK)) return;
  appendFileSync(envFile, `${text === '' || text.endsWith('\n') ? '' : '\n'}${AGENT_SHELL_MARK}\n`);
}

async function installIn(dir: string, cli: string, seen: Set<string>, env: NodeJS.ProcessEnv): Promise<void> {
  const commonDir = isDir(dir) ? await gitCommonDir(dir, env) : '';
  if (commonDir === '') {
    note(`pre-push hook skipped for ${dir}: not a git repository`);
    return;
  }
  if (seen.has(commonDir)) return;
  seen.add(commonDir);
  const root = await repoGitRoot(dir, env);
  const db = dbPath(env) ?? '';
  if (isExempt(db, root, env)) {
    note(`pre-push hook skipped for ${root}: repo ${repoNameForRoot(db, root, env)} is exempt`);
    return;
  }
  try {
    if (await installPrepushHook(dir, commonDir, cli, env)) note(`installed TMB's pre-push hook (observe mode) in ${root}`);
  } catch (error) {
    note(`pre-push hook not installed in ${root}: ${(error as Error).message}`);
  }
}

/**
 * With the switch set, removes the hook from every repo the install would
 * reach (an exempt one too, so no live hook is left anywhere), on any git, and
 * says so in exactly one line; it leaves the shell unmarked.
 */
async function switchOff(env: NodeJS.ProcessEnv): Promise<void> {
  const seen = new Set<string>();
  const removed: string[] = [];
  const failed: string[] = [];
  for (const dir of candidateDirs(env)) {
    const commonDir = isDir(dir) ? await gitCommonDir(dir, env) : '';
    if (commonDir === '' || seen.has(commonDir)) continue;
    seen.add(commonDir);
    const root = (await repoGitRoot(dir, env)) || dir;
    try {
      if (await uninstallPrepushHook(dir, commonDir, env)) removed.push(root);
    } catch (error) {
      failed.push(`${root} (${(error as Error).message})`);
    }
  }
  const outcome = [
    removed.length > 0 ? `removed it from ${removed.join(', ')}` : 'no installed hook to remove',
    ...(failed.length > 0 ? [`could not remove it from ${failed.join(', ')}`] : []),
  ].join('; ');
  note(
    `${PREPUSH_SWITCH}=1 is set, so TMB's pre-push hook is off: ${outcome}; the command-text push judge stays on. ` +
      'Unset it to reinstall; `cli.js prepush-uninstall [--repo <path>]` removes the hook from one repo without the switch',
  );
}

export const prepushInstall: Gate = async (_payload, env) => {
  if (prepushSwitchedOff(env)) {
    await switchOff(env);
    return ALLOW;
  }
  const version = parseGitVersion((await gitRun('/', ['version'], env)).stdout);
  if (version === null || !supportsConfigHooks(version)) {
    note(`pre-push hook not installed: git ${version?.join('.') ?? '(unknown)'} is older than ${MIN_GIT.join('.')}, so the command-text push judge stays on alone`);
    return ALLOW;
  }
  const cli = pluginCliPath(env);
  const seen = new Set<string>();
  for (const dir of candidateDirs(env)) await installIn(dir, cli, seen, env);
  const envFile = env.CLAUDE_ENV_FILE ?? '';
  if (envFile !== '') {
    try {
      markAgentShell(envFile);
    } catch (error) {
      note(`could not mark the agent shell in ${envFile}: ${(error as Error).message}`);
    }
  }
  return ALLOW;
};
