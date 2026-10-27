/**
 * PostToolUse(Bash) hook (GH 1692), the port of
 * scripts/hooks/clean-merged-branch.sh: after a successful `gh pr merge` /
 * `glab mr merge`, the merged feature branch (an explicit branch argument,
 * else the branch checked out where the merge ran) and its worktree are
 * removed when the branch is not protected, its work is already in its base
 * (ancestor, squash or rebase merge) and its worktree is clean; then a
 * detached `git fetch --prune`. stderr notes are the .sh's.
 *
 * Advisory: it prints nothing on stdout and always exits 0. Bypass:
 * TMB_DISABLE_CLEAN_MERGED_BRANCH=1. Unlike the .sh it needs no jq, and it
 * reads repos.target_branch and protected_branches wherever node:sqlite
 * works, with no sqlite3 CLI on PATH (decision 703).
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { ALLOW } from './gate.js';
import { dbPath } from './lib/db.js';
import { gitOk, gitOut, gitRun, isDir } from './lib/git.js';
import { mergeFailed, readMergePayload } from './lib/merge.js';
import { cmdCwd, repoDefaultBranch, repoGitRoot, repoResolve } from './lib/repo.js';
export const GATE_NAME = 'clean-merged-branch';
const MERGE_CMD = /(^|[^A-Za-z0-9_-])(gh[ \t\v\f\r]+pr[ \t\v\f\r]+merge|glab[ \t\v\f\r]+mr[ \t\v\f\r]+merge)([^A-Za-z0-9_-]|$)/m;
const MERGE_PREFIX = /^.*(gh[ \t\v\f\r]+pr|glab[ \t\v\f\r]+mr)[ \t\v\f\r]+merge/;
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
function note(text) {
    process.stderr.write(`tmb: ${text}\n`);
}
function localBranch(root, name, env) {
    return gitOk(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], env);
}
/** The merge command names a merge (word-boundary grep over its lines). */
export function namesMerge(cmd) {
    return MERGE_CMD.test(cmd);
}
/** _cmb_branch_from_cmd: the first word after `merge` (per line) that is no flag, URL or number and is a local branch. */
export function branchFromCmd(cmd, root, env = process.env) {
    const args = cmd
        .split('\n')
        .map((line) => line.replace(MERGE_PREFIX, ''))
        .join('\n');
    for (const tok of args.split(/[ \t\n]+/)) {
        if (tok === '' || tok.startsWith('-') || tok.includes('://'))
            continue;
        if (/^[0-9]+$/.test(tok))
            continue;
        if (localBranch(root, tok, env))
            return tok;
    }
    return '';
}
/** The repos row of <root> as tmb_repo_resolve prints it, "" with no readable DB. */
function repoRow(root, env) {
    const db = dbPath(env);
    return db !== null && isFile(db) ? repoResolve(db, root, env) : '';
}
/** `cut -d'|' -f<n>`: the whole line when it holds no `|`. */
function cut(row, n) {
    return row.includes('|') ? (row.split('|')[n - 1] ?? '') : row;
}
/** _cmb_is_protected: the repo's default branch, or a token of its repos.protected_branches. */
export function isProtected(root, branch, env = process.env) {
    const def = repoDefaultBranch(root, env);
    if (def !== '' && branch === def)
        return true;
    const protectedList = cut(repoRow(root, env), 3);
    return (protectedList !== '' &&
        protectedList
            .replace(/[\][",]/g, ' ')
            .split(/[ \t\n]+/)
            .includes(branch));
}
/** _cmb_base_branch: repos.target_branch, else the repo's default branch. */
export function baseBranch(root, env = process.env) {
    const target = cut(repoRow(root, env), 1);
    return target !== '' ? target : repoDefaultBranch(root, env);
}
/** _cmb_integrated: <tip>'s work is in <target>: ancestor, a no-op merge-tree, or no `+` line from git cherry. */
export function integrated(root, tip, target, env = process.env) {
    if (gitOk(root, ['merge-base', '--is-ancestor', tip, target], env))
        return true;
    const merged = gitRun(root, ['merge-tree', '--write-tree', target, tip], env);
    if (merged.code === 0) {
        const tree = gitRun(root, ['rev-parse', `${target}^{tree}`], env);
        const targetTree = tree.code === 0 ? tree.stdout.replace(/\n+$/, '') : '';
        if (targetTree !== '' && merged.stdout.replace(/\n+$/, '').split('\n')[0] === targetTree)
            return true;
    }
    const cherry = gitRun(root, ['cherry', target, tip], env);
    if (cherry.code !== 0)
        return false;
    return !cherry.stdout.split('\n').some((line) => line.startsWith('+'));
}
/** _cmb_worktree_for_branch: the linked worktree <branch> is checked out in, never the main one. */
export function worktreeForBranch(root, branch, env = process.env) {
    const want = `refs/heads/${branch}`;
    let wt = '';
    for (const line of gitRun(root, ['worktree', 'list', '--porcelain'], env).stdout.split('\n')) {
        if (line.startsWith('worktree '))
            wt = line.slice('worktree '.length);
        else if (line.startsWith('branch ') && line.slice('branch '.length) === want && wt !== root)
            return wt;
    }
    return '';
}
function fetchPrune(root, env) {
    try {
        const child = spawn('git', ['-C', root, 'fetch', '--prune', '--quiet'], {
            detached: true,
            stdio: 'ignore',
            env: { ...env, GIT_TERMINAL_PROMPT: '0' },
        });
        child.on('error', () => { });
        child.unref();
    }
    catch {
        /* best effort */
    }
}
function clean(payload, env) {
    const { input, toolName, command: cmd, response } = readMergePayload(payload);
    if (toolName !== 'Bash' || cmd === '')
        return;
    if (!namesMerge(cmd) || mergeFailed(response))
        return;
    const cwd = cmdCwd(cmd, input, env);
    const root = repoGitRoot(cwd, env);
    if (root === '' || !isDir(root))
        return;
    let branch = branchFromCmd(cmd, root, env);
    if (branch === '')
        branch = gitOut(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], env);
    if (branch === '' || branch === 'HEAD')
        return;
    if (!localBranch(root, branch, env))
        return;
    if (isProtected(root, branch, env))
        return;
    const base = baseBranch(root, env);
    if (base === '' || !localBranch(root, base, env) || branch === base)
        return;
    if (!integrated(root, `refs/heads/${branch}`, `refs/heads/${base}`, env))
        return;
    const wt = worktreeForBranch(root, branch, env);
    if (wt !== '' && isDir(wt)) {
        if (gitRun(wt, ['status', '--porcelain'], env).stdout !== '') {
            note(`branch ${branch} is merged but its worktree ${wt} has uncommitted/untracked changes — skipping cleanup (never force)`);
            return;
        }
        if (!gitOk(root, ['worktree', 'remove', wt], env)) {
            note(`worktree remove failed for ${wt} — leaving branch ${branch} in place`);
            return;
        }
    }
    if (gitOk(root, ['branch', '-D', branch], env)) {
        gitOk(root, ['worktree', 'prune'], env);
        note(`cleaned up merged branch ${branch}${wt !== '' ? ` (worktree ${wt})` : ''}`);
    }
    else {
        note(`branch delete failed for ${branch} — leaving in place`);
        gitOk(root, ['worktree', 'prune'], env);
    }
    fetchPrune(root, env);
}
export const cleanMergedBranch = (payload, env) => {
    if ((env.TMB_DISABLE_CLEAN_MERGED_BRANCH ?? '0') === '1')
        return ALLOW;
    try {
        clean(payload, env);
    }
    catch {
        /* advisory: every path exits 0 */
    }
    return ALLOW;
};
//# sourceMappingURL=clean-merged-branch.js.map