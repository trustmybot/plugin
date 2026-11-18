/**
 * The repo lookups (GH 1692): a git dir's main checkout, its repos row and
 * the sole registered repo. Every read is a read-only query ("" on error) and
 * needs a working SQLite (haveSqlite), node:sqlite or the sqlite3 CLI.
 */
import { payloadCwd } from '../cmd-analysis/path.js';
import { isRepoMode } from '../../tools/config.js';
import { GATE_READ_ERROR, haveSqlite, realdir, repoPathAbs, sqliteRo, sqlQuote } from './db.js';
import { gateWorkflowMode } from './git-refs.js';
import { cdPwd, gitOk, gitOut, isDir } from './git.js';
import { posixDirname, shellPwd } from './project-env.js';
import { statSync } from 'node:fs';
import { basename } from 'node:path';
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
const CD_PREFIX = /^[ \t\v\f\r]*cd[ \t\v\f\r]+/;
const CD_TARGETS = [/^"([^"]+)"/, /^'([^']+)'/, /^([^ \t\v\f\r&;]+)/];
const GIT_C = /git -C ([^ \t\v\f\r]+)/;
/** The target of a line's leading `cd` as a POSIX ERE reads it: the longest alternative, the earlier on a tie. */
function cdTarget(line) {
    const prefix = CD_PREFIX.exec(line);
    if (!prefix)
        return null;
    const rest = line.slice(prefix[0].length);
    let best = null;
    for (const re of CD_TARGETS) {
        const m = re.exec(rest);
        if (m && (best === null || m[0].length > best[0].length))
            best = m;
    }
    return best === null ? null : best[1];
}
/**
 * tmb_cmd_cwd <command> <input>: the dir a Bash command runs in: the first
 * line's leading `cd <path>`, else the first `git -C <path>` (quotes
 * dropped), else the payload's cwd; a relative path joins the payload's cwd.
 */
