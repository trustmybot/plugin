/**
 * TMB's pre-push hook as git config names it (GH 3281 slice 2): the script at
 * `<git-common-dir>/tmb/pre-push` and the repo-local `hook.tmb.*` keys that
 * run it before any core.hooksPath or .git/hooks hook. The prepush-install
 * gate writes them, `cli.js prepush-uninstall` removes them, and both
 * prepush_observed writers check them per push with prepushHookLive.
 *
 * The script exists whenever the config names it: git fails every push with
 * "cannot exec" on a missing command file, so install writes the script
 * before the config and uninstall drops the config before the script.
 */
import { chmodSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gitRun } from './git.js';
import { installRoot, posixDirname } from './project-env.js';

/** The fixed line that marks the script as TMB's own. */
export const PREPUSH_MARKER = "# tmb-prepush-hook (GH 3281): TMB's pre-push hook, observe mode; `cli.js prepush-uninstall` removes it";
export const HOOK_NAME = 'tmb';
const HOOK_SECTION = `hook.${HOOK_NAME}`;
const SCRIPT_MODE = 0o755;

/** Whether each part of the hook is in place in one checkout. */
export interface PrepushHookLive {
  /** `git hook list --show-scope pre-push` has an enabled `tmb` line. */
  readonly listed: boolean;
  /** `hook.tmb.command` is the script this checkout's git-common-dir holds. */
  readonly command_matches: boolean;
  /** That script exists and holds PREPUSH_MARKER. */
  readonly script_intact: boolean;
}

/** The plugin's own dist/cli.js, the absolute path the script runs. */
export function pluginCliPath(env: NodeJS.ProcessEnv = process.env): string {
  const here = posixDirname(fileURLToPath(import.meta.url));
  const root = installRoot(here) ?? env.CLAUDE_PLUGIN_ROOT ?? '';
  return `${root}/mcp/trajectory-server/dist/cli.js`;
}

/** The absolute git-common-dir of <dir>, '' when <dir> is in no git repo. */
export async function gitCommonDir(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const r = await gitRun(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env);
  return r.code === 0 ? r.stdout.replace(/\n+$/, '') : '';
}

export function prepushScriptPath(commonDir: string): string {
  return `${commonDir}/tmb/pre-push`;
}

const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * The script: outside a marked agent shell, or with the CLI gone, it exits 0
 * at once; otherwise it hands git's args and stdin to `cli.js pre-push` and
 * exits 0 whatever that does, since the hook only observes.
 */
export function prepushScript(cli: string): string {
  return [
    '#!/bin/sh',
    PREPUSH_MARKER,
    '[ -n "${TMB_AGENT_SHELL:-}" ] || exit 0',
    `cli=${shellQuote(cli)}`,
    '[ -f "$cli" ] || exit 0',
    'node --experimental-sqlite "$cli" pre-push "$@"',
    'exit 0',
    '',
  ].join('\n');
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function modeOf(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

/** Writes <script> to <path> through a rename, so git never runs a half-written file; false when it was already there. */
function writeScript(path: string, script: string): boolean {
  if (readText(path) === script && modeOf(path) === SCRIPT_MODE) return false;
  mkdirSync(posixDirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, script, { mode: SCRIPT_MODE });
    chmodSync(tmp, SCRIPT_MODE);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  return true;
}

async function configValues(dir: string, key: string, env: NodeJS.ProcessEnv): Promise<string> {
  return (await gitRun(dir, ['config', '--local', '--get-all', key], env)).stdout.replace(/\n+$/, '');
}

/** Sets repo-local <key> to <value> unless it already is that one value; true when it wrote. */
async function setConfig(dir: string, key: string, value: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if ((await configValues(dir, key, env)) === value) return false;
  const r = await gitRun(dir, ['config', '--local', '--replace-all', key, value], env);
  if (r.code !== 0) throw new Error(`git config ${key} failed`);
  return true;
}

/**
 * Installs the hook in the repo of <dir>, whose git-common-dir is <commonDir>,
 * running <cli>: the script first, then the config. Returns whether anything
 * changed; never touches core.hooksPath or the hooks dir.
 */
export async function installPrepushHook(dir: string, commonDir: string, cli: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const script = prepushScriptPath(commonDir);
  let changed = writeScript(script, prepushScript(cli));
  for (const [key, value] of [
    ['event', 'pre-push'],
    ['command', script],
    ['enabled', 'true'],
  ] as const) {
    if (await setConfig(dir, `${HOOK_SECTION}.${key}`, value, env)) changed = true;
  }
  return changed;
}

/** Removes the hook.tmb section, then the script and its dir; true when either was there. */
export async function uninstallPrepushHook(dir: string, commonDir: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  let removed = false;
  if ((await gitRun(dir, ['config', '--local', '--get-regexp', `^${HOOK_SECTION.replace('.', '\\.')}\\.`], env)).code === 0) {
    const r = await gitRun(dir, ['config', '--local', '--remove-section', HOOK_SECTION], env);
    if (r.code !== 0) throw new Error(`git config --remove-section ${HOOK_SECTION} failed`);
    removed = true;
  }
  const script = prepushScriptPath(commonDir);
  if (readText(script) !== null || modeOf(script) !== null) {
    rmSync(script, { force: true });
    removed = true;
  }
  try {
    rmdirSync(posixDirname(script));
  } catch {
    /* absent, or holding something that is not ours */
  }
  return removed;
}

/** Whether a `git hook list --show-scope` line is an enabled hook named <name>. */
function enabledLine(line: string, name: string): boolean {
  const fields = line.split('\t');
  return fields[fields.length - 1] === name && !fields.includes('disabled') && !fields.includes('event-disabled');
}

/** Whether TMB's pre-push hook is live in the checkout at <cwd>: listed and enabled, its command the expected script, the script intact. */
export async function prepushHookLive(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<PrepushHookLive> {
  const listing = await gitRun(cwd, ['hook', 'list', '--show-scope', 'pre-push'], env);
  const listed = listing.code === 0 && listing.stdout.split('\n').some((line) => enabledLine(line, HOOK_NAME));
  const commonDir = await gitCommonDir(cwd, env);
  const expected = commonDir === '' ? '' : prepushScriptPath(commonDir);
  const command = (await gitRun(cwd, ['config', '--get', `${HOOK_SECTION}.command`], env)).stdout.replace(/\n+$/, '');
  const script = expected === '' ? null : readText(expected);
  return {
    listed,
    command_matches: expected !== '' && command === expected,
    script_intact: script !== null && script.split('\n').includes(PREPUSH_MARKER),
  };
}
