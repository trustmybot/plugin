import { toFtsOrQuery, toFtsQuery, withFtsGuard } from './fts-query.js';
const SUBTREE_MAX_DEPTH = 256;
const DIR_COLUMNS = 'd.id, d.repo, d.path, d.parent_path, d.summary, d.summary_source, d.summary_updated_at, d.file_count, d.summary_sha, d.commits_behind, d.dead_refs';
const FILE_COLUMNS = 'f.id, f.repo, f.path, f.dir, f.purpose, f.purpose_source, f.content_md5, f.size_bytes, f.last_commit_sha, f.updated_at';
function toDirectoryNode(r) {
    return {
        key: WorldModelGraph.dirKey(r.repo, r.path),
        repo: r.repo,
        path: r.path,
        parent_path: r.parent_path,
        summary: r.summary || null,
        summary_source: r.summary_source,
        summary_updated_at: r.summary_updated_at || null,
        file_count: Number(r.file_count),
        summary_sha: r.summary_sha ?? null,
        commits_behind: r.commits_behind === null || r.commits_behind === undefined ? null : Number(r.commits_behind),
        dead_refs: parseDeadRefs(r.dead_refs),
    };
}
function parseDeadRefs(raw) {
    if (raw === null || raw === undefined)
        return null;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : null;
    }
    catch {
        return null;
    }
}
function toFileNode(r) {
    return {
        path: WorldModelGraph.fileKey(r.repo, r.path),
        repo: r.repo,
        dir: r.dir,
        purpose: r.purpose,
        purpose_source: r.purpose_source,
        content_md5: r.content_md5,
        size_bytes: Number(r.size_bytes),
        last_commit_sha: r.last_commit_sha,
        updated_at: r.updated_at,
    };
}
// bm25-ranked FTS rows for the all-terms query; when that matches nothing, the
// same search over any non-stopword term.
function rankWithFallback(query, search) {
    const allTerms = toFtsQuery(query);
    const all = withFtsGuard(() => search(allTerms));
    if (all.length > 0)
        return { rows: all, match: 'all_terms' };
    const any = toFtsOrQuery(query);
    if (any === null || any === allTerms)
        return { rows: all, match: 'all_terms' };
    return { rows: withFtsGuard(() => search(any)), match: 'any_term' };
}
function placeholders(n) {
    return Array.from({ length: n }, () => '?').join(', ');
}
export class WorldModelGraph {
    db;
    constructor(db) {
        this.db = db;
    }
    transaction(fn) {
        return this.db.transaction(fn);
    }
    tableNames() {
        return this.db
            .all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wm\\_%' ESCAPE '\\' ORDER BY name`)
            .map((r) => r.name);
    }
    // File keys are '<repo>/<repo-relative path>'; repo names are directory
    // basenames, so the first '/' always separates the two.
    static fileKey(repo, relPath) {
        return `${repo}/${relPath}`;
    }
    static relativeFilePath(node) {
        return node.path.startsWith(`${node.repo}/`) ? node.path.slice(node.repo.length + 1) : node.path;
    }
    // JSON tuple so a ':' (or any delimiter) in repo/path can't collide. (#282)
    static dirKey(repo, path) {
        return JSON.stringify([repo, path]);
    }
    upsertFile(node) {
        this.db.run(`INSERT INTO wm_files (repo, path, dir, purpose, purpose_source, content_md5, size_bytes, last_commit_sha, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo, path) DO UPDATE SET
         dir = excluded.dir,
         purpose = excluded.purpose,
         purpose_source = excluded.purpose_source,
         content_md5 = excluded.content_md5,
         size_bytes = excluded.size_bytes,
         last_commit_sha = excluded.last_commit_sha,
         updated_at = excluded.updated_at`, [
            node.repo,
            WorldModelGraph.relativeFilePath(node),
            node.dir,
            node.purpose,
            node.purpose_source,
            node.content_md5,
            node.size_bytes,
            node.last_commit_sha,
            node.updated_at,
        ]);
    }
    upsertHasFile(repo, dir, filePath) {
        this.db.run(`UPDATE wm_files SET dir = ? WHERE repo = ? AND path = ? AND dir IS NOT ?`, [
            dir,
            repo,
            WorldModelGraph.relativeFilePath({ repo, path: filePath }),
            dir,
        ]);
    }
    allFilesForRepo(repo) {
        return this.db
            .all(`SELECT ${FILE_COLUMNS} FROM wm_files f WHERE f.repo = ? ORDER BY f.path`, [repo])
            .map(toFileNode);
    }
    filesForDirectory(repo, dir) {
        return this.db
            .all(`SELECT ${FILE_COLUMNS} FROM wm_files f WHERE f.repo = ? AND f.dir = ? ORDER BY f.path`, [
            repo,
            dir,
        ])
            .map(toFileNode);
    }
    filePathsWithDirectory(repo) {
        const rows = this.db.all(`SELECT f.path FROM wm_files f
         JOIN wm_directories d ON d.repo = f.repo AND d.path = f.dir
        WHERE f.repo = ?`, [repo]);
        return new Set(rows.map((r) => WorldModelGraph.fileKey(repo, r.path)));
    }
    pruneFiles(repo, keepPaths) {
        const stale = this.db
            .all(`SELECT id, path FROM wm_files WHERE repo = ?`, [repo])
            .filter((f) => !keepPaths.has(WorldModelGraph.fileKey(repo, f.path)));
        for (const f of stale)
            this.db.run(`DELETE FROM wm_files WHERE id = ?`, [f.id]);
        return stale.length;
    }
    fileCoverage(repo) {
        const rows = this.db.all(`SELECT purpose_source AS source, COUNT(*) AS n, SUM(CASE WHEN purpose <> '' THEN 1 ELSE 0 END) AS with_purpose
         FROM wm_files WHERE repo = ? GROUP BY purpose_source`, [repo]);
        const coverage = { files: 0, with_purpose: 0, by_source: {} };
        for (const r of rows) {
            const n = Number(r.n);
            coverage.files += n;
            coverage.with_purpose += Number(r.with_purpose ?? 0);
            coverage.by_source[r.source] = n;
        }
        return coverage;
    }
    // FTS5 hits over path + purpose ranked by bm25 (score = -bm25, higher is
    // better; any-term fallback per rankWithFallback), then case-insensitive
    // path/purpose substring hits at score 0.
    keywordSearchFiles(repo, query, k) {
        const { rows: ranked, match } = rankWithFallback(query, (fts) => this.db.all(`SELECT ${FILE_COLUMNS}, bm25(wm_files_fts) AS rank
           FROM wm_files_fts JOIN wm_files f ON f.id = wm_files_fts.rowid
          WHERE wm_files_fts MATCH ? AND f.repo = ?
          ORDER BY rank, f.path
          LIMIT ?`, [fts, repo, k]));
        const hits = ranked.map((r) => ({ ...toFileNode(r), score: -r.rank }));
        if (hits.length >= k)
            return { hits, match };
        const seen = new Set(ranked.map((r) => r.id));
        const needle = query.toLowerCase();
        const substring = this.db
            .all(`SELECT ${FILE_COLUMNS} FROM wm_files f
          WHERE f.repo = ? AND (instr(lower(f.path), ?) > 0 OR instr(lower(f.purpose), ?) > 0)
          ORDER BY f.path
          LIMIT ?`, [repo, needle, needle, k + seen.size])
            .filter((r) => !seen.has(r.id));
        return { hits: [...hits, ...substring.map((r) => ({ ...toFileNode(r), score: 0 }))].slice(0, k), match };
    }
    filesByIds(ids) {
        if (ids.length === 0)
            return new Map();
        const rows = this.db.all(`SELECT ${FILE_COLUMNS} FROM wm_files f WHERE f.id IN (${placeholders(ids.length)})`, ids);
        return new Map(rows.map((r) => [r.id, toFileNode(r)]));
    }
    upsertDirectory(node) {
        this.db.run(`INSERT INTO wm_directories (repo, path, parent_path, summary, summary_source, summary_updated_at, file_count, summary_sha, commits_behind, dead_refs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo, path) DO UPDATE SET
         parent_path = excluded.parent_path,
         summary = excluded.summary,
         summary_source = excluded.summary_source,
         summary_updated_at = excluded.summary_updated_at,
         file_count = excluded.file_count,
         summary_sha = excluded.summary_sha,
         commits_behind = excluded.commits_behind,
         dead_refs = excluded.dead_refs`, [
            node.repo,
            node.path,
            node.parent_path,
            node.summary,
            node.summary_source,
            node.summary_updated_at,
            node.file_count,
            node.summary_sha ?? null,
            node.commits_behind ?? null,
            node.dead_refs ? JSON.stringify(node.dead_refs) : null,
        ]);
    }
    upsertContains(parent, child) {
        if (parent.repo !== child.repo)
            return;
        this.db.run(`UPDATE wm_directories SET parent_path = ?
        WHERE repo = ? AND path = ? AND parent_path IS NOT ?
          AND EXISTS (SELECT 1 FROM wm_directories p WHERE p.repo = ? AND p.path = ?)`, [parent.path, child.repo, child.path, parent.path, parent.repo, parent.path]);
    }
    pruneDirectories(repo, keepKeys) {
        const stale = this.db
            .all(`SELECT id, path FROM wm_directories WHERE repo = ?`, [repo])
            .filter((d) => !keepKeys.has(WorldModelGraph.dirKey(repo, d.path)));
        for (const d of stale)
            this.db.run(`DELETE FROM wm_directories WHERE id = ?`, [d.id]);
        return stale.length;
    }
    // Move every directory and file row of oldRepo under newRepo in one
    // transaction, replacing any leftover rows already filed under newRepo.
    // Row ids survive, so FTS and embedding rows stay attached. Returns the
    // number of directories moved.
    renameRepo(oldRepo, newRepo) {
        return this.db.transaction(() => {
            const moved = this.directoryCount(oldRepo);
            if (moved === 0)
                return 0;
            this.db.run(`DELETE FROM wm_directories WHERE repo = ?`, [newRepo]);
            this.db.run(`DELETE FROM wm_files WHERE repo = ?`, [newRepo]);
            this.db.run(`UPDATE wm_directories SET repo = ? WHERE repo = ?`, [newRepo, oldRepo]);
            this.db.run(`UPDATE wm_files SET repo = ? WHERE repo = ?`, [newRepo, oldRepo]);
            return moved;
        });
    }
    allDirectoriesForRepo(repo) {
        return this.db
            .all(`SELECT ${DIR_COLUMNS} FROM wm_directories d WHERE d.repo = ? ORDER BY d.path`, [repo])
            .map(toDirectoryNode);
    }
    // The directory at `path` plus its descendants down to `depth` levels below
    // it (null = the whole subtree), via a recursive CTE over parent_path.
    subtree(repo, path, depth) {
        const cap = depth === null ? SUBTREE_MAX_DEPTH : Math.max(0, Math.min(depth, SUBTREE_MAX_DEPTH));
        return this.db
            .all(`WITH RECURSIVE sub(id, path, lvl) AS (
           SELECT id, path, 0 FROM wm_directories WHERE repo = ? AND path = ?
           UNION
           SELECT c.id, c.path, s.lvl + 1
             FROM wm_directories c JOIN sub s ON c.parent_path = s.path
            WHERE c.repo = ? AND c.path <> s.path AND s.lvl < ?
         )
         SELECT ${DIR_COLUMNS} FROM wm_directories d
          WHERE d.id IN (SELECT id FROM sub)
          ORDER BY d.path`, [repo, path, repo, cap])
            .map(toDirectoryNode);
    }
    // The directory at `path` and each of its ancestors, root first.
    ancestors(repo, path) {
        return this.db
            .all(`WITH RECURSIVE up(id, parent_path, lvl) AS (
           SELECT id, parent_path, 0 FROM wm_directories WHERE repo = ? AND path = ?
           UNION
           SELECT p.id, p.parent_path, u.lvl + 1
             FROM wm_directories p JOIN up u ON p.path = u.parent_path
            WHERE p.repo = ? AND u.lvl < ?
         )
         SELECT ${DIR_COLUMNS}, up.lvl FROM up JOIN wm_directories d ON d.id = up.id
          ORDER BY up.lvl DESC`, [repo, path, repo, SUBTREE_MAX_DEPTH])
            .map(toDirectoryNode);
    }
    // FTS5 hits over path + summary ranked by bm25 (score = -bm25, higher is
    // better; any-term fallback per rankWithFallback), then case-insensitive
    // path/summary substring hits at score 0.
    keywordSearchDirectories(repo, query, k) {
        const { rows: ranked, match } = rankWithFallback(query, (fts) => this.db.all(`SELECT ${DIR_COLUMNS}, bm25(wm_directories_fts) AS rank
           FROM wm_directories_fts JOIN wm_directories d ON d.id = wm_directories_fts.rowid
          WHERE wm_directories_fts MATCH ? AND d.repo = ?
          ORDER BY rank, d.path
          LIMIT ?`, [fts, repo, k]));
        const hits = ranked.map((r) => ({ ...toDirectoryNode(r), score: -r.rank }));
        if (hits.length >= k)
            return { hits, match };
        const seen = new Set(ranked.map((r) => r.id));
        const needle = query.toLowerCase();
        const substring = this.db
            .all(`SELECT ${DIR_COLUMNS} FROM wm_directories d
          WHERE d.repo = ? AND (instr(lower(d.path), ?) > 0 OR instr(lower(coalesce(d.summary, '')), ?) > 0)
          ORDER BY d.path
          LIMIT ?`, [repo, needle, needle, k + seen.size])
            .filter((r) => !seen.has(r.id));
        return { hits: [...hits, ...substring.map((r) => ({ ...toDirectoryNode(r), score: 0 }))].slice(0, k), match };
    }
    directoriesByIds(ids) {
        if (ids.length === 0)
            return new Map();
        const rows = this.db.all(`SELECT ${DIR_COLUMNS} FROM wm_directories d WHERE d.id IN (${placeholders(ids.length)})`, ids);
        return new Map(rows.map((r) => [r.id, toDirectoryNode(r)]));
    }
    directoryCount(repo) {
        const row = repo === undefined
            ? this.db.get(`SELECT COUNT(*) AS n FROM wm_directories`)
            : this.db.get(`SELECT COUNT(*) AS n FROM wm_directories WHERE repo = ?`, [repo]);
        return Number(row?.n ?? 0);
    }
    // The graph borrows the trajectory DB handle; its owner closes it.
    close() { }
}
// Shared-by-reference holder for the world-model graph. The graph lives in the
// trajectory DB, so the holder never re-opens; openError stays for callers that
// wrap a failed construction.
export class GraphHolder {
    graph;
    openError;
    constructor(graph, openError = null) {
        this.graph = graph;
        this.openError = openError;
    }
    static fixed(graph, openError = null) {
        return new GraphHolder(graph, openError);
    }
    ensureGraph() {
        return this.graph;
    }
}
//# sourceMappingURL=graph.js.map