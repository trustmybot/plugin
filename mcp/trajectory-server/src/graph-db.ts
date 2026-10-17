// World-model graph DB wrapper — kuzu native bindings via the official
// 'kuzu' npm package. See ADR 0002.
//
// The graph stores bro's project mental model: Directory nodes linked by
// CONTAINS, File nodes hung off their directory by HAS_FILE. Lives in
// a sibling file to trajectory.db. Standard DBs use world-model.kuzu; custom
// DB names get a one-to-one <db-basename>.world-model.kuzu graph directory.
//
// kuzu uses synchronous API (querySync / prepareSync) to match the rest
// of the MCP server's sync style (node:sqlite synchronous bindings).
import { createRequire } from 'node:module';
import type { Database, Connection, KuzuValue, PreparedStatement, QueryResult } from 'kuzu';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertSafeProjectWritePath } from './platform.js';
export { resolveGraphDbPath } from './platform.js';

function single(result: QueryResult | QueryResult[]): QueryResult {
  return Array.isArray(result) ? result[0]! : result;
}

// kuzu is single-writer: a concurrent opener (e.g. the SessionStart prescan
// racing the MCP server on a cold world model) loses the write-lock and the
// open throws "Could not set lock on file ...". The loser would otherwise be
// left without a graph connection for the whole session (#590). Detect that
// specific error so the caller can retry once the holder releases.
export function isKuzuLockError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /could not set lock/i.test(msg) || /lock.*world-model\.kuzu/i.test(msg);
}

const KUZU_OPEN_MAX_ATTEMPTS = 8;
const KUZU_OPEN_BASE_DELAY_MS = 50;

