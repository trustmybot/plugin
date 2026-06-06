// World-model graph DB wrapper — kuzu native bindings via the official
// 'kuzu' npm package. See ADR 0002.
//
// The graph stores bro's project mental model: Directory nodes today,
// File + Symbol + IMPORTS + CALLS edges in follow-up slices. Lives in
// a sibling file to trajectory.db at <project>/.claude/<plugin-name>/world-model.kuzu/.
//
// kuzu uses synchronous API (querySync / prepareSync) to match the rest
// of the MCP server's sync style (node:sqlite synchronous bindings).
import { createRequire } from 'node:module';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
function single(result) {
    return Array.isArray(result) ? result[0] : result;
}
export class WorldModelGraph {
    db;
    conn;
    constructor(dbPath) {
        if (dbPath !== ':memory:' && !existsSync(dirname(dbPath))) {
            mkdirSync(dirname(dbPath), { recursive: true });
        }
        // Lazy-require kuzu so a missing/broken native binding fails HERE (caught
        // by index.ts's try/catch → graph=null) rather than at module load, which
        // would crash the whole MCP server. (#271)
        const req = createRequire(import.meta.url);
        const kuzu = req('kuzu');
        this.db = new kuzu.Database(dbPath);
        this.conn = new kuzu.Connection(this.db);
        this.applySchema();
    }
    applySchema() {
        // kuzu only supports single-column PRIMARY KEY — use a composite-string
        // key '<repo>:<path>' so (repo, path) uniqueness is enforced natively.
        this.conn.querySync(`CREATE NODE TABLE IF NOT EXISTS Directory (
        key STRING,
        repo STRING,
        path STRING,
        parent_path STRING,
        summary STRING,
        summary_source STRING,
        summary_updated_at STRING,
        file_count INT64,
        PRIMARY KEY (key)
      )`);
        this.conn.querySync(`CREATE REL TABLE IF NOT EXISTS CONTAINS (FROM Directory TO Directory)`);
    }
    static dirKey(repo, path) {
        // JSON tuple so a ':' (or any delimiter) in repo/path can't collide. (#282)
        return JSON.stringify([repo, path]);
    }
    upsertDirectory(node) {
        const key = WorldModelGraph.dirKey(node.repo, node.path);
        // kuzu MERGE: insert-or-update by primary key.
        const stmt = this.conn.prepareSync(`MERGE (d:Directory {key: $key})
       SET d.repo = $repo,
           d.path = $path,
           d.parent_path = $parent_path,
           d.summary = $summary,
           d.summary_source = $summary_source,
           d.summary_updated_at = $summary_updated_at,
           d.file_count = $file_count`);
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
    upsertContains(parent, child) {
        const parentKey = WorldModelGraph.dirKey(parent.repo, parent.path);
        const childKey = WorldModelGraph.dirKey(child.repo, child.path);
        const stmt = this.conn.prepareSync(`MATCH (p:Directory {key: $parentKey}), (c:Directory {key: $childKey})
       MERGE (p)-[:CONTAINS]->(c)`);
        this.conn.executeSync(stmt, { parentKey, childKey });
    }
    allDirectoriesForRepo(repo) {
        const stmt = this.conn.prepareSync(`MATCH (d:Directory {repo: $repo})
       RETURN d.key, d.repo, d.path, d.parent_path, d.summary, d.summary_source, d.summary_updated_at, d.file_count`);
        const result = single(this.conn.executeSync(stmt, { repo }));
        const rows = [];
        try {
            while (result.hasNext()) {
                const r = result.getNextSync();
                rows.push({
                    key: r['d.key'],
                    repo: r['d.repo'],
                    path: r['d.path'],
                    parent_path: (r['d.parent_path'] == null ? null : String(r['d.parent_path'])),
                    summary: (r['d.summary'] || null),
                    summary_source: r['d.summary_source'],
                    summary_updated_at: (r['d.summary_updated_at'] || null),
                    file_count: Number(r['d.file_count'] ?? 0),
                });
            }
        }
        finally {
            result.close();
        }
        return rows;
    }
    keywordSearchDirectories(repo, query, k) {
        // kuzu Cypher: CONTAINS for substring match on summary OR path.
        // Score is constant for now (1.0 per match) since we don't have a real
        // FTS index yet — kuzu's FTS extension lands as a follow-up to this slice.
        // Returns at most k rows.
        const lowered = query.toLowerCase();
        const stmt = this.conn.prepareSync(`MATCH (d:Directory {repo: $repo})
       WHERE lower(d.summary) CONTAINS $needle OR lower(d.path) CONTAINS $needle
       RETURN d.key, d.repo, d.path, d.parent_path, d.summary, d.summary_source, d.summary_updated_at, d.file_count
       LIMIT $k`);
        const result = single(this.conn.executeSync(stmt, { repo, needle: lowered, k }));
        const rows = [];
        try {
            while (result.hasNext()) {
                const r = result.getNextSync();
                rows.push({
                    key: r['d.key'],
                    repo: r['d.repo'],
                    path: r['d.path'],
                    parent_path: (r['d.parent_path'] == null ? null : String(r['d.parent_path'])),
                    summary: (r['d.summary'] || null),
                    summary_source: r['d.summary_source'],
                    summary_updated_at: (r['d.summary_updated_at'] || null),
                    file_count: Number(r['d.file_count'] ?? 0),
                    score: 1.0,
                });
            }
        }
        finally {
            result.close();
        }
        return rows;
    }
    directoryCount() {
        const result = single(this.conn.querySync('MATCH (d:Directory) RETURN COUNT(d) AS n'));
        try {
            if (result.hasNext()) {
                const row = result.getNextSync();
                return Number(row['n'] ?? 0);
            }
            return 0;
        }
        finally {
            result.close();
        }
    }
    close() {
        try {
            this.conn.close();
        }
        catch {
            // already closed
        }
        try {
            this.db.close();
        }
        catch {
            // already closed
        }
    }
}
export function resolveGraphDbPath(trajectoryDbPath) {
    if (trajectoryDbPath === ':memory:')
        return ':memory:';
    return trajectoryDbPath.replace(/trajectory\.db$/, 'world-model.kuzu');
}
//# sourceMappingURL=graph-db.js.map