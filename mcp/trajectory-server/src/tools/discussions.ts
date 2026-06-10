import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import type { Discussion, Issue, Task } from '../types.js';
import { normalizeAgent, redactIssue, requireRoles } from '../middleware/agent-scope.js';
import { embedAndStore, topKByCosine } from '../embeddings/store.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

const ALLOWED_KINDS = new Set(['intent', 'question', 'answer', 'decision', 'note', 'analysis']);

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

export function discussionTools(db: TrajectoryDB): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'discussion_search',
      description:
        'Search discussions via keyword (FTS5), semantic (cosine), or hybrid (RRF) ranking. Default mode is hybrid. Returns top-K snippets. Use instead of issue_get_with_discussions when you want ranked snippets, not a full dump.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          query: {
            type: 'string',
            description:
              'Search query. For keyword/hybrid: FTS5 MATCH syntax. For semantic: natural language.',
          },
          mode: {
            type: 'string',
            enum: ['keyword', 'semantic', 'hybrid'],
            description: 'Search mode. Default: hybrid (RRF combines FTS5 + cosine + recency-decay).',
          },
          issue_id: { type: 'string', description: 'Optional — restrict to one issue.' },
          kind: {
            type: 'string',
            enum: ['intent', 'note', 'question', 'answer', 'decision', 'analysis'],
            description: 'Optional — restrict to one discussion kind.',
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
      name: 'discussion_append',
      description:
        'Append a discussion entry to an issue. Captures conversational intent, questions, answers, decisions, or notes into the SQLite log.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Caller agent name' },
          issue_id: { type: 'string', description: 'The issue ID (integer as string)' },
          author: { type: 'string', description: 'Author of this entry (agent name or human)' },
          kind: {
            type: 'string',
            enum: ['intent', 'question', 'answer', 'decision', 'note', 'analysis'],
            description: 'Entry kind. Default: note',
          },
          body: { type: 'string', description: 'Markdown body of the discussion entry' },
          verified_human: {
            type: 'boolean',
            description:
              'Reserved for UserPromptSubmit hook captures only. Must be true when author="human"; agents must never set this on self-authored entries. Gate-only — not persisted.',
          },
        },
        required: ['agent', 'issue_id', 'author', 'body'],
      },
    },
    {
      name: 'discussion_list',
      description:
        'Return discussion entries for an issue ordered by created_at ASC. Used by bro at session resume and by snapshot generation.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          issue_id: { type: 'string' },
          limit: { type: 'number', description: 'Max rows to return. Capped at 200. When omitted, returns up to 200 rows (legacy bare-array shape); when provided, response includes next_cursor.' },
          offset: { type: 'number', description: 'Row offset for pagination. Default 0.' },
          cursor: { type: 'string', description: 'Opaque cursor from a previous response. When provided, overrides offset.' },
        },
        required: ['agent', 'issue_id'],
      },
    },
    {
      name: 'issue_get_with_discussions',
      description:
        'Convenience call: returns the issue row + its full discussion list + its task list in one round-trip.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          issue_id: { type: 'string' },
          limit: { type: 'number', description: 'Optional — max discussion rows to return. When omitted, returns all. When provided, response includes next_cursor.' },
          cursor: { type: 'string', description: 'Opaque cursor from a previous response.' },
        },
        required: ['agent', 'issue_id'],
      },
    },
  ];

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
    return Buffer.from(JSON.stringify({ created_at: row.created_at, id: row.id })).toString(
      'base64',
    );
  }

  const handlers: Record<string, Fn> = {
    discussion_search: wrapHandler(async (args) => {
      normalizeAgent(args['agent'] as string | undefined);
      const query = requireArg(args, 'query') as string;
      const mode = (args['mode'] as string | undefined) ?? 'hybrid';
      const issueId = (args['issue_id'] as string | undefined) ?? null;
      const kind = (args['kind'] as string | undefined) ?? null;
      const k = Math.min(Math.max(1, (args['k'] as number | undefined) ?? 5), 20);
      const alpha = Math.min(1, Math.max(0, (args['recency_alpha'] as number | undefined) ?? 0.3));

      type MatchRow = {
        id: number;
        issue_id: number;
        kind: string;
        author: string;
        created_at: string;
        snippet: string;
        bm25_score: number;
        age_days: number;
      };

      type ResultRow = {
        id: number;
        issue_id: number;
        kind: string;
        author: string;
        created_at: string;
        snippet: string;
        score: number;
      };

      const fetchFtsRows = (limitK: number): MatchRow[] =>
        db.all<MatchRow>(
          `SELECT
             d.id, d.issue_id, d.kind, d.author, d.created_at,
             snippet(discussions_fts, 0, '[', ']', '...', 16) AS snippet,
             bm25(discussions_fts) AS bm25_score,
             (julianday('now') - julianday(d.created_at)) AS age_days
           FROM discussions_fts
           JOIN discussions d ON d.id = discussions_fts.rowid
           WHERE discussions_fts MATCH ?
             AND (? IS NULL OR d.issue_id = CAST(? AS INTEGER))
             AND (? IS NULL OR d.kind = ?)
           ORDER BY bm25(discussions_fts) ASC
           LIMIT ?`,
          [query, issueId, issueId, kind, kind, limitK],
        );

      const fetchRowById = (id: number): MatchRow | undefined =>
        db.get<MatchRow>(
          `SELECT d.id, d.issue_id, d.kind, d.author, d.created_at,
                  '' AS snippet,
                  0.0 AS bm25_score,
                  (julianday('now') - julianday(d.created_at)) AS age_days
           FROM discussions d
           WHERE d.id = ?
             AND (? IS NULL OR d.issue_id = CAST(? AS INTEGER))
             AND (? IS NULL OR d.kind = ?)`,
          [id, issueId, issueId, kind, kind],
        );

      if (mode === 'keyword') {
        const countRow = db.get<{ n: number }>(
          `SELECT COUNT(*) AS n
           FROM discussions_fts
           JOIN discussions d ON d.id = discussions_fts.rowid
           WHERE discussions_fts MATCH ?
             AND (? IS NULL OR d.issue_id = CAST(? AS INTEGER))
             AND (? IS NULL OR d.kind = ?)`,
          [query, issueId, issueId, kind, kind],
        );
        const total_matched = countRow?.n ?? 0;
        const rows = db.all<MatchRow>(
          `SELECT
             d.id, d.issue_id, d.kind, d.author, d.created_at,
             snippet(discussions_fts, 0, '[', ']', '...', 16) AS snippet,
             bm25(discussions_fts) AS bm25_score,
             (julianday('now') - julianday(d.created_at)) AS age_days
           FROM discussions_fts
           JOIN discussions d ON d.id = discussions_fts.rowid
           WHERE discussions_fts MATCH ?
             AND (? IS NULL OR d.issue_id = CAST(? AS INTEGER))
             AND (? IS NULL OR d.kind = ?)
           ORDER BY (-bm25_score * (1 - ?) + exp(-age_days / 30.0) * ?) DESC
           LIMIT ?`,
          [query, issueId, issueId, kind, kind, alpha, alpha, k],
        );
        return ok({
          results: rows.map((r) => ({
            id: r.id,
            issue_id: r.issue_id,
            kind: r.kind,
            author: r.author,
            created_at: r.created_at,
            snippet: r.snippet,
            score: -r.bm25_score * (1 - alpha) + Math.exp(-r.age_days / 30) * alpha,
          })),
          total_matched,
        });
      }

      if (mode === 'semantic') {
        const cosineResults = await topKByCosine(db, 'discussions', query, k);
        if (cosineResults.length === 0) {
          return ok({ results: [], total_matched: 0, warning: 'semantic_unavailable' });
        }
        const results: ResultRow[] = [];
        for (const cr of cosineResults) {
          const row = fetchRowById(cr.rowid);
          if (row) {
            results.push({
              id: row.id,
              issue_id: row.issue_id,
              kind: row.kind,
              author: row.author,
              created_at: row.created_at,
              snippet: row.snippet,
              score: cr.score,
            });
          }
        }
        return ok({ results, total_matched: results.length });
      }

      // hybrid: RRF over FTS5 + cosine + recency-decay
      const RRF_K = 60;
      const ftsRows = fetchFtsRows(k * 4);
      const cosineResults = await topKByCosine(db, 'discussions', query, k * 4);
      const semanticAvailable = cosineResults.length > 0;

      const scoreMap = new Map<number, { rrf: number; row: MatchRow }>();

      ftsRows.forEach((r, rank) => {
        const rrf = 1 / (RRF_K + rank + 1);
        const existing = scoreMap.get(r.id);
        if (existing) {
          existing.rrf += rrf;
        } else {
          scoreMap.set(r.id, { rrf, row: r });
        }
      });

      cosineResults.forEach((cr, rank) => {
        const rrf = 1 / (RRF_K + rank + 1);
        const existing = scoreMap.get(cr.rowid);
        if (existing) {
          existing.rrf += rrf;
        } else {
          const row = fetchRowById(cr.rowid);
          if (row) scoreMap.set(cr.rowid, { rrf, row });
        }
      });

      const combined = Array.from(scoreMap.values()).map(({ rrf, row }) => {
        const ageDays = row.age_days;
        const decayed = rrf * (Math.exp(-ageDays / 30) * alpha + (1 - alpha));
        return { row, score: decayed };
      });
      combined.sort((a, b) => b.score - a.score);
      const topRows = combined.slice(0, k);

      const results: ResultRow[] = topRows.map(({ row, score }) => ({
        id: row.id,
        issue_id: row.issue_id,
        kind: row.kind,
        author: row.author,
        created_at: row.created_at,
        snippet: row.snippet,
        score,
      }));

      const response: Record<string, unknown> = { results, total_matched: results.length };
      if (!semanticAvailable) response['warning'] = 'semantic_unavailable';
      return ok(response);
    }),

    discussion_append: requireRoles(
      'discussion_append',
      ['bro', 'swe', 'pr-reviewer', 'consultant'],
      wrapHandler(async (args) => {
        normalizeAgent(args['agent'] as string | undefined);
        const issueId = requireArg(args, 'issue_id') as string;
        const author = requireArg(args, 'author') as string;
        const body = requireArg(args, 'body') as string;
        const kind = (args['kind'] as string | undefined) ?? 'note';

        if (!ALLOWED_KINDS.has(kind)) {
          return err(
            `Invalid kind: "${kind}". Allowed values: ${[...ALLOWED_KINDS].join(', ')}`,
          );
        }

        if (!author.trim()) {
          throw new Error('author must be a non-empty string');
        }

        const verifiedHuman = Boolean(args['verified_human']);

        if (author === 'human' && !verifiedHuman) {
          throw new Error(
            'precondition_failed: discussion_append with author="human" requires verified_human=true. This flag must only be set by legitimate UserPromptSubmit hook captures, never by agent self-attribution. Use author="bro" with body citing the human verbatim instead.',
          );
        }

        const issue = db.get<Issue>('SELECT id FROM issues WHERE id = ?', [issueId]);
        if (!issue) {
          throw new Error(`Not found: issue ${issueId}`);
        }

        const now = nowISO();
        db.run(
          `INSERT INTO discussions (issue_id, author, kind, body, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [issueId, author, kind, body, now],
        );

        const row = db.get<Discussion>(
          'SELECT * FROM discussions WHERE rowid = last_insert_rowid()',
        );

        if (row) {
          embedAndStore(db, 'discussions', row.id, body).catch((e) =>
            console.error('[embeddings] discussion_append embed failed:', e),
          );
        }

        return ok(row);
      }),
    ),

    discussion_list: wrapHandler(async (args) => {
      normalizeAgent(args['agent'] as string | undefined);
      const issueId = requireArg(args, 'issue_id') as string;
      const limitArg = args['limit'] as number | undefined;
      const cursorArg = args['cursor'] as string | undefined;
      const rawOffset = (args['offset'] as number | undefined) ?? 0;

      const issue = db.get<{ id: number }>('SELECT id FROM issues WHERE id = ?', [issueId]);
      if (!issue) {
        return ok({ discussions: [], warning: 'issue not found' });
      }

      if (limitArg === undefined || limitArg === null) {
        const offset = Math.max(0, rawOffset);
        const rows = db.all<Discussion>(
          `SELECT * FROM discussions WHERE issue_id = ? ORDER BY created_at ASC LIMIT 200 OFFSET ?`,
          [issueId, offset],
        );
        return ok(rows);
      }

      const limit = Math.min(Math.max(1, limitArg), 200);
      let cursorFilter = '';
      let cursorParams: unknown[] = [];

      if (cursorArg) {
        const decoded = decodeCursor(cursorArg);
        if (decoded) {
          cursorFilter =
            'AND (created_at > ? OR (created_at = ? AND id > ?))';
          cursorParams = [decoded.created_at, decoded.created_at, decoded.id];
        }
      }

      const sql =
        'SELECT * FROM discussions WHERE issue_id = ? ' +
        cursorFilter +
        ' ORDER BY created_at ASC, id ASC LIMIT ?';
      const fetchedRows = db.all<Discussion>(sql, [issueId, ...cursorParams, limit + 1]);

      const hasMore = fetchedRows.length > limit;
      const rows = hasMore ? fetchedRows.slice(0, limit) : fetchedRows;
      const last = rows[rows.length - 1];
      const next_cursor = hasMore && last ? encodeCursor(last) : undefined;

      return ok({ rows, next_cursor });
    }),

    issue_get_with_discussions: wrapHandler(async (args) => {
      const agent = normalizeAgent(args['agent'] as string | undefined);
      const issueId = requireArg(args, 'issue_id') as string;
      const limitArg = args['limit'] as number | undefined;
      const cursorArg = args['cursor'] as string | undefined;

      const issue = db.get<Issue>('SELECT * FROM issues WHERE id = ?', [issueId]);
      if (!issue) {
        throw new Error(`Not found: issue ${issueId}`);
      }

      const tasks = db.all<Pick<Task, 'id' | 'branch_id' | 'status' | 'title'>>(
        `SELECT id, branch_id, status, title FROM tasks WHERE issue_id = ? ORDER BY branch_id ASC`,
        [issueId],
      );

      const redactedIssue = redactIssue(issue, agent);

      if (limitArg === undefined || limitArg === null) {
        const discussions = db.all<Discussion>(
          `SELECT * FROM discussions WHERE issue_id = ? ORDER BY created_at ASC`,
          [issueId],
        );
        return ok({ issue: redactedIssue, discussions, tasks });
      }

      const limit = Math.min(Math.max(1, limitArg), 200);
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
        'SELECT * FROM discussions WHERE issue_id = ? ' +
        cursorFilter +
        ' ORDER BY created_at ASC, id ASC LIMIT ?';
      const fetchedDisc = db.all<Discussion>(sql, [issueId, ...cursorParams, limit + 1]);

      const hasMore = fetchedDisc.length > limit;
      const discussions = hasMore ? fetchedDisc.slice(0, limit) : fetchedDisc;
      const last = discussions[discussions.length - 1];
      const next_cursor = hasMore && last ? encodeCursor(last) : undefined;

      return ok({ issue: redactedIssue, discussions, tasks, next_cursor });
    }),
  };

  return { definitions, handlers };
}
