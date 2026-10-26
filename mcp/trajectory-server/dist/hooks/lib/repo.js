/**
 * TypeScript port of scripts/hooks/lib/resolve-repo.sh's repo lookups (GH
 * 1692): a git dir's main checkout, its repos row and the sole registered
 * repo. Every read is tmb_sqlite_ro's ("" on error). Where the .sh needs the
 * sqlite3 CLI on PATH these need a working SQLite (haveSqlite), node:sqlite
 * included.
 */
import { haveSqlite, realdir, repoPathAbs, sqliteRo, sqlQuote } from './db.js';
import { cdPwd, gitOk, gitOut, isDir } from './git.js';
import { posixDirname, shellPwd } from './project-env.js';
import { statSync } from 'node:fs';
function isFile(path) {
    if (path === '')
        return false;
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
function firstLine(text) {
    const nl = text.indexOf('\n');
    return nl < 0 ? text : text.slice(0, nl);
}
function readable(db, env) {
    return isFile(db) && haveSqlite(env);
}
/** tmb_repo_default_branch <root>: origin/HEAD's branch, else main / master / dev, else HEAD's, else main. */
export function repoDefaultBranch(root, env = process.env) {
    if (root === '')
        return '';
    const remote = gitOut(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], env).replace(/^origin\//gm, '');
    if (remote !== '')
        return remote;
    for (const cand of ['main', 'master', 'dev']) {
        if (gitOk(root, ['show-ref', '--verify', '--quiet', `refs/heads/${cand}`], env))
            return cand;
    }
    return gitOut(root, ['symbolic-ref', '--short', 'HEAD'], env) || 'main';
}
/** tmb_repo_git_root <dir>: the main checkout of the repo <dir> (or its nearest existing parent) is in, "" when none. */
export function repoGitRoot(target, env = process.env) {
    if (target === '')
        return '';
    while (!isDir(target) && target !== '/' && target !== '.')
        target = posixDirname(target);
    if (!isDir(target))
        return '';
    const common = gitOut(target, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env);
    if (common !== '')
        return cdPwd(posixDirname(common), shellPwd(env));
    return gitOut(target, ['rev-parse', '--show-toplevel'], env);
}
/** tmb_repo_name_for_root <db> <root>: the repos row naming <root>, by exact path, else by physical dir. */
export function repoNameForRoot(db, root, env = process.env) {
    if (!readable(db, env) || root === '')
        return '';
    const name = firstLine(sqliteRo(db, `SELECT name FROM repos WHERE path = '${sqlQuote(root)}' LIMIT 1;`, env));
    if (name !== '')
        return name;
    const want = realdir(root);
    for (const row of sqliteRo(db, "SELECT name || '|' || path FROM repos ORDER BY name;", env).split('\n')) {
        if (row === '')
            continue;
        const bar = row.indexOf('|');
        const rname = bar < 0 ? row : row.slice(0, bar);
        const rpath = bar < 0 ? row : row.slice(bar + 1);
        if (rpath === '')
            continue;
        if (realdir(repoPathAbs(db, rpath)) === want)
            return rname;
    }
    return '';
}
/** tmb_repo_resolve <db> <root>: `<target_branch>|<branching_model>|<protected_branches>` of <root>'s row, "" when none. */
export function repoResolve(db, root, env = process.env) {
    if (!readable(db, env) || root === '')
        return '';
    const name = repoNameForRoot(db, root, env);
    if (name === '')
        return '';
    return firstLine(sqliteRo(db, `SELECT COALESCE(target_branch,''), COALESCE(branching_model,''), COALESCE(protected_branches,'') FROM repos WHERE name = '${sqlQuote(name)}' LIMIT 1;`, env));
}
/** tmb_repo_is_registered <db> <root>. */
export function repoIsRegistered(db, root, env = process.env) {
    return readable(db, env) && root !== '' && repoNameForRoot(db, root, env) !== '';
}
/** tmb_repo_single_path <db>: the path of the only repos row, "" unless there is exactly one. */
export function repoSinglePath(db, env = process.env) {
    if (!readable(db, env))
        return '';
    if (sqliteRo(db, 'SELECT COUNT(*) FROM repos;', env) !== '1')
        return '';
    return firstLine(sqliteRo(db, 'SELECT path FROM repos LIMIT 1;', env));
}
//# sourceMappingURL=repo.js.map