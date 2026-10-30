import { dirname, isAbsolute, resolve } from 'node:path';
import { projectRootFromDbPath } from '../tools/containment.js';
// A repos.path as an absolute directory: explicit runtime project roots take
// precedence over legacy DB-layout inference. Without one, preserve the Claude
// project root, custom DB directory, or in-memory working-directory fallback.
export function repoRowPath(db, path) {
    if (isAbsolute(path))
        return path;
    const base = db.trustedProjectRoot ??
        (db.dbPath === ':memory:' ? process.cwd() : projectRootFromDbPath(db.dbPath) ?? dirname(db.dbPath));
    return resolve(base, path);
}
export function resolveSoleRepoPath(db) {
    return resolveSoleRepo(db)?.path;
}
// Issue-scoped repo resolution for the sync path (#155/#146). Resolve the repo
// an issue belongs to, returning its name and on-disk path. The sync caller
// uses `path` as the explicit cwd and reads the repo's remotes through
// repoRemotes(db, name) to pick the gh --repo / glab -R target — never
// process.cwd().
//
// Resolution order:
//   1. An explicit repo name (the issue's repo column) → that repos row.
//   2. The single-repo fallback when exactly one repos row exists.
// Returns null when no repo resolves (multi-repo with no selector, or no repos
// row at all) so the caller raises a named, actionable error.
export function resolveRepoForSync(db, repoName) {
    if (repoName) {
        const row = db.get(`SELECT name, path FROM repos WHERE name = ?`, [repoName]);
        return row ? { name: row.name, path: repoRowPath(db, row.path) } : null;
    }
    const rows = db.all(`SELECT name, path FROM repos`);
    if (rows.length !== 1)
        return null;
    return { name: rows[0].name, path: repoRowPath(db, rows[0].path) };
}
// Path-keyed repo resolution. There is no name-keyed global default — callers
// needing a specific repo pass `tasks.repo` (resolved via `repos.path`). The
// only implicit resolution is the sole-repo fallback: when exactly one repo
// is registered, that repo resolves implicitly. Multi-repo with no explicit
// selector returns undefined and the caller decides.
export function resolveSoleRepo(db, name) {
    if (name) {
        const repoRow = db.get(`SELECT path FROM repos WHERE name = ?`, [name]);
        return repoRow?.path ? { name, path: repoRowPath(db, repoRow.path) } : undefined;
    }
    const repos = db.all(`SELECT name, path FROM repos`);
    return repos.length === 1 ? { name: repos[0].name, path: repoRowPath(db, repos[0].path) } : undefined;
}
//# sourceMappingURL=repo-paths.js.map