/**
 * The WorktreeCreate hook (GH 1692): creates (or reuses) `<repo>/.claude/worktrees/<slug>` for the payload's
 * `.branch` and prints its bare absolute path on stdout, exit 0; a failure is
 * a stderr line and exit 1, never JSON. The repo is the one the task on that
 * branch names (tasks.repo's repos.path), else the sole registered repo, else
 * the workspace root; with no trajectory DB, the cwd's git repo. A branch not
 * yet in the repo is created at HEAD.
 * It needs neither jq nor the sqlite3 CLI.
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { branchSlug, dbPath, haveSqlite, sqliteRo, sqlQuote } from './lib/db.js';
import { gitOk } from './lib/git.js';
import { jqCapture, jqInput } from './lib/jq-raw.js';
import { posixDirname, shellPwd } from './lib/project-env.js';
import { repoResolvePath, repoSinglePath } from './lib/repo.js';
export const GATE_NAME = 'worktree-create';
const NO_BRANCH = "tmb worktree-create: WorktreeCreate input has no .branch field — cannot create an isolated worktree; SWE will run non-isolated in the main checkout (supported). If isolation is required, ensure the spawn passes the task's branch.\n";
const fail = (stderr, line) => {
    stderr(line);
    return { stdout: '', code: 1 };
};
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
/** The worktree of <branch> in <repo>: reused, or added on the branch (created at HEAD when missing). */
async function ensureWorktree(repo, worktree, branch, addFailed, created, env, stderr) {
    try {
        mkdirSync(posixDirname(worktree), { recursive: true });
    }
    catch {
        /* git worktree add reports it */
    }
    if (existsSync(`${worktree}/.git`)) {
        stderr(`tmb worktree-create: reusing existing worktree ${worktree} for branch ${branch}\n`);
        return { stdout: `${worktree}\n`, code: 0 };
    }
    if (!await gitOk(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], env)) {
        if (!await gitOk(repo, ['branch', branch, 'HEAD'], env)) {
            return fail(stderr, `tmb worktree-create: could not create branch ${branch} in ${repo}\n`);
        }
        stderr(`tmb worktree-create: auto-created branch ${branch} in ${repo}\n`);
    }
    if (!await gitOk(repo, ['worktree', 'add', worktree, branch], env))
        return fail(stderr, addFailed);
    stderr(created);
    return { stdout: `${worktree}\n`, code: 0 };
}
/** The repo the branch's task names, else the sole registered repo, else the workspace root. */
function branchRepo(db, branch, env) {
    const workspace = posixDirname(posixDirname(posixDirname(db)));
    const safe = sqlQuote(branch);
    const count = sqliteRo(db, `SELECT COUNT(*) FROM tasks WHERE branch_id='${safe}';`, env);
    if ((count || '0') === '0')
        return repoSinglePath(db, env) || workspace;
    const repo = sqliteRo(db, `SELECT COALESCE(repo,'') FROM tasks WHERE branch_id='${safe}' LIMIT 1;`, env);
    return repoResolvePath(db, repo, env) || workspace;
}
export async function worktreeCreateRun(payload, env, stderr) {
    const branch = jqCapture(jqInput(payload), ['branch']);
    if (branch === '')
        return fail(stderr, NO_BRANCH);
    const slug = branchSlug(branch);
    const db = dbPath(env);
    if (db === null || db === '' || !isFile(db)) {
        const cwd = shellPwd(env);
        const worktree = `${cwd}/.claude/worktrees/${slug}`;
        if (!await gitOk(cwd, ['rev-parse', '--is-inside-work-tree'], env)) {
            return fail(stderr, `tmb worktree-create: no trajectory DB and cwd ${cwd} is not a git repo\n`);
        }
        return await ensureWorktree(cwd, worktree, branch, `tmb worktree-create: git worktree add failed for branch ${branch} in ${cwd}\n`, `tmb worktree-create: created worktree ${worktree} for branch ${branch} (no-DB path)\n`, env, stderr);
    }
    if (!haveSqlite(env))
        return fail(stderr, 'tmb worktree-create: sqlite3 unavailable\n');
    const repo = branchRepo(db, branch, env);
    const worktree = `${repo}/.claude/worktrees/${slug}`;
    if (!await gitOk(repo, ['rev-parse', '--is-inside-work-tree'], env)) {
        return fail(stderr, `tmb worktree-create: resolved repo ${repo} is not a git work tree\n`);
    }
    return await ensureWorktree(repo, worktree, branch, `tmb worktree-create: git worktree add failed for branch ${branch} in repo ${repo}\n`, `tmb worktree-create: created worktree ${worktree} for branch ${branch} in repo ${repo}\n`, env, stderr);
}
export const worktreeCreate = async (payload, env) => await worktreeCreateRun(payload, env, (line) => process.stderr.write(line));
//# sourceMappingURL=worktree-create.js.map