function sleepSync(ms: number): void {
  // Synchronous busy-free wait via Atomics so the retry backoff matches the
  // server's sync open path without pulling in async plumbing.
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

export interface DirectoryNode {
  key: string;
  repo: string;
  path: string;
  parent_path: string | null;
  summary: string | null;
  summary_source: string;
  summary_updated_at: string | null;
  file_count: number;
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

const FILE_COLUMNS =
  'f.path, f.repo, f.dir, f.purpose, f.purpose_source, f.content_md5, f.size_bytes, f.last_commit_sha, f.updated_at';

function toFileNode(r: Record<string, unknown>): FileNode {
  return {
    path: String(r['f.path'] ?? ''),
    repo: String(r['f.repo'] ?? ''),
    dir: String(r['f.dir'] ?? ''),
    purpose: String(r['f.purpose'] ?? ''),
    purpose_source: String(r['f.purpose_source'] ?? 'none'),
    content_md5: String(r['f.content_md5'] ?? ''),
    size_bytes: Number(r['f.size_bytes'] ?? 0),
    last_commit_sha: String(r['f.last_commit_sha'] ?? ''),
    updated_at: String(r['f.updated_at'] ?? ''),
  };
}

export interface WorldModelGraphOptions {
  /** Canonical project root for a Codex-bound graph database. */
  readonly trustedProjectRoot?: string;
}

export class WorldModelGraph {
  private db: Database;
  private conn: Connection;

  constructor(dbPath: string, opts: WorldModelGraphOptions = {}) {
    const validateWritePath = (): void => {
      if (dbPath !== ':memory:' && opts.trustedProjectRoot !== undefined) {
        assertSafeProjectWritePath(
          opts.trustedProjectRoot,
          dbPath,
          'World-model database',
          'directory',
        );
      }
    };
    validateWritePath();
    if (dbPath !== ':memory:' && !existsSync(dirname(dbPath))) {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    validateWritePath();
    // Lazy-require kuzu so a missing/broken native binding fails HERE (caught
    // by index.ts's try/catch → graph=null) rather than at module load, which
    // would crash the whole MCP server. (#271)
    const req = createRequire(import.meta.url);
    const kuzu = req('kuzu') as typeof import('kuzu');
    this.db = WorldModelGraph.openWithRetry(
      kuzu,
      dbPath,
      KUZU_OPEN_MAX_ATTEMPTS,
      validateWritePath,
    );
    // A throw after the Database opened (Connection creation or applySchema)
    // would otherwise leak the open db handle — and its file lock — for the
    // process's lifetime, so the next open (this session or another) can never
    // acquire the write-lock. Best-effort close the handle before rethrowing.
    try {
      this.conn = new kuzu.Connection(this.db);
      this.applySchema();
    } catch (e) {
      try {
        this.db.closeSync();
      } catch {
        // Already closed / never fully initialized — nothing to release.
      }
      throw e;
    }
  }

  // Open the kuzu Database, retrying with bounded exponential backoff when the
  // open fails on write-lock contention. A non-lock error (missing binary,
  // corrupt file) is rethrown immediately so it still surfaces as
  // graph_db_open_failed. (#590)
  static openWithRetry(
    kuzu: typeof import('kuzu'),
    dbPath: string,
    maxAttempts = KUZU_OPEN_MAX_ATTEMPTS,
    beforeOpen: () => void = () => {},
  ): Database {
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        beforeOpen();
        return new kuzu.Database(dbPath);
      } catch (e) {
        if (!isKuzuLockError(e)) throw e;
        lastErr = e;
        if (attempt < maxAttempts - 1) {
          sleepSync(KUZU_OPEN_BASE_DELAY_MS * 2 ** attempt);
        }
      }
    }
    throw lastErr;
  }

  private applySchema(): void {
    // kuzu only supports single-column PRIMARY KEY — use a composite-string
    // key '<repo>:<path>' so (repo, path) uniqueness is enforced natively.
    this.conn.querySync(
      `CREATE NODE TABLE IF NOT EXISTS Directory (
        key STRING,
        repo STRING,
        path STRING,
        parent_path STRING,
        summary STRING,
        summary_source STRING,
        summary_updated_at STRING,
        file_count INT64,
        PRIMARY KEY (key)
      )`,
    );
    this.conn.querySync(
      `CREATE REL TABLE IF NOT EXISTS CONTAINS (FROM Directory TO Directory)`,
    );
    this.conn.querySync(
      `CREATE NODE TABLE IF NOT EXISTS File (
        path STRING,
        repo STRING,
        dir STRING,
        purpose STRING,
        purpose_source STRING,
        content_md5 STRING,
        size_bytes INT64,
        last_commit_sha STRING,
        updated_at STRING,
        PRIMARY KEY (path)
      )`,
    );
    this.conn.querySync(
      `CREATE REL TABLE IF NOT EXISTS HAS_FILE (FROM Directory TO File)`,
    );
  }

  tableNames(): string[] {
    const result = single(this.conn.querySync('CALL show_tables() RETURN name'));
    const names: string[] = [];
    try {
      while (result.hasNext()) {
        names.push(String((result.getNextSync() as Record<string, unknown>)['name'] ?? ''));
      }
    } finally {
      result.close();
    }
    return names.sort();
  }

  private rows(query: string, params: Record<string, KuzuValue>): Array<Record<string, unknown>> {
    const stmt = this.conn.prepareSync(query);
    const result = single(this.conn.executeSync(stmt, params));
    const rows: Array<Record<string, unknown>> = [];
    try {
      while (result.hasNext()) rows.push(result.getNextSync() as Record<string, unknown>);
    } finally {
      result.close();
    }
    return rows;
  }

  // Run fn inside one kuzu write transaction; a throw rolls the batch back.
  transaction<T>(fn: () => T): T {
    this.conn.querySync('BEGIN TRANSACTION');
    try {
      const out = fn();
      this.conn.querySync('COMMIT');
      return out;
    } catch (e) {
      try {
        this.conn.querySync('ROLLBACK');
      } catch {
        // The original error wins.
      }
      throw e;
    }
  }

  // File keys are '<repo>/<repo-relative path>'; repo names are directory
  // basenames, so the first '/' always separates the two.
  static fileKey(repo: string, relPath: string): string {
    return `${repo}/${relPath}`;
  }

  static relativeFilePath(node: Pick<FileNode, 'path' | 'repo'>): string {
    return node.path.startsWith(`${node.repo}/`) ? node.path.slice(node.repo.length + 1) : node.path;
  }

  private upsertFileStmt: PreparedStatement | null = null;
  private upsertHasFileStmt: PreparedStatement | null = null;

  upsertFile(node: FileNode): void {
    this.upsertFileStmt ??= this.conn.prepareSync(
      `MERGE (f:File {path: $path})
       SET f.repo = $repo,
           f.dir = $dir,
           f.purpose = $purpose,
           f.purpose_source = $purpose_source,
           f.content_md5 = $content_md5,
           f.size_bytes = $size_bytes,
           f.last_commit_sha = $last_commit_sha,
           f.updated_at = $updated_at`,
    );
    this.conn.executeSync(this.upsertFileStmt, { ...node });
  }

  upsertHasFile(repo: string, dir: string, filePath: string): void {
    this.upsertHasFileStmt ??= this.conn.prepareSync(
      `MATCH (d:Directory {key: $dirKey}), (f:File {path: $filePath})
       MERGE (d)-[:HAS_FILE]->(f)`,
    );
    this.conn.executeSync(this.upsertHasFileStmt, { dirKey: WorldModelGraph.dirKey(repo, dir), filePath });
  }

  allFilesForRepo(repo: string): FileNode[] {
    return this.rows(`MATCH (f:File {repo: $repo}) RETURN ${FILE_COLUMNS}`, { repo }).map(toFileNode);
  }

  filesForDirectory(repo: string, dir: string): FileNode[] {
    return this.rows(
      `MATCH (f:File {repo: $repo, dir: $dir}) RETURN ${FILE_COLUMNS} ORDER BY f.path`,
      { repo, dir },
    ).map(toFileNode);
  }

  filePathsWithDirectory(repo: string): Set<string> {
    const rows = this.rows(
      `MATCH (:Directory)-[:HAS_FILE]->(f:File {repo: $repo}) RETURN f.path`,
      { repo },
    );
    return new Set(rows.map((r) => String(r['f.path'] ?? '')));
  }

  pruneFiles(repo: string, keepPaths: Set<string>): number {
    const stale = this.allFilesForRepo(repo).filter((f) => !keepPaths.has(f.path));
    if (stale.length === 0) return 0;
    const stmt = this.conn.prepareSync(`MATCH (f:File {path: $path}) DETACH DELETE f`);
    for (const f of stale) this.conn.executeSync(stmt, { path: f.path });
    return stale.length;
  }

  fileCoverage(repo: string): FileCoverage {
    const rows = this.rows(
      `MATCH (f:File {repo: $repo})
       RETURN f.purpose_source AS source, COUNT(*) AS n, SUM(CASE WHEN f.purpose <> '' THEN 1 ELSE 0 END) AS with_purpose`,
      { repo },
    );
    const coverage: FileCoverage = { files: 0, with_purpose: 0, by_source: {} };
    for (const r of rows) {
      const n = Number(r['n'] ?? 0);
      coverage.files += n;
      coverage.with_purpose += Number(r['with_purpose'] ?? 0);
      coverage.by_source[String(r['source'] ?? 'none')] = n;
    }
    return coverage;
  }

  keywordSearchFiles(repo: string, query: string, k: number): Array<FileNode & { score: number }> {
    return this.rows(
      `MATCH (f:File {repo: $repo})
       WHERE lower(f.purpose) CONTAINS $needle OR lower(f.path) CONTAINS $needle
       RETURN ${FILE_COLUMNS}
       ORDER BY f.path
       LIMIT $k`,
      { repo, needle: query.toLowerCase(), k },
    ).map((r) => ({ ...toFileNode(r), score: 1.0 }));
  }

  static dirKey(repo: string, path: string): string {
    // JSON tuple so a ':' (or any delimiter) in repo/path can't collide. (#282)
    return JSON.stringify([repo, path]);
  }

  upsertDirectory(node: Omit<DirectoryNode, 'key'>): void {
    const key = WorldModelGraph.dirKey(node.repo, node.path);
    // kuzu MERGE: insert-or-update by primary key.
    const stmt = this.conn.prepareSync(
      `MERGE (d:Directory {key: $key})
       SET d.repo = $repo,
           d.path = $path,
           d.parent_path = $parent_path,
           d.summary = $summary,
           d.summary_source = $summary_source,
           d.summary_updated_at = $summary_updated_at,
           d.file_count = $file_count`,
    );
    this.conn.executeSync(stmt, {
      key,
      repo: node.repo,
      path: node.path,
      parent_path: node.parent_path ?? '',
      summary: node.summary ?? '',
      summary_source: node.summary_source,
      summary_updated_at: node.summary_updated_at ?? '',
      file_count: node.file_count,
    });
  }

  upsertContains(parent: { repo: string; path: string }, child: { repo: string; path: string }): void {
    const parentKey = WorldModelGraph.dirKey(parent.repo, parent.path);
    const childKey = WorldModelGraph.dirKey(child.repo, child.path);
    const stmt = this.conn.prepareSync(
      `MATCH (p:Directory {key: $parentKey}), (c:Directory {key: $childKey})
       MERGE (p)-[:CONTAINS]->(c)`,
    );
    this.conn.executeSync(stmt, { parentKey, childKey });
  }

  pruneDirectories(repo: string, keepKeys: Set<string>): number {
    const all = this.allDirectoriesForRepo(repo);
    const toDelete = all.filter((d) => !keepKeys.has(d.key));
    const stmt = this.conn.prepareSync(
      `MATCH (d:Directory {key: $key}) DETACH DELETE d`,
    );
    for (const d of toDelete) {
      this.conn.executeSync(stmt, { key: d.key });
    }
    return toDelete.length;
  }

  // Re-key every Directory node of oldRepo under newRepo in one kuzu
  // transaction. The primary key embeds the repo (dirKey), so each node is
  // re-created under its new key, its CONTAINS edges re-linked, and the old
  // nodes detach-deleted. Returns the number of nodes moved.
  renameRepo(oldRepo: string, newRepo: string): number {
    const nodes = this.allDirectoriesForRepo(oldRepo);
    if (nodes.length === 0) return 0;
    const edges = this.containsEdgesForRepo(oldRepo);
    const files = this.allFilesForRepo(oldRepo);
    this.conn.querySync('BEGIN TRANSACTION');
    try {
      for (const n of nodes) {
        this.upsertDirectory({
          repo: newRepo,
          path: n.path,
          parent_path: n.parent_path,
          summary: n.summary,
          summary_source: n.summary_source,
          summary_updated_at: n.summary_updated_at,
          file_count: n.file_count,
        });
      }
      for (const e of edges) {
        this.upsertContains({ repo: newRepo, path: e.parent }, { repo: newRepo, path: e.child });
      }
      const delFiles = this.conn.prepareSync(`MATCH (f:File {repo: $repo}) DETACH DELETE f`);
      this.conn.executeSync(delFiles, { repo: oldRepo });
      for (const f of files) {
        const path = WorldModelGraph.fileKey(newRepo, WorldModelGraph.relativeFilePath(f));
        this.upsertFile({ ...f, path, repo: newRepo });
        this.upsertHasFile(newRepo, f.dir, path);
      }
      const del = this.conn.prepareSync(`MATCH (d:Directory {repo: $repo}) DETACH DELETE d`);
      this.conn.executeSync(del, { repo: oldRepo });
      this.conn.querySync('COMMIT');
    } catch (e) {
      try {
        this.conn.querySync('ROLLBACK');
      } catch {
        // The original error wins.
      }
      throw e;
    }
    return nodes.length;
  }

  private containsEdgesForRepo(repo: string): Array<{ parent: string; child: string }> {
    const stmt = this.conn.prepareSync(
      `MATCH (p:Directory {repo: $repo})-[:CONTAINS]->(c:Directory {repo: $repo})
       RETURN p.path, c.path`,
    );
    const result = single(this.conn.executeSync(stmt, { repo }));
    const edges: Array<{ parent: string; child: string }> = [];
    try {
      while (result.hasNext()) {
        const r = result.getNextSync() as Record<string, unknown>;
        edges.push({ parent: String(r['p.path'] ?? ''), child: String(r['c.path'] ?? '') });
      }
    } finally {
      result.close();
    }
    return edges;
  }

  allDirectoriesForRepo(repo: string): DirectoryNode[] {
    const stmt = this.conn.prepareSync(
      `MATCH (d:Directory {repo: $repo})
       RETURN d.key, d.repo, d.path, d.parent_path, d.summary, d.summary_source, d.summary_updated_at, d.file_count`,
    );
    const result = single(this.conn.executeSync(stmt, { repo }));
    const rows: DirectoryNode[] = [];
    try {
    while (result.hasNext()) {
      const r = result.getNextSync() as Record<string, unknown>;
      rows.push({
        key: r['d.key'] as string,
        repo: r['d.repo'] as string,
        path: r['d.path'] as string,
        parent_path: (r['d.parent_path'] == null ? null : String(r['d.parent_path'])),
        summary: ((r['d.summary'] as string) || null),
        summary_source: r['d.summary_source'] as string,
        summary_updated_at: ((r['d.summary_updated_at'] as string) || null),
        file_count: Number(r['d.file_count'] ?? 0),
      });
    }
    } finally {
      result.close();
    }
    return rows;
  }

  keywordSearchDirectories(
    repo: string,
    query: string,
    k: number,
  ): Array<DirectoryNode & { score: number }> {
    // kuzu Cypher: CONTAINS for substring match on summary OR path.
    // Score is constant for now (1.0 per match) since we don't have a real
    // FTS index yet — kuzu's FTS extension lands as a follow-up to this slice.
    // Returns at most k rows.
    const lowered = query.toLowerCase();
    const stmt = this.conn.prepareSync(
      `MATCH (d:Directory {repo: $repo})
       WHERE lower(d.summary) CONTAINS $needle OR lower(d.path) CONTAINS $needle
       RETURN d.key, d.repo, d.path, d.parent_path, d.summary, d.summary_source, d.summary_updated_at, d.file_count
       LIMIT $k`,
    );
    const result = single(this.conn.executeSync(stmt, { repo, needle: lowered, k }));
    const rows: Array<DirectoryNode & { score: number }> = [];
    try {
    while (result.hasNext()) {
      const r = result.getNextSync() as Record<string, unknown>;
      rows.push({
        key: r['d.key'] as string,
        repo: r['d.repo'] as string,
        path: r['d.path'] as string,
        parent_path: (r['d.parent_path'] == null ? null : String(r['d.parent_path'])),
        summary: ((r['d.summary'] as string) || null),
        summary_source: r['d.summary_source'] as string,
        summary_updated_at: ((r['d.summary_updated_at'] as string) || null),
        file_count: Number(r['d.file_count'] ?? 0),
        score: 1.0,
      });
    }
    } finally {
      result.close();
    }
    return rows;
  }

  directoryCount(): number {
    const result = single(this.conn.querySync('MATCH (d:Directory) RETURN COUNT(d) AS n'));
    try {
      if (result.hasNext()) {
        const row = result.getNextSync() as Record<string, unknown>;
        return Number(row['n'] ?? 0);
      }
      return 0;
    } finally {
      result.close();
    }
  }

  close(): void {
    try {
      this.conn.close();
    } catch {
      // already closed
    }
    try {
      this.db.close();
    } catch {
      // already closed
    }
    // Null out native references after close so GC doesn't trigger the kuzu
    // C++ destructor again at process exit (kuzu v0.11 can segfault on
    // double-destruct on Node 24/macOS).
    (this as unknown as Record<string, unknown>)['conn'] = null;
    (this as unknown as Record<string, unknown>)['db'] = null;
  }
}

// Minimum interval between lazy re-open attempts. A persistent lock holder
// must not add per-call open latency, so once an open fails the holder waits
// this long before trying again.
export const GRAPH_REOPEN_THROTTLE_MS = 5000;

export interface GraphHolderOptions {
  open: () => WorldModelGraph;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
  throttleMs?: number;
}

// Mutable, shared-by-reference container for the world-model graph. The open
// can fail on cold-start write-lock contention (#590); before this holder the
// failure was cached for the server's lifetime because index.ts passed the
// resolved graph BY VALUE to registerTools — no later open could reach the
// tools. Tools now read through ensureGraph(), which re-attempts a failed open
// lazily (throttled) so world_model_*/scan_run self-recover once the lock frees
// in the same server process. (GH #1077)
export class GraphHolder {
  graph: WorldModelGraph | null = null;
  openError: string | null = null;
  lastAttemptMs = 0;

  private readonly open: () => WorldModelGraph;
  private readonly now: () => number;
  private readonly log: (entry: Record<string, unknown>) => void;
  private readonly throttleMs: number;
  private lastFailureMessage: string | null = null;
  private attempted = false;

  constructor(opts: GraphHolderOptions) {
    this.open = opts.open;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.throttleMs = opts.throttleMs ?? GRAPH_REOPEN_THROTTLE_MS;
  }

  // Wrap an already-resolved graph (or a null-with-error) as an inert holder
  // that never re-opens — for call sites that already own a graph instance.
  static fixed(graph: WorldModelGraph | null, openError: string | null = null): GraphHolder {
    const holder = new GraphHolder({
      open: () => {
        throw new Error('fixed GraphHolder does not re-open');
      },
    });
    holder.graph = graph;
    holder.openError = openError;
    holder.attempted = true;
    holder.lastAttemptMs = Number.MAX_SAFE_INTEGER;
    return holder;
  }

  // Return a live graph, re-attempting a failed open at most once per throttle
  // window. Returns null while the open keeps failing (or has never succeeded).
  ensureGraph(): WorldModelGraph | null {
    if (this.graph) return this.graph;
    if (this.attempted && this.now() - this.lastAttemptMs < this.throttleMs) {
      return null;
    }
    return this.attemptOpen();
  }

  // Run one open attempt now, ignoring the throttle. Used at startup for the
  // initial open and internally by ensureGraph() past the throttle window.
  attemptOpen(): WorldModelGraph | null {
    this.attempted = true;
    this.lastAttemptMs = this.now();
    try {
      this.graph = this.open();
      const recovered = this.lastFailureMessage !== null;
      this.openError = null;
      this.lastFailureMessage = null;
      this.log({ kind: 'graph_db_open', ...(recovered ? { recovered: true } : {}) });
      return this.graph;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Log only when the message changes, to avoid per-throttle log spam while
      // a lock holder persists.
      if (message !== this.lastFailureMessage) {
        this.log({ kind: 'graph_db_open_failed', error_message: message });
      }
      this.lastFailureMessage = message;
      // Preserve the pre-holder semantics: openError carries the LOCK-error
      // message only (scan_run keys its lock-specific guidance off it); a
      // non-lock failure (missing binding, sandbox) leaves openError null so
      // scan_run falls through to the graph no-op path.
      this.openError = isKuzuLockError(e) ? message : null;
      this.graph = null;
      return null;
    }
  }
}
