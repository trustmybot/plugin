// World model: bro's project map, stored in the trajectory DB. Each directory
// is a wm_directories row linked to its parent by parent_path; each tracked
// file is a wm_files row hung off its directory by dir. FTS5 indexes cover
// directory summaries and file purposes (GH 1632).
import type { TrajectoryDB } from './db.js';
import { toFtsOrQuery, toFtsQuery, withFtsGuard } from './fts-query.js';

export interface DirectoryNode {
  key: string;
  repo: string;
  path: string;
  parent_path: string | null;
  summary: string | null;
  summary_source: string;
  summary_updated_at: string | null;
  file_count: number;
  // README drift (GH 1680); null for structural dirs and non-git roots.
  summary_sha?: string | null;
  commits_behind?: number | null;
  dead_refs?: string[] | null;
}

export interface FileNode {
  path: string;
  repo: string;
  dir: string;
  purpose: string;
  purpose_source: string;
  content_md5: string;
  size_bytes: number;
  last_commit_sha: string;
  updated_at: string;
}

export interface FileCoverage {
  files: number;
  with_purpose: number;
  by_source: Record<string, number>;
}

export type Scored<T> = T & { score: number };

// Which FTS query form produced the keyword hits: every term (AND), or, when
// that matched nothing, any non-stopword term (OR).
export type KeywordMatch = 'all_terms' | 'any_term';

export interface KeywordResult<T> {
  hits: Array<Scored<T>>;
  match: KeywordMatch;
}

const SUBTREE_MAX_DEPTH = 256;

interface DirectoryRow {
  id: number;
  repo: string;
  path: string;
  parent_path: string | null;
  summary: string | null;
  summary_source: string;
  summary_updated_at: string | null;
  file_count: number;
  summary_sha: string | null;
  commits_behind: number | null;
  dead_refs: string | null;
}

interface FileRow {
  id: number;
  repo: string;
  path: string;
  dir: string;
  purpose: string;
  purpose_source: string;
  content_md5: string;
  size_bytes: number;
  last_commit_sha: string;
  updated_at: string;
}

const DIR_COLUMNS =
  'd.id, d.repo, d.path, d.parent_path, d.summary, d.summary_source, d.summary_updated_at, d.file_count, d.summary_sha, d.commits_behind, d.dead_refs';
const FILE_COLUMNS =
  'f.id, f.repo, f.path, f.dir, f.purpose, f.purpose_source, f.content_md5, f.size_bytes, f.last_commit_sha, f.updated_at';

function toDirectoryNode(r: DirectoryRow): DirectoryNode {
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

function parseDeadRefs(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : null;
  } catch {
    return null;
  }
}

