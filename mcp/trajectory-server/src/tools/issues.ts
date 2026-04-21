import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { genId, nowISO } from '../db.js';
import type { Issue, Task } from '../types.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

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

export function issueTools(db: TrajectoryDB): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'issue_create',
      description: 'Create a new issue with an objective and optional goals markdown.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Caller agent name' },
          objective: { type: 'string', description: 'The objective of the issue' },
          goals_md: { type: 'string', description: 'Goals in markdown format' },
        },
        required: ['agent', 'objective'],
      },
    },
    {
      name: 'issue_get',
      description: 'Fetch a single issue by ID.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          issue_id: { type: 'string', description: 'The issue string ID' },
          include_goals: { type: 'boolean', description: 'Whether to include goals_md (default false)' },
        },
        required: ['agent', 'issue_id'],
      },
    },
    {
      name: 'issue_resume',
      description: 'Return an issue with its first actionable pending/failed task.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          issue_id: { type: 'string' },
        },
        required: ['agent', 'issue_id'],
      },
    },
    {
      name: 'issue_close',
      description: 'Close an issue by setting its status to closed.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          issue_id: { type: 'string' },
          post_git_sha: { type: 'string', description: 'Git SHA after issue work is done' },
        },
        required: ['agent', 'issue_id', 'post_git_sha'],
      },
    },
    {
      name: 'issue_get_phase',
      description: 'Return the current workflow phase and task completion counts for an issue.',
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
    issue_create: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      requireArg(args, 'objective');

      const objective = args['objective'] as string;
      const goals_md = (args['goals_md'] as string | undefined) ?? '';
      const now = nowISO();
      const issueId = genId('iss');
      const preGitSha = process.env['PRE_GIT_SHA'] ?? '';

      db.run(
        `INSERT INTO issues (objective, goals_md, goals_md_hash, pre_commit_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?)`,
        [objective, goals_md, '', preGitSha, now, now],
      );

      const rowId = db.get<{ id: number }>(
        `SELECT id FROM issues WHERE rowid = last_insert_rowid()`,
      );

      if (!rowId) {
        throw new Error('issue_create: failed to retrieve inserted row');
      }

      const issue = db.get<Issue>('SELECT * FROM issues WHERE id = ?', [rowId.id]);
      return ok({ ...issue, issue_string_id: issueId });
    }),

    issue_get: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const issueId = requireArg(args, 'issue_id') as string;
      const includeGoals = (args['include_goals'] as boolean | undefined) ?? false;

      const issue = db.get<Issue>('SELECT * FROM issues WHERE id = ?', [issueId]);
      if (!issue) {
        throw new Error(`Not found: ${issueId}`);
      }

      if (!includeGoals) {
        const { goals_md: _, ...rest } = issue;
        void _;
        return ok(rest);
      }
      return ok(issue);
    }),

    issue_resume: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const issueId = requireArg(args, 'issue_id') as string;

      const issue = db.get<Issue>('SELECT * FROM issues WHERE id = ?', [issueId]);
      if (!issue) {
        throw new Error(`Not found: ${issueId}`);
      }

      const task = db.get<Task>(
        `SELECT * FROM tasks
         WHERE issue_id = ? AND status IN ('pending', 'failed')
         ORDER BY branch_id ASC
         LIMIT 1`,
        [issueId],
      );

      return ok({ issue, next_task: task ?? null });
    }),

    issue_close: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const issueId = requireArg(args, 'issue_id') as string;
      requireArg(args, 'post_git_sha');

      const postGitSha = args['post_git_sha'] as string;
      const now = nowISO();

      const issue = db.get<Issue>('SELECT * FROM issues WHERE id = ?', [issueId]);
      if (!issue) {
        throw new Error(`Not found: ${issueId}`);
      }

      db.run(
        `UPDATE issues
         SET status = 'closed', updated_at = ?, closed_at = COALESCE(closed_at, ?), pre_commit_hash = ?
         WHERE id = ?`,
        [now, now, postGitSha, issueId],
      );

      const updated = db.get<Issue>('SELECT * FROM issues WHERE id = ?', [issueId]);
      return ok(updated);
    }),

    issue_get_phase: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const issueId = requireArg(args, 'issue_id') as string;

      const issue = db.get<Issue>('SELECT * FROM issues WHERE id = ?', [issueId]);
      if (!issue) {
        throw new Error(`Not found: ${issueId}`);
      }

      const counts = db.get<{
        tasks_total: number;
        tasks_completed: number;
        tasks_failed: number;
      }>(
        `SELECT
           COUNT(*) as tasks_total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as tasks_completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as tasks_failed
         FROM tasks WHERE issue_id = ?`,
        [issueId],
      ) ?? { tasks_total: 0, tasks_completed: 0, tasks_failed: 0 };

      let phase: 'discussion' | 'blueprint' | 'tasks' | 'done';
      if (issue.status === 'closed') {
        phase = 'done';
      } else if (counts.tasks_total === 0) {
        phase = 'discussion';
      } else if (counts.tasks_completed < counts.tasks_total) {
        phase = 'tasks';
      } else {
        phase = 'blueprint';
      }

      return ok({ phase, counts });
    }),
  };

  return { definitions, handlers };
}
