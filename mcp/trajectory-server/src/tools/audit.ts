import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

const MAX_CONTENT_BYTES = 1_000_000;

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function requireArg(args: Record<string, unknown>, name: string): unknown {
  if (args[name] === undefined || args[name] === null) {
    throw new Error(`Missing required arg: ${name}`);
  }
  return args[name];
}

function wrapHandler(fn: (args: Record<string, unknown>) => Promise<CallToolResult>): Fn {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return err((e as Error).message);
    }
  };
}

function decodeCursor(cursor: string): { created_at: string; id: number } | null {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as {
      created_at: string;
      id: number;
    };
  } catch {
    return null;
  }
}

function encodeCursor(row: { created_at: string; id: number }): string {
  return Buffer.from(JSON.stringify({ created_at: row.created_at, id: row.id })).toString('base64');
}

// Audit table is event-only — every row is a lifecycle event with
// (event_type, summary, content_json). Tool-call records live in
// debug_trajectory (eval mode), not here.
export function auditTools(db: TrajectoryDB): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'audit_search',
      description:
        'Search audit records via FTS5 on summary + content_json. Returns top-K snippets ranked by BM25 + recency-decay.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          query: {
            type: 'string',
            description:
              'FTS5 MATCH query. Searches across summary and content_json columns.',
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
            description: 'Recency weight 0–1. 0 = pure BM25. 1 = pure recency. Default 0.3.',
          },
        },
        required: ['agent', 'query'],
      },
    },
    {
      name: 'audit_log',
      description:
        'Insert an audit lifecycle event (planning_complete, bro_verification_pass, headless_fallback, etc.). Both event_type and summary are required.',
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

  const handlers: Record<string, Fn> = {
    audit_search: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const query = requireArg(args, 'query') as string;
      const issueId = (args['issue_id'] as string | undefined) ?? null;
      const eventTypes = (args['event_types'] as string[] | undefined) ?? null;
      const k = Math.min(Math.max(1, (args['k'] as number | undefined) ?? 5), 20);
      const alpha = Math.min(1, Math.max(0, (args['recency_alpha'] as number | undefined) ?? 0.3));

      let eventTypeFilter = '';
      let eventTypeParams: unknown[] = [];
      if (eventTypes && eventTypes.length > 0) {
        const placeholders = eventTypes.map(() => '?').join(', ');
        eventTypeFilter = 'AND a.event_type IN (' + placeholders + ')';
        eventTypeParams = eventTypes;
      }

      type MatchRow = {
        id: number;
        issue_id: number;
        branch_id: string | null;
        from_node: string;
        event_type: string;
        summary: string;
        created_at: string;
        snippet: string;
        bm25_score: number;
        age_days: number;
      };

      const countSql =
        'SELECT COUNT(*) AS n FROM audit_fts ' +
        'JOIN audit a ON a.id = audit_fts.rowid ' +
        'WHERE audit_fts MATCH ? ' +
        'AND (? IS NULL OR a.issue_id = CAST(? AS INTEGER)) ' +
        eventTypeFilter;
      const countRow = db.get<{ n: number }>(countSql, [
        query,
        issueId,
        issueId,
        ...eventTypeParams,
      ]);
      const total_matched = countRow?.n ?? 0;

      const searchSql =
        'SELECT a.id, a.issue_id, a.branch_id, a.from_node, a.event_type, a.summary, a.created_at, ' +
        "snippet(audit_fts, 0, '[', ']', '...', 16) AS snippet, " +
        'bm25(audit_fts) AS bm25_score, ' +
        "(julianday('now') - julianday(a.created_at)) AS age_days " +
        'FROM audit_fts ' +
        'JOIN audit a ON a.id = audit_fts.rowid ' +
        'WHERE audit_fts MATCH ? ' +
        'AND (? IS NULL OR a.issue_id = CAST(? AS INTEGER)) ' +
        eventTypeFilter +
        ' ORDER BY (-bm25_score * (1 - ?) + exp(-age_days / 30.0) * ?) DESC LIMIT ?';

      const rows = db.all<MatchRow>(searchSql, [
        query,
        issueId,
        issueId,
        ...eventTypeParams,
        alpha,
        alpha,
        k,
      ]);

      return ok({
        results: rows.map((r) => ({
          id: r.id,
          issue_id: r.issue_id,
          branch_id: r.branch_id,
          from_node: r.from_node,
          event_type: r.event_type,
          summary: r.summary,
          created_at: r.created_at,
          snippet: r.snippet,
          score: -r.bm25_score * (1 - alpha) + Math.exp(-r.age_days / 30) * alpha,
        })),
        total_matched,
      });
    }),

    audit_log: requireRoles('audit_log', ['bro', 'swe', 'pr-reviewer', 'consultant'], wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const issueId = requireArg(args, 'issue_id') as string;
      requireArg(args, 'from_node');

      const fromNode = args['from_node'] as string;
      const branchId = (args['branch_id'] as string | undefined) ?? null;
      const now = nowISO();

      requireArg(args, 'event_type');
      requireArg(args, 'summary');

      const eventType = args['event_type'] as string;
      const summary = args['summary'] as string;

      let contentJson = (args['content_json'] as string | undefined) ?? '{}';

      const byteLength = Buffer.byteLength(contentJson, 'utf8');
      if (byteLength > MAX_CONTENT_BYTES) {
        contentJson = Buffer.from(contentJson, 'utf8').slice(0, MAX_CONTENT_BYTES).toString('utf8');
      }

      db.run(
        `INSERT INTO audit
           (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [issueId, branchId, fromNode, eventType, summary, contentJson, now],
      );

      const row = db.get<Record<string, unknown>>(
        'SELECT * FROM audit WHERE rowid = last_insert_rowid()',
      );
      return ok(row);
    })),

    audit_log_list: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const issueId = requireArg(args, 'issue_id') as string;

      const branchId = (args['branch_id'] as string | undefined) ?? null;
      const limitArg = args['limit'] as number | undefined;
      const cursorArg = args['cursor'] as string | undefined;
      const offset = Math.max(0, (args['offset'] as number | undefined) ?? 0);

      const conditions: string[] = ['issue_id = ?'];
      const baseParams: unknown[] = [issueId];

      if (branchId !== null) {
        conditions.push('branch_id = ?');
        baseParams.push(branchId);
      }

      const whereClause = 'WHERE ' + conditions.join(' AND ');

      if (limitArg === undefined || limitArg === null) {
        const rows = db.all<Record<string, unknown>>(
          'SELECT * FROM audit ' + whereClause + ' ORDER BY id ASC LIMIT 500 OFFSET ?',
          [...baseParams, offset],
        );
        return ok(rows);
      }

      const limit = Math.min(Math.max(1, limitArg), 500);

      let cursorFilter = '';
      let cursorParams: unknown[] = [];
      if (cursorArg) {
        const decoded = decodeCursor(cursorArg);
        if (decoded) {
          cursorFilter = 'AND (created_at > ? OR (created_at = ? AND id > ?))';
          cursorParams = [decoded.created_at, decoded.created_at, decoded.id];
        }
      }

      const sql =
        'SELECT * FROM audit ' +
        whereClause +
        ' ' +
        cursorFilter +
        ' ORDER BY created_at ASC, id ASC LIMIT ?';
      const fetchedRows = db.all<Record<string, unknown>>(sql, [
        ...baseParams,
        ...cursorParams,
        limit + 1,
      ]);

      const hasMore = fetchedRows.length > limit;
      const rows = hasMore ? fetchedRows.slice(0, limit) : fetchedRows;
      const last = rows[rows.length - 1] as { created_at: string; id: number } | undefined;
      const next_cursor = hasMore && last ? encodeCursor(last) : undefined;

      return ok({ rows, next_cursor });
    }),
  };

  return { definitions, handlers };
}