function toFileNode(r: FileRow): FileNode {
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
function rankWithFallback<R>(query: string, search: (fts: string) => R[]): { rows: R[]; match: KeywordMatch } {
  const allTerms = toFtsQuery(query);
  const all = withFtsGuard(() => search(allTerms));
  if (all.length > 0) return { rows: all, match: 'all_terms' };
  const any = toFtsOrQuery(query);
  if (any === null || any === allTerms) return { rows: all, match: 'all_terms' };
  return { rows: withFtsGuard(() => search(any)), match: 'any_term' };
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

export class WorldModelGraph {
  constructor(protected readonly db: TrajectoryDB) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  tableNames(): string[] {
    return this.db
      .all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wm\\_%' ESCAPE '\\' ORDER BY name`,
      )
      .map((r) => r.name);
  }

  // File keys are '<repo>/<repo-relative path>'; repo names are directory
  // basenames, so the first '/' always separates the two.
  static fileKey(repo: string, relPath: string): string {
    return `${repo}/${relPath}`;
  }

  static relativeFilePath(node: Pick<FileNode, 'path' | 'repo'>): string {
    return node.path.startsWith(`${node.repo}/`) ? node.path.slice(node.repo.length + 1) : node.path;
  }

  // JSON tuple so a ':' (or any delimiter) in repo/path can't collide. (#282)
  static dirKey(repo: string, path: string): string {
    return JSON.stringify([repo, path]);
  }

  upsertFile(node: FileNode): void {
    this.db.run(
      `INSERT INTO wm_files (repo, path, dir, purpose, purpose_source, content_md5, size_bytes, last_commit_sha, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo, path) DO UPDATE SET
         dir = excluded.dir,
         purpose = excluded.purpose,
         purpose_source = excluded.purpose_source,
         content_md5 = excluded.content_md5,
         size_bytes = excluded.size_bytes,
         last_commit_sha = excluded.last_commit_sha,
         updated_at = excluded.updated_at`,
      [
        node.repo,
        WorldModelGraph.relativeFilePath(node),
        node.dir,
        node.purpose,
        node.purpose_source,
        node.content_md5,
        node.size_bytes,
        node.last_commit_sha,
        node.updated_at,
      ],
    );
  }

  upsertHasFile(repo: string, dir: string, filePath: string): void {
    this.db.run(`UPDATE wm_files SET dir = ? WHERE repo = ? AND path = ? AND dir IS NOT ?`, [
      dir,
      repo,
      WorldModelGraph.relativeFilePath({ repo, path: filePath }),
      dir,
    ]);
  }

  allFilesForRepo(repo: string): FileNode[] {
    return this.db
      .all<FileRow>(`SELECT ${FILE_COLUMNS} FROM wm_files f WHERE f.repo = ? ORDER BY f.path`, [repo])
      .map(toFileNode);
  }

  filesForDirectory(repo: string, dir: string): FileNode[] {
    return this.db
      .all<FileRow>(`SELECT ${FILE_COLUMNS} FROM wm_files f WHERE f.repo = ? AND f.dir = ? ORDER BY f.path`, [
        repo,
        dir,
      ])
      .map(toFileNode);
  }

  filePathsWithDirectory(repo: string): Set<string> {
    const rows = this.db.all<{ path: string }>(
      `SELECT f.path FROM wm_files f
         JOIN wm_directories d ON d.repo = f.repo AND d.path = f.dir
        WHERE f.repo = ?`,
      [repo],
    );
    return new Set(rows.map((r) => WorldModelGraph.fileKey(repo, r.path)));
  }

  pruneFiles(repo: string, keepPaths: Set<string>): number {
    const stale = this.db
      .all<{ id: number; path: string }>(`SELECT id, path FROM wm_files WHERE repo = ?`, [repo])
      .filter((f) => !keepPaths.has(WorldModelGraph.fileKey(repo, f.path)));
    for (const f of stale) this.db.run(`DELETE FROM wm_files WHERE id = ?`, [f.id]);
    return stale.length;
  }

  fileCoverage(repo: string): FileCoverage {
    const rows = this.db.all<{ source: string; n: number; with_purpose: number }>(
      `SELECT purpose_source AS source, COUNT(*) AS n, SUM(CASE WHEN purpose <> '' THEN 1 ELSE 0 END) AS with_purpose
         FROM wm_files WHERE repo = ? GROUP BY purpose_source`,
      [repo],
    );
    const coverage: FileCoverage = { files: 0, with_purpose: 0, by_source: {} };
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
  keywordSearchFiles(repo: string, query: string, k: number): KeywordResult<FileNode> {
    const { rows: ranked, match } = rankWithFallback(query, (fts) =>
      this.db.all<FileRow & { rank: number }>(
        `SELECT ${FILE_COLUMNS}, bm25(wm_files_fts) AS rank
           FROM wm_files_fts JOIN wm_files f ON f.id = wm_files_fts.rowid
          WHERE wm_files_fts MATCH ? AND f.repo = ?
          ORDER BY rank, f.path
          LIMIT ?`,
        [fts, repo, k],
      ),
    );
    const hits = ranked.map((r) => ({ ...toFileNode(r), score: -r.rank }));
    if (hits.length >= k) return { hits, match };
    const seen = new Set(ranked.map((r) => r.id));
    const needle = query.toLowerCase();
    const substring = this.db
      .all<FileRow>(
        `SELECT ${FILE_COLUMNS} FROM wm_files f
          WHERE f.repo = ? AND (instr(lower(f.path), ?) > 0 OR instr(lower(f.purpose), ?) > 0)
          ORDER BY f.path
          LIMIT ?`,
        [repo, needle, needle, k + seen.size],
      )
      .filter((r) => !seen.has(r.id));
    return { hits: [...hits, ...substring.map((r) => ({ ...toFileNode(r), score: 0 }))].slice(0, k), match };
  }

  filesByIds(ids: number[]): Map<number, FileNode> {
    if (ids.length === 0) return new Map();
    const rows = this.db.all<FileRow>(
      `SELECT ${FILE_COLUMNS} FROM wm_files f WHERE f.id IN (${placeholders(ids.length)})`,
      ids,
    );
    return new Map(rows.map((r) => [r.id, toFileNode(r)]));
  }

  upsertDirectory(node: Omit<DirectoryNode, 'key'>): void {
    this.db.run(
      `INSERT INTO wm_directories (repo, path, parent_path, summary, summary_source, summary_updated_at, file_count, summary_sha, commits_behind, dead_refs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo, path) DO UPDATE SET
         parent_path = excluded.parent_path,
         summary = excluded.summary,
         summary_source = excluded.summary_source,
         summary_updated_at = excluded.summary_updated_at,
         file_count = excluded.file_count,
         summary_sha = excluded.summary_sha,
         commits_behind = excluded.commits_behind,
         dead_refs = excluded.dead_refs`,
      [
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
      ],
    );
  }

  upsertContains(parent: { repo: string; path: string }, child: { repo: string; path: string }): void {
    if (parent.repo !== child.repo) return;
    this.db.run(
      `UPDATE wm_directories SET parent_path = ?
        WHERE repo = ? AND path = ? AND parent_path IS NOT ?
          AND EXISTS (SELECT 1 FROM wm_directories p WHERE p.repo = ? AND p.path = ?)`,
      [parent.path, child.repo, child.path, parent.path, parent.repo, parent.path],
    );
  }

  pruneDirectories(repo: string, keepKeys: Set<string>): number {
    const stale = this.db
      .all<{ id: number; path: string }>(`SELECT id, path FROM wm_directories WHERE repo = ?`, [repo])
      .filter((d) => !keepKeys.has(WorldModelGraph.dirKey(repo, d.path)));
    for (const d of stale) this.db.run(`DELETE FROM wm_directories WHERE id = ?`, [d.id]);
    return stale.length;
  }

  // Move every directory and file row of oldRepo under newRepo in one
  // transaction, replacing any leftover rows already filed under newRepo.
  // Row ids survive, so FTS and embedding rows stay attached. Returns the
  // number of directories moved.
  renameRepo(oldRepo: string, newRepo: string): number {
    return this.db.transaction(() => {
      const moved = this.directoryCount(oldRepo);
      if (moved === 0) return 0;
      this.db.run(`DELETE FROM wm_directories WHERE repo = ?`, [newRepo]);
      this.db.run(`DELETE FROM wm_files WHERE repo = ?`, [newRepo]);
      this.db.run(`UPDATE wm_directories SET repo = ? WHERE repo = ?`, [newRepo, oldRepo]);
      this.db.run(`UPDATE wm_files SET repo = ? WHERE repo = ?`, [newRepo, oldRepo]);
      return moved;
    });
  }

  allDirectoriesForRepo(repo: string): DirectoryNode[] {
    return this.db
      .all<DirectoryRow>(`SELECT ${DIR_COLUMNS} FROM wm_directories d WHERE d.repo = ? ORDER BY d.path`, [repo])
      .map(toDirectoryNode);
  }

  // The directory at `path` plus its descendants down to `depth` levels below
  // it (null = the whole subtree), via a recursive CTE over parent_path.
  subtree(repo: string, path: string, depth: number | null): DirectoryNode[] {
    const cap = depth === null ? SUBTREE_MAX_DEPTH : Math.max(0, Math.min(depth, SUBTREE_MAX_DEPTH));
    return this.db
      .all<DirectoryRow>(
        `WITH RECURSIVE sub(id, path, lvl) AS (
           SELECT id, path, 0 FROM wm_directories WHERE repo = ? AND path = ?
           UNION
           SELECT c.id, c.path, s.lvl + 1
             FROM wm_directories c JOIN sub s ON c.parent_path = s.path
            WHERE c.repo = ? AND c.path <> s.path AND s.lvl < ?
         )
         SELECT ${DIR_COLUMNS} FROM wm_directories d
          WHERE d.id IN (SELECT id FROM sub)
          ORDER BY d.path`,
        [repo, path, repo, cap],
      )
      .map(toDirectoryNode);
  }

  // The directory at `path` and each of its ancestors, root first.
  ancestors(repo: string, path: string): DirectoryNode[] {
    return this.db
      .all<DirectoryRow & { lvl: number }>(
        `WITH RECURSIVE up(id, parent_path, lvl) AS (
           SELECT id, parent_path, 0 FROM wm_directories WHERE repo = ? AND path = ?
           UNION
           SELECT p.id, p.parent_path, u.lvl + 1
             FROM wm_directories p JOIN up u ON p.path = u.parent_path
            WHERE p.repo = ? AND u.lvl < ?
         )
         SELECT ${DIR_COLUMNS}, up.lvl FROM up JOIN wm_directories d ON d.id = up.id
          ORDER BY up.lvl DESC`,
        [repo, path, repo, SUBTREE_MAX_DEPTH],
      )
      .map(toDirectoryNode);
  }

  // FTS5 hits over path + summary ranked by bm25 (score = -bm25, higher is
  // better; any-term fallback per rankWithFallback), then case-insensitive
  // path/summary substring hits at score 0.
  keywordSearchDirectories(repo: string, query: string, k: number): KeywordResult<DirectoryNode> {
    const { rows: ranked, match } = rankWithFallback(query, (fts) =>
      this.db.all<DirectoryRow & { rank: number }>(
        `SELECT ${DIR_COLUMNS}, bm25(wm_directories_fts) AS rank
           FROM wm_directories_fts JOIN wm_directories d ON d.id = wm_directories_fts.rowid
          WHERE wm_directories_fts MATCH ? AND d.repo = ?
          ORDER BY rank, d.path
          LIMIT ?`,
        [fts, repo, k],
      ),
    );
    const hits = ranked.map((r) => ({ ...toDirectoryNode(r), score: -r.rank }));
    if (hits.length >= k) return { hits, match };
    const seen = new Set(ranked.map((r) => r.id));
    const needle = query.toLowerCase();
    const substring = this.db
      .all<DirectoryRow>(
        `SELECT ${DIR_COLUMNS} FROM wm_directories d
          WHERE d.repo = ? AND (instr(lower(d.path), ?) > 0 OR instr(lower(coalesce(d.summary, '')), ?) > 0)
          ORDER BY d.path
          LIMIT ?`,
        [repo, needle, needle, k + seen.size],
      )
      .filter((r) => !seen.has(r.id));
    return { hits: [...hits, ...substring.map((r) => ({ ...toDirectoryNode(r), score: 0 }))].slice(0, k), match };
  }

  directoriesByIds(ids: number[]): Map<number, DirectoryNode> {
    if (ids.length === 0) return new Map();
    const rows = this.db.all<DirectoryRow>(
      `SELECT ${DIR_COLUMNS} FROM wm_directories d WHERE d.id IN (${placeholders(ids.length)})`,
      ids,
    );
    return new Map(rows.map((r) => [r.id, toDirectoryNode(r)]));
  }

  directoryCount(repo?: string): number {
    const row =
      repo === undefined
        ? this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM wm_directories`)
        : this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM wm_directories WHERE repo = ?`, [repo]);
    return Number(row?.n ?? 0);
  }

  // The graph borrows the trajectory DB handle; its owner closes it.
  close(): void {}
}

// Shared-by-reference holder for the world-model graph. The graph lives in the
// trajectory DB, so the holder never re-opens; openError stays for callers that
// wrap a failed construction.
export class GraphHolder {
  constructor(
    public graph: WorldModelGraph | null,
    public openError: string | null = null,
  ) {}

  static fixed(graph: WorldModelGraph | null, openError: string | null = null): GraphHolder {
    return new GraphHolder(graph, openError);
  }

  ensureGraph(): WorldModelGraph | null {
    return this.graph;
  }
}
