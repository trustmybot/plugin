/**
 * TypeScript port of scripts/hooks/lib/resolve-repo.sh's repo lookups (GH
 * 1692): a git dir's main checkout, its repos row and the sole registered
 * repo. Every read is tmb_sqlite_ro's ("" on error). Where the .sh needs the
 * sqlite3 CLI on PATH these need a working SQLite (haveSqlite), node:sqlite
 * included.
 */
import { payloadCwd } from '../cmd-analysis/path.js';
import { haveSqlite, realdir, repoPathAbs, sqliteRo, sqlQuote } from './db.js';
import { cdPwd, gitOk, gitOut, isDir } from './git.js';
import { posixDirname, shellPwd } from './project-env.js';
import { statSync } from 'node:fs';

function isFile(path: string): boolean {
  if (path === '') return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  return nl < 0 ? text : text.slice(0, nl);
}

function readable(db: string, env: NodeJS.ProcessEnv): boolean {
  return isFile(db) && haveSqlite(env);
}

const CD_PREFIX = /^[ \t\v\f\r]*cd[ \t\v\f\r]+/;
const CD_TARGETS: readonly RegExp[] = [/^"([^"]+)"/, /^'([^']+)'/, /^([^ \t\v\f\r&;]+)/];
const GIT_C = /git -C ([^ \t\v\f\r]+)/;

/** The target of a line's leading `cd` as the .sh's ERE reads it: the longest alternative, the earlier on a tie. */
function cdTarget(line: string): string | null {
  const prefix = CD_PREFIX.exec(line);
  if (!prefix) return null;
  const rest = line.slice(prefix[0].length);
  let best: RegExpExecArray | null = null;
  for (const re of CD_TARGETS) {
    const m = re.exec(rest);
    if (m && (best === null || m[0].length > best[0].length)) best = m;
  }
  return best === null ? null : best[1];
}

/**
 * tmb_cmd_cwd <command> <input>: the dir a Bash command runs in: the first
 * line's leading `cd <path>`, else the first `git -C <path>` (quotes
 * dropped), else the payload's cwd; a relative path joins the payload's cwd.
 */
export function cmdCwd(cmd: string, input: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = payloadCwd(input, env);
  const lines = cmd.split('\n');
  let cdPath: string | null = null;
  for (const line of lines) {
    cdPath = cdTarget(line);
    if (cdPath !== null) break;
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
  if (cdPath === '') return base;
  if (cdPath.startsWith('/')) return cdPath;
  return `${base.replace(/\/$/, '')}/${cdPath}`;
}

/** tmb_repo_default_branch <root>: origin/HEAD's branch, else main / master / dev, else HEAD's, else main. */
export function repoDefaultBranch(root: string, env: NodeJS.ProcessEnv = process.env): string {
  if (root === '') return '';
  const remote = gitOut(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], env).replace(/^origin\//gm, '');
  if (remote !== '') return remote;
  for (const cand of ['main', 'master', 'dev']) {
    if (gitOk(root, ['show-ref', '--verify', '--quiet', `refs/heads/${cand}`], env)) return cand;
  }
  return gitOut(root, ['symbolic-ref', '--short', 'HEAD'], env) || 'main';
}

/** tmb_repo_git_root <dir>: the main checkout of the repo <dir> (or its nearest existing parent) is in, "" when none. */
export function repoGitRoot(target: string, env: NodeJS.ProcessEnv = process.env): string {
  if (target === '') return '';
  while (!isDir(target) && target !== '/' && target !== '.') target = posixDirname(target);
  if (!isDir(target)) return '';
  const common = gitOut(target, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env);
  if (common !== '') return cdPwd(posixDirname(common), shellPwd(env));
  return gitOut(target, ['rev-parse', '--show-toplevel'], env);
}

/** tmb_repo_name_for_root <db> <root>: the repos row naming <root>, by exact path, else by physical dir. */
export function repoNameForRoot(db: string, root: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!readable(db, env) || root === '') return '';
  const name = firstLine(sqliteRo(db, `SELECT name FROM repos WHERE path = '${sqlQuote(root)}' LIMIT 1;`, env));
  if (name !== '') return name;
  const want = realdir(root);
  for (const row of sqliteRo(db, "SELECT name || '|' || path FROM repos ORDER BY name;", env).split('\n')) {
    if (row === '') continue;
    const bar = row.indexOf('|');
    const rname = bar < 0 ? row : row.slice(0, bar);
    const rpath = bar < 0 ? row : row.slice(bar + 1);
    if (rpath === '') continue;
    if (realdir(repoPathAbs(db, rpath)) === want) return rname;
  }
  return '';
}

/** tmb_repo_resolve <db> <root>: `<target_branch>|<branching_model>|<protected_branches>` of <root>'s row, "" when none. */
export function repoResolve(db: string, root: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!readable(db, env) || root === '') return '';
  const name = repoNameForRoot(db, root, env);
  if (name === '') return '';
  return firstLine(
    sqliteRo(
      db,
      `SELECT COALESCE(target_branch,''), COALESCE(branching_model,''), COALESCE(protected_branches,'') FROM repos WHERE name = '${sqlQuote(name)}' LIMIT 1;`,
      env,
    ),
  );
}

/** tmb_repo_is_registered <db> <root>. */
export function repoIsRegistered(db: string, root: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return readable(db, env) && root !== '' && repoNameForRoot(db, root, env) !== '';
}

/** tmb_repo_single_path <db>: the path of the only repos row, "" unless there is exactly one. */
export function repoSinglePath(db: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!readable(db, env)) return '';
  if (sqliteRo(db, 'SELECT COUNT(*) FROM repos;', env) !== '1') return '';
  return firstLine(sqliteRo(db, 'SELECT path FROM repos LIMIT 1;', env));
}

/** tmb_repo_path_by_name <db> <name>: repos.path of the row named <name>, as stored. */
export function repoPathByName(db: string, name: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!readable(db, env) || name === '') return '';
  return firstLine(sqliteRo(db, `SELECT path FROM repos WHERE name = '${sqlQuote(name)}' LIMIT 1;`, env));
}

/** tmb_repo_resolve_path <db> <name>: the path of the repo named <name>, else of the sole registered repo, else "". */
export function repoResolvePath(db: string, name: string, env: NodeJS.ProcessEnv = process.env): string {
  return (name === '' ? '' : repoPathByName(db, name, env)) || repoSinglePath(db, env);
}

const REMOTES_SQL =
  "COALESCE((SELECT json_group_array(json_object('name', rr.name, 'provider', rr.provider, 'url', rr.url)) FROM (SELECT name, provider, url FROM repo_remotes WHERE repo = r.name ORDER BY is_primary DESC, rowid) rr), '[]')";

/** tmb_repo_remotes <db> <git_root>: the remotes JSON array of <git_root>'s row, else of the sole repo, else "". */
export function repoRemotes(db: string, gitRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!readable(db, env)) return '';
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