export function cmdCwd(cmd, input, env = process.env) {
    const base = payloadCwd(input, env);
    const lines = cmd.split('\n');
    let cdPath = null;
    for (const line of lines) {
        cdPath = cdTarget(line);
        if (cdPath !== null)
            break;
    }
    if (cdPath === null) {
        cdPath = '';
        for (const line of lines) {
            const m = GIT_C.exec(line);
            if (m) {
                cdPath = m[1].replace(/['"]/g, '');
                break;
            }
        }
    }
    if (cdPath === '')
        return base;
    if (cdPath.startsWith('/'))
        return cdPath;
    return `${base.replace(/\/$/, '')}/${cdPath}`;
}
/**
 * The dir a forge CLI (gh, glab) in a Bash command started in, which may no
 * longer exist: a `cd <path>` leading the first non-blank line, else the
 * payload's cwd. No other text is read: a later line may run after the CLI or
 * sit in a heredoc body, and these CLIs ignore `git -C`.
 */
export function forgeCommandDir(cmd, input, env = process.env) {
    const base = payloadCwd(input, env);
    const leading = cmd.split('\n').find((line) => line.trim() !== '');
    const cdPath = leading === undefined ? null : cdTarget(leading);
    if (cdPath === null)
        return base;
    return cdPath.startsWith('/') ? cdPath : `${base.replace(/\/$/, '')}/${cdPath}`;
}
/**
 * The checkout holding forgeCommandDir or its nearest existing parent, else
 * that dir: a removed worktree resolves to its main checkout, a submodule or
 * a live linked worktree to itself, so origin is the command's own remote.
 */
export async function forgeRepoDir(cmd, input, env = process.env) {
    let dir = forgeCommandDir(cmd, input, env);
    if (dir === '')
        return '';
    while (!isDir(dir) && dir !== '/' && dir !== '.')
        dir = posixDirname(dir);
    return await gitOut(dir, ['rev-parse', '--show-toplevel'], env) || dir;
}
/** tmb_repo_default_branch <root>: origin/HEAD's branch, else main / master / dev, else HEAD's, else main. */
export async function repoDefaultBranch(root, env = process.env) {
    if (root === '')
        return '';
    const remote = (await gitOut(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], env)).replace(/^origin\//gm, '');
    if (remote !== '')
        return remote;
    for (const cand of ['main', 'master', 'dev']) {
        if (await gitOk(root, ['show-ref', '--verify', '--quiet', `refs/heads/${cand}`], env))
            return cand;
    }
    return await gitOut(root, ['symbolic-ref', '--short', 'HEAD'], env) || 'main';
}
/**
 * The checkout a common git dir not named `.git` serves, from its own
 * `core.worktree` (relative to the common dir), "" when unset: a submodule's
 * common dir sits at `<super>/.git/modules/<name>`, so its parent is no checkout.
 */
async function commonDirWorktree(target, common, env) {
    const worktree = await gitOut(target, ['--git-dir', common, 'config', '--local', '--get', 'core.worktree'], env);
    if (worktree === '')
        return '';
    return cdPwd(worktree.startsWith('/') ? worktree : `${common}/${worktree}`, shellPwd(env));
}
/** tmb_repo_git_root <dir>: the main checkout of the repo <dir> (or its nearest existing parent) is in, "" when none. */
export async function repoGitRoot(target, env = process.env) {
    if (target === '')
        return '';
    while (!isDir(target) && target !== '/' && target !== '.')
        target = posixDirname(target);
    if (!isDir(target))
        return '';
    const common = await gitOut(target, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env);
    if (common !== '') {
        if (basename(common) === '.git')
            return cdPwd(posixDirname(common), shellPwd(env));
        const checkout = await commonDirWorktree(target, common, env);
        if (checkout !== '')
            return checkout;
    }
    return await gitOut(target, ['rev-parse', '--show-toplevel'], env);
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
/** The repos row naming <root> and its stored mode: "" for NULL, an unregistered <root> or an unreadable DB. */
function storedRepoMode(db, root, env) {
    if (!readable(db, env) || root === '')
        return { name: '', stored: '' };
    const name = repoNameForRoot(db, root, env);
    if (name === '')
        return { name, stored: '' };
    const stored = firstLine(sqliteRo(db, `SELECT COALESCE(mode,'') FROM repos WHERE name = '${sqlQuote(name)}' LIMIT 1;`, env));
    return { name, stored };
}
function effectiveMode(db, stored, env) {
    if (isRepoMode(stored))
        return stored;
    const project = gateWorkflowMode(db, env);
    return project === GATE_READ_ERROR ? 'truest' : project;
}
/**
 * Whether <root>'s repo stands the git guards and the push gate down (GH 3279).
 * An allowlist: only a stored exempt does; NULL, truest, agile, an unknown
 * value, an unregistered repo or a DB that does not read keep them on.
 */
export function isExempt(db, root, env = process.env) {
    return storedRepoMode(db, root, env).stored === 'exempt';
}
/** <root>'s effective mode: its repos.mode, else the project's workflow_mode (unset or unreadable reads as truest). */
export function repoMode(db, root, env = process.env) {
    return effectiveMode(db, storedRepoMode(db, root, env).stored, env);
}
/** `(repo <name>, mode <mode>)`, the suffix a git deny names its repo's rules by; an unregistered root goes by its dir name. */
export function repoModeLabel(db, root, env = process.env) {
    const { name, stored } = storedRepoMode(db, root, env);
    return `(repo ${name || basename(root)}, mode ${effectiveMode(db, stored, env)})`;
}
/** <reason> with <root>'s repoModeLabel appended, for a git deny to name the rules it applied. */
export function withRepoMode(reason, db, root, env = process.env) {
    return `${reason.replace(/\s+$/, '')} ${repoModeLabel(db, root, env)}`;
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
/** tmb_repo_path_by_name <db> <name>: repos.path of the row named <name>, as stored. */
export function repoPathByName(db, name, env = process.env) {
    if (!readable(db, env) || name === '')
        return '';
    return firstLine(sqliteRo(db, `SELECT path FROM repos WHERE name = '${sqlQuote(name)}' LIMIT 1;`, env));
}
/** tmb_repo_resolve_path <db> <name>: the path of the repo named <name>, else of the sole registered repo, else "". */
export function repoResolvePath(db, name, env = process.env) {
    return (name === '' ? '' : repoPathByName(db, name, env)) || repoSinglePath(db, env);
}
/** A forge repo spec or remote URL (`OWNER/REPO`, `HOST/OWNER/REPO`, `scheme://[user@]host[:port]/path`, `[user@]host:path`), split into host and path. */
function forgeLocation(text) {
    let s = text.trim().toLowerCase();
    const scheme = /^[a-z][a-z0-9+.-]*:\/\//.exec(s);
    let host = '';
    if (scheme) {
        s = s.slice(scheme[0].length).replace(/^[^@/]*@/, '');
        const slash = s.indexOf('/');
        host = (slash < 0 ? s : s.slice(0, slash)).replace(/:[0-9]*$/, '');
        s = slash < 0 ? '' : s.slice(slash);
    }
    else {
        const scp = /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)/.exec(s);
        if (scp) {
            host = scp[1];
            s = s.slice(scp[0].length);
        }
    }
    const path = s.replace(/\/+$/, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
    return { host, path };
}
/**
 * <spec> (a `gh --repo` / `glab -R` value) names the repo <remoteUrl> points
 * at: equal paths, and equal hosts when the spec carries one. A bare path of
 * three or more segments is read both as a namespace path and as HOST/PATH.
 */
export function forgeSpecMatchesRemote(spec, remoteUrl) {
    const remote = forgeLocation(remoteUrl);
    const want = forgeLocation(spec);
    if (remote.path === '' || want.path === '')
        return false;
    if (want.host !== '')
        return want.host === remote.host && want.path === remote.path;
    if (want.path === remote.path)
        return true;
    const slash = want.path.indexOf('/');
    return want.path.split('/').length >= 3 && want.path.slice(0, slash) === remote.host && want.path.slice(slash + 1) === remote.path;
}
/**
 * The root of the registered repo whose `origin` remote <spec> names, "" when
 * none does: <ownRoot> (the statement's own git root) when it matches, else the
 * first match by repos.name.
 */
export async function repoRootForForgeSpec(db, spec, ownRoot, env = process.env) {
    if (!readable(db, env) || spec === '')
        return '';
    const own = ownRoot === '' ? '' : realdir(ownRoot);
    let first = '';
    for (const row of sqliteRo(db, "SELECT path FROM repos WHERE path IS NOT NULL AND path != '' ORDER BY name;", env).split('\n')) {
        if (row === '')
            continue;
        const root = repoPathAbs(db, row);
        if (!isDir(root))
            continue;
        if (!forgeSpecMatchesRemote(spec, await gitOut(root, ['remote', 'get-url', 'origin'], env)))
            continue;
        if (own !== '' && realdir(root) === own)
            return root;
        first ||= root;
    }
    return first;
}
const REMOTES_SQL = "COALESCE((SELECT json_group_array(json_object('name', rr.name, 'provider', rr.provider, 'url', rr.url)) FROM (SELECT name, provider, url FROM repo_remotes WHERE repo = r.name ORDER BY is_primary DESC, rowid) rr), '[]')";
/** tmb_repo_remotes <db> <git_root>: the remotes JSON array of <git_root>'s row, else of the sole repo, else "". */
export function repoRemotes(db, gitRoot, env = process.env) {
    if (!readable(db, env))
        return '';
    const name = gitRoot === '' ? '' : repoNameForRoot(db, gitRoot, env);
    let out = '';
    if (name !== '') {
        out = firstLine(sqliteRo(db, `SELECT ${REMOTES_SQL} FROM repos r WHERE r.name = '${sqlQuote(name)}' LIMIT 1;`, env));
    }
    if (out === '' && sqliteRo(db, 'SELECT COUNT(*) FROM repos;', env) === '1') {
        out = firstLine(sqliteRo(db, `SELECT ${REMOTES_SQL} FROM repos r LIMIT 1;`, env));
    }
    return out;
}
//# sourceMappingURL=repo.js.map