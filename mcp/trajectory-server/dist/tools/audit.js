import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { embedAndStore, topKByCosine } from '../embeddings/store.js';
const MAX_CONTENT_BYTES = 1_000_000;
function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function err(message) {
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
    };
}
function requireArg(args, name) {
    if (args[name] === undefined || args[name] === null) {
        throw new Error(`Missing required arg: ${name}`);
    }
    return args[name];
}
function wrapHandler(fn) {
    return async (args) => {
        try {
            return await fn(args);
        }
        catch (e) {
            return err(e.message);
        }
    };
}
function decodeCursor(cursor) {
    try {
        return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    }
    catch {
        return null;
    }
}
function encodeCursor(row) {
    return Buffer.from(JSON.stringify({ created_at: row.created_at, id: row.id })).toString('base64');
}
// Audit table is event-only — every row is a lifecycle event with
// (event_type, summary, content_json). Tool-call records live in
// debug_trajectory (eval mode), not here.
export function auditTools(db) {
    const definitions = [
        {
            name: 'audit_search',
            description: 'Search audit records via keyword (FTS5), semantic (cosine), or hybrid (RRF) ranking. Default mode is hybrid. Returns top-K snippets.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    query: {
                        type: 'string',
                        description: 'Search query. For keyword/hybrid: FTS5 MATCH syntax. For semantic: natural language.',
                    },
                    mode: {
                        type: 'string',
                        enum: ['keyword', 'semantic', 'hybrid'],
                        description: 'Search mode. Default: hybrid.',
                    },
                    issue_id: { type: 'string', description: 'Optional — restrict to one issue.' },
                    event_types: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional — restrict to specific event types.',
                    },
                    k: { type: 'number', description: 'Top-K rows to return. Default 5. Max 20.' },
                    recency_alpha: {
                        type: 'number',
                        description: 'Recency weight 0–1 (hybrid/keyword only). Default 0.3.',
                    },
                },
                required: ['agent', 'query'],
            },
        },
        {
            name: 'audit_log',
            description: 'Insert an audit lifecycle event (planning_complete, bro_verification_pass, headless_fallback, etc.). Both event_type and summary are required.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    issue_id: { type: 'string' },
                    branch_id: { type: 'string' },
                    from_node: { type: 'string' },
                    event_type: { type: 'string', description: 'Required. Lifecycle event identifier (e.g. planning_complete).' },
                    summary: { type: 'string', description: 'Required. One-line human-readable summary.' },
                    content_json: { type: 'string', description: 'Optional. JSON string with structured event payload, max 1 MB.' },
                },
                required: ['agent', 'issue_id', 'from_node', 'event_type', 'summary'],
            },
        },
        {
            name: 'audit_log_list',
            description: 'Paginated fetch of audit records for an issue.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    issue_id: { type: 'string' },
                    branch_id: { type: 'string' },
                    limit: { type: 'number', description: 'Max rows to return. Capped at 500. When omitted, returns up to 500 rows (legacy bare-array shape); when provided, response includes next_cursor.' },
                    offset: { type: 'number', description: 'Row offset for pagination (default 0)' },
                    cursor: { type: 'string', description: 'Opaque cursor from a previous response. When provided, overrides offset.' },
                },
                required: ['agent', 'issue_id'],
            },
        },
    ];
    const handlers = {
        audit_search: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const query = requireArg(args, 'query');
            const mode = args['mode'] ?? 'hybrid';
            const issueId = args['issue_id'] ?? null;
            const eventTypes = args['event_types'] ?? null;
            const k = Math.min(Math.max(1, args['k'] ?? 5), 20);
            const alpha = Math.min(1, Math.max(0, args['recency_alpha'] ?? 0.3));
            let eventTypeFilter = '';
            let eventTypeParams = [];
            if (eventTypes && eventTypes.length > 0) {
                const placeholders = eventTypes.map(() => '?').join(', ');
                eventTypeFilter = ' AND a.event_type IN (' + placeholders + ')';
                eventTypeParams = eventTypes;
            }
            const fetchFtsRows = (limitK) => {
                const sql = 'SELECT a.id, a.issue_id, a.branch_id, a.from_node, a.event_type, a.summary, a.created_at, ' +
                    "snippet(audit_fts, 0, '[', ']', '...', 16) AS snippet, " +
                    'bm25(audit_fts) AS bm25_score, ' +
                    "(julianday('now') - julianday(a.created_at)) AS age_days " +
                    'FROM audit_fts ' +
                    'JOIN audit a ON a.id = audit_fts.rowid ' +
                    'WHERE audit_fts MATCH ? ' +
                    'AND (? IS NULL OR a.issue_id = CAST(? AS INTEGER))' +
                    eventTypeFilter +
                    ' ORDER BY bm25(audit_fts) ASC LIMIT ?';
                return db.all(sql, [query, issueId, issueId, ...eventTypeParams, limitK]);
            };
            const fetchRowById = (id) => {
                const sql = 'SELECT a.id, a.issue_id, a.branch_id, a.from_node, a.event_type, a.summary, a.created_at, ' +
                    "'' AS snippet, 0.0 AS bm25_score, " +
                    "(julianday('now') - julianday(a.created_at)) AS age_days " +
                    'FROM audit a WHERE a.id = ? ' +
                    'AND (? IS NULL OR a.issue_id = CAST(? AS INTEGER))' +
                    eventTypeFilter;
                return db.get(sql, [id, issueId, issueId, ...eventTypeParams]);
            };
            if (mode === 'keyword') {
                const countSql = 'SELECT COUNT(*) AS n FROM audit_fts ' +
                    'JOIN audit a ON a.id = audit_fts.rowid ' +
                    'WHERE audit_fts MATCH ? ' +
                    'AND (? IS NULL OR a.issue_id = CAST(? AS INTEGER))' +
                    eventTypeFilter;
                const countRow = db.get(countSql, [query, issueId, issueId, ...eventTypeParams]);
                const total_matched = countRow?.n ?? 0;
                const searchSql = 'SELECT a.id, a.issue_id, a.branch_id, a.from_node, a.event_type, a.summary, a.created_at, ' +
                    "snippet(audit_fts, 0, '[', ']', '...', 16) AS snippet, " +
                    'bm25(audit_fts) AS bm25_score, ' +
                    "(julianday('now') - julianday(a.created_at)) AS age_days " +
                    'FROM audit_fts ' +
                    'JOIN audit a ON a.id = audit_fts.rowid ' +
                    'WHERE audit_fts MATCH ? ' +
                    'AND (? IS NULL OR a.issue_id = CAST(? AS INTEGER))' +
                    eventTypeFilter +
                    ' ORDER BY (-bm25_score * (1 - ?) + exp(-age_days / 30.0) * ?) DESC LIMIT ?';
                const rows = db.all(searchSql, [query, issueId, issueId, ...eventTypeParams, alpha, alpha, k]);
                return ok({
                    results: rows.map((r) => ({
                        id: r.id, issue_id: r.issue_id, branch_id: r.branch_id,
                        from_node: r.from_node, event_type: r.event_type, summary: r.summary,
                        created_at: r.created_at, snippet: r.snippet,
                        score: -r.bm25_score * (1 - alpha) + Math.exp(-r.age_days / 30) * alpha,
                    })),
                    total_matched,
                });
            }
            if (mode === 'semantic') {
                const cosineResults = await topKByCosine(db, 'audit', query, k);
                if (cosineResults.length === 0) {
                    return ok({ results: [], total_matched: 0, warning: 'semantic_unavailable' });
                }
                const results = [];
                for (const cr of cosineResults) {
                    const row = fetchRowById(cr.rowid);
                    if (row) {
                        results.push({
                            id: row.id, issue_id: row.issue_id, branch_id: row.branch_id,
                            from_node: row.from_node, event_type: row.event_type, summary: row.summary,
                            created_at: row.created_at, snippet: row.snippet, score: cr.score,
                        });
                    }
                }
                return ok({ results, total_matched: results.length });
            }
            // hybrid: RRF over FTS5 + cosine + recency-decay
            const RRF_K = 60;
            const ftsRows = fetchFtsRows(k * 4);
            const cosineResults = await topKByCosine(db, 'audit', query, k * 4);
            const semanticAvailable = cosineResults.length > 0;
            const scoreMap = new Map();
            ftsRows.forEach((r, rank) => {
                const rrf = 1 / (RRF_K + rank + 1);
                const existing = scoreMap.get(r.id);
                if (existing) {
                    existing.rrf += rrf;
                }
                else {
                    scoreMap.set(r.id, { rrf, row: r });
                }
            });
            cosineResults.forEach((cr, rank) => {
                const rrf = 1 / (RRF_K + rank + 1);
                const existing = scoreMap.get(cr.rowid);
                if (existing) {
                    existing.rrf += rrf;
                }
                else {
                    const row = fetchRowById(cr.rowid);
                    if (row)
                        scoreMap.set(cr.rowid, { rrf, row });
                }
            });
            const combined = Array.from(scoreMap.values()).map(({ rrf, row }) => ({
                row, score: rrf * (Math.exp(-row.age_days / 30) * alpha + (1 - alpha)),
            }));
            combined.sort((a, b) => b.score - a.score);
            const topRows = combined.slice(0, k);
            const results = topRows.map(({ row, score }) => ({
                id: row.id, issue_id: row.issue_id, branch_id: row.branch_id,
                from_node: row.from_node, event_type: row.event_type, summary: row.summary,
                created_at: row.created_at, snippet: row.snippet, score,
            }));
            const response = { results, total_matched: results.length };
            if (!semanticAvailable)
                response['warning'] = 'semantic_unavailable';
            return ok(response);
        }),
        audit_log: requireRoles('audit_log', ['bro', 'swe', 'pr-reviewer', 'consultant'], wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const issueId = requireArg(args, 'issue_id');
            requireArg(args, 'from_node');
            const fromNode = args['from_node'];
            const branchId = args['branch_id'] ?? null;
            const now = nowISO();
            requireArg(args, 'event_type');
            requireArg(args, 'summary');
            const eventType = args['event_type'];
            const summary = args['summary'];
            const contentJson = args['content_json'] ?? '{}';
            const byteLength = Buffer.byteLength(contentJson, 'utf8');
            if (byteLength > MAX_CONTENT_BYTES) {
                return err(`content_json exceeds 1MB limit (${byteLength} bytes); truncate before calling audit_log`);
            }
            db.run(`INSERT INTO audit
           (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`, [issueId, branchId, fromNode, eventType, summary, contentJson, now]);
            const row = db.get('SELECT * FROM audit WHERE rowid = last_insert_rowid()');
            if (row) {
                const embedText = contentJson !== '{}' ? `${summary} ${contentJson}` : summary;
                embedAndStore(db, 'audit', row.id, embedText).catch((e) => console.error('[embeddings] audit_log embed failed:', e));
            }
            return ok(row);
        })),
        audit_log_list: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const issueId = requireArg(args, 'issue_id');
            const branchId = args['branch_id'] ?? null;
            const limitArg = args['limit'];
            const cursorArg = args['cursor'];
            const offset = Math.max(0, args['offset'] ?? 0);
            const conditions = ['issue_id = ?'];
            const baseParams = [issueId];
            if (branchId !== null) {
                conditions.push('branch_id = ?');
                baseParams.push(branchId);
            }
            const whereClause = 'WHERE ' + conditions.join(' AND ');
            if (limitArg === undefined || limitArg === null) {
                const rows = db.all('SELECT * FROM audit ' + whereClause + ' ORDER BY id ASC LIMIT 500 OFFSET ?', [...baseParams, offset]);
                return ok(rows);
            }
            const limit = Math.min(Math.max(1, limitArg), 500);
            let cursorFilter = '';
            let cursorParams = [];
            if (cursorArg) {
                const decoded = decodeCursor(cursorArg);
                if (decoded) {
                    cursorFilter = 'AND (created_at > ? OR (created_at = ? AND id > ?))';
                    cursorParams = [decoded.created_at, decoded.created_at, decoded.id];
                }
            }
            const sql = 'SELECT * FROM audit ' +
                whereClause +
                ' ' +
                cursorFilter +
                ' ORDER BY created_at ASC, id ASC LIMIT ?';
            const fetchedRows = db.all(sql, [
                ...baseParams,
                ...cursorParams,
                limit + 1,
            ]);
            const hasMore = fetchedRows.length > limit;
            const rows = hasMore ? fetchedRows.slice(0, limit) : fetchedRows;
            const last = rows[rows.length - 1];
            const next_cursor = hasMore && last ? encodeCursor(last) : undefined;
            return ok({ rows, next_cursor });
        }),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=audit.js.map