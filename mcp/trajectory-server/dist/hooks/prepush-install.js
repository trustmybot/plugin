/**
 * SessionStart gate (GH 3281 slice 2): installs TMB's config-defined pre-push
 * hook, in observe mode, in the project's git repo and in every registered
 * repo, and marks the session's shell as an agent's. Per repo it writes
 * `<git-common-dir>/tmb/pre-push` and the repo-local `hook.tmb.*` keys, only
 * what differs, so a second run changes nothing (hooks/lib/prepush-hook.ts).
 * A non-git dir and an exempt repo (lib/repo isExempt) are skipped. Below git 2.54, which
 * cannot run a hook git config defines, it installs nothing. Linked worktrees
 * share the repo-local config, so one install covers them. stderr only, one
 * line per repo changed or skipped; it never denies. The project's
 * prepush_hook setting off, which only the Human sets through /onboard, is
 * never silent and fails safe: it removes the hook instead and prints one line
 * naming the setting (switchOff).
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { ALLOW } from './gate.js';
import { candidateDirs } from './ensure-gitignore.js';
import { dbPath } from './lib/db.js';
import { gitRun, isDir } from './lib/git.js';
import { gitCommonDir, installPrepushHook, pluginCliPath, prepushSwitchedOff, uninstallPrepushHook } from './lib/prepush-hook.js';
import { isExempt, repoGitRoot, repoNameForRoot } from './lib/repo.js';
import { PREPUSH_HOOK_KEY } from '../tools/config.js';
export const GATE_NAME = 'prepush-install';
/** The first git that runs a hook defined by `hook.<name>.*` config. */
const MIN_GIT = [2, 54];
export const AGENT_SHELL_MARK = 'export TMB_AGENT_SHELL=1';
/** [major, minor] of `git version` output, null when it is not that shape. */
export function parseGitVersion(text) {
    const m = /^git version (\d+)\.(\d+)/.exec(text.trim());
    return m ? [Number(m[1]), Number(m[2])] : null;
}
export function supportsConfigHooks(version) {
    return version[0] > MIN_GIT[0] || (version[0] === MIN_GIT[0] && version[1] >= MIN_GIT[1]);
}
const note = (line) => void process.stderr.write(`tmb: ${line}\n`);
/** Appends the agent-shell mark to <envFile> unless a line of it already is the mark. */
export function markAgentShell(envFile) {
    let text = '';
    try {
        text = readFileSync(envFile, 'utf8');
    }
    catch {
        /* a missing file is created */
    }
    if (text.split('\n').includes(AGENT_SHELL_MARK))
        return;
    appendFileSync(envFile, `${text === '' || text.endsWith('\n') ? '' : '\n'}${AGENT_SHELL_MARK}\n`);
}
async function installIn(dir, cli, seen, env) {
    const commonDir = isDir(dir) ? await gitCommonDir(dir, env) : '';
    if (commonDir === '') {
        note(`pre-push hook skipped for ${dir}: not a git repository`);
        return;
    }
    if (seen.has(commonDir))
        return;
    seen.add(commonDir);
    const root = await repoGitRoot(dir, env);
    const db = dbPath(env) ?? '';
    if (isExempt(db, root, env)) {
        note(`pre-push hook skipped for ${root}: repo ${repoNameForRoot(db, root, env)} is exempt`);
        return;
    }
    try {
        if (await installPrepushHook(dir, commonDir, cli, env))
            note(`installed TMB's pre-push hook (observe mode) in ${root}`);
    }
    catch (error) {
        note(`pre-push hook not installed in ${root}: ${error.message}`);
    }
}
/**
 * With the setting off, removes the hook from every repo the install would
 * reach (an exempt one too, so no live hook is left anywhere), on any git, and
 * says so in exactly one line; it leaves the shell unmarked.
 */
async function switchOff(env) {
    const seen = new Set();
    const removed = [];
    const failed = [];
    for (const dir of candidateDirs(env)) {
        const commonDir = isDir(dir) ? await gitCommonDir(dir, env) : '';
        if (commonDir === '' || seen.has(commonDir))
            continue;
        seen.add(commonDir);
        const root = (await repoGitRoot(dir, env)) || dir;
        try {
            if (await uninstallPrepushHook(dir, commonDir, env))
                removed.push(root);
        }
        catch (error) {
            failed.push(`${root} (${error.message})`);
        }
    }
    const outcome = [
        removed.length > 0 ? `removed it from ${removed.join(', ')}` : 'no installed hook to remove',
        ...(failed.length > 0 ? [`could not remove it from ${failed.join(', ')}`] : []),
    ].join('; ');
    note(`${PREPUSH_HOOK_KEY} is off for this project, so TMB's pre-push hook is off: ${outcome}; the command-text push judge stays on. ` +
        'Only the Human turns it back on, through /onboard; `cli.js prepush-uninstall [--repo <path>]` removes the hook from one repo without the setting');
}
export const prepushInstall = async (_payload, env) => {
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
    const seen = new Set();
    for (const dir of candidateDirs(env))
        await installIn(dir, cli, seen, env);
    const envFile = env.CLAUDE_ENV_FILE ?? '';
    if (envFile !== '') {
        try {
            markAgentShell(envFile);
        }
        catch (error) {
            note(`could not mark the agent shell in ${envFile}: ${error.message}`);
        }
    }
    return ALLOW;
};
//# sourceMappingURL=prepush-install.js.map