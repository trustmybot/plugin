import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import type { Discussion, Issue, Task } from '../types.js';
import { normalizeAgent, requireRoles } from '../middleware/agent-scope.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

const ALLOWED_KINDS = new Set(['intent', 'question', 'answer', 'decision', 'note']);

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
            enum: ['intent', 'question', 'answer', 'decision', 'note'],
            description: 'Entry kind. Default: note',
          },
          body: { type: 'string', description: 'Markdown body of the discussion entry' },
        },
        required: ['agent', 'issue_id', 'author', 'body'],
      },
    },
    {
      name: 'discussion_list',
      description:
        'Return discussion entries for an issue ordered by created_at ASC. Used by gatekeeper at session resume and by snapshot generation.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          issue_id: { type: 'string' },
          limit: { type: 'number', description: 'Max rows to return. Default 50, max 200.' },
          offset: { type: 'number', description: 'Row offset for pagination. Default 0.' },
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
        },
        required: ['agent', 'issue_id'],
      },
    },
  ];

  const handlers: Record<string, Fn> = {
    discussion_append: requireRoles(
      'discussion_append',
      ['gatekeeper', 'architect', 'pr-reviewer'],
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
        return ok(row);
      }),
    ),

    discussion_list: wrapHandler(async (args) => {
      normalizeAgent(args['agent'] as string | undefined);
      const issueId = requireArg(args, 'issue_id') as string;
      const rawLimit = (args['limit'] as number | undefined) ?? 50;
      const rawOffset = (args['offset'] as number | undefined) ?? 0;
      const limit = Math.min(Math.max(1, rawLimit), 200);
      const offset = Math.max(0, rawOffset);

      const issue = db.get<{ id: number }>('SELECT id FROM issues WHERE id = ?', [issueId]);
      if (!issue) {
        return ok({ discussions: [], warning: 'issue not found' });
      }

      const rows = db.all<Discussion>(
        `SELECT * FROM discussions WHERE issue_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?`,
        [issueId, limit, offset],
      );
      return ok(rows);
    }),

    issue_get_with_discussions: wrapHandler(async (args) => {
      normalizeAgent(args['agent'] as string | undefined);
      const issueId = requireArg(args, 'issue_id') as string;

      const issue = db.get<Issue>('SELECT * FROM issues WHERE id = ?', [issueId]);
      if (!issue) {
        throw new Error(`Not found: issue ${issueId}`);
      }

      const discussions = db.all<Discussion>(
        `SELECT * FROM discussions WHERE issue_id = ? ORDER BY created_at ASC`,
        [issueId],
      );

      const tasks = db.all<Pick<Task, 'id' | 'branch_id' | 'status' | 'title'>>(
        `SELECT id, branch_id, status, title FROM tasks WHERE issue_id = ? ORDER BY branch_id ASC`,
        [issueId],
      );

      return ok({ issue, discussions, tasks });
    }),
  };

  return { definitions, handlers };
}
