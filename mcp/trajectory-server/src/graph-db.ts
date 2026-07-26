// World-model graph DB wrapper — kuzu native bindings via the official
// 'kuzu' npm package. See ADR 0002.
//
// The graph stores bro's project mental model: Directory nodes today,
// File + Symbol + IMPORTS + CALLS edges in follow-up slices. Lives in
// a sibling file to trajectory.db. Standard DBs use world-model.kuzu; custom
// DB names get a one-to-one <db-basename>.world-model.kuzu graph directory.
//
// kuzu uses synchronous API (querySync / prepareSync) to match the rest
// of the MCP server's sync style (node:sqlite synchronous bindings).
import { createRequire } from 'node:module';
import type { Database, Connection, QueryResult } from 'kuzu';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
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

export class WorldModelGraph {
  private db: Database;
  private conn: Connection;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:' && !existsSync(dirname(dbPath))) {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    // Lazy-require kuzu so a missing/broken native binding fails HERE (caught
    // by index.ts's try/catch → graph=null) rather than at module load, which
    // would crash the whole MCP server. (#271)
    const req = createRequire(import.meta.url);
    const kuzu = req('kuzu') as typeof import('kuzu');
    this.db = WorldModelGraph.openWithRetry(kuzu, dbPath);
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
  ): Database {
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
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
