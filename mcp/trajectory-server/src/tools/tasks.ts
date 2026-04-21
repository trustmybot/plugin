import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { genId, nowISO } from '../db.js';
import type { Task, TaskInput } from '../types.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

const VALID_STATUSES = new Set([
  'pending',
  'running',
  'needs_validation',
  'completed',
  'failed',
  'escalated',
]);

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

export function taskTools(db: TrajectoryDB): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'task_create_batch',
      description: 'Insert multiple tasks for an issue in a single transaction.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          issue_id: { type: 'string' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                branch_id: { type: 'string' },
                parent_branch_id: { type: 'string' },
                title: { type: 'string' },
                description: { type: 'string' },
                tools_required: { type: 'array', items: { type: 'string' } },
                skills_required: { type: 'array', items: { type: 'string' } },
                success_criteria: { type: 'string' },
                execution_plan_md: { type: 'string' },
              },
              required: ['branch_id', 'description', 'success_criteria'],
            },
          },
        },
        required: ['agent', 'issue_id', 'tasks'],
      },
    },
    {
      name: 'task_get',
      description: 'Fetch a single task by ID.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          task_id: { type: 'string' },
        },
        required: ['agent', 'task_id'],
      },
    },
    {
      name: 'task_update_status',
      description: 'Update the status of a task.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          task_id: { type: 'string' },
          status: {
            type: 'string',
            enum: ['pending', 'running', 'needs_validation', 'completed', 'failed', 'escalated'],
          },
          attempts: { type: 'number' },
        },
        required: ['agent', 'task_id', 'status'],
      },
    },
    {
      name: 'task_first_actionable',
      description: 'Return the lowest branch_id task with status pending or failed for an issue.',
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
    task_create_batch: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const issueId = requireArg(args, 'issue_id') as string;
      requireArg(args, 'tasks');

      const taskInputs = args['tasks'] as TaskInput[];

      if (!Array.isArray(taskInputs) || taskInputs.length === 0) {
        return ok([]);
      }

      const inserted = db.transaction(() => {
        const results: Task[] = [];
        const now = nowISO();

        for (const t of taskInputs) {
          if (!t.branch_id) throw new Error('Missing required arg: branch_id');
          if (!t.description) throw new Error('Missing required arg: description');
          if (!t.success_criteria) throw new Error('Missing required arg: success_criteria');

          void genId('task');

          db.run(
            `INSERT INTO tasks
               (issue_id, branch_id, parent_branch_id, title, description,
                tools_required, skills_required, success_criteria,
                status, attempts, execution_plan_md, qa_results, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, '', ?, ?)`,
            [
              issueId,
              t.branch_id,
              t.parent_branch_id ?? null,
              t.title ?? '',
              t.description,
              JSON.stringify(t.tools_required ?? []),
              JSON.stringify(t.skills_required ?? []),
              t.success_criteria,
              t.execution_plan_md ?? '',
              now,
              now,
            ],
          );

          const row = db.get<Task>(
            'SELECT * FROM tasks WHERE rowid = last_insert_rowid()',
          );
          if (row) results.push(row);
        }

        return results;
      });

      return ok(inserted);
    }),

    task_get: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const taskId = requireArg(args, 'task_id') as string;

      const task = db.get<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
      if (!task) {
        throw new Error(`Not found: ${taskId}`);
      }
      return ok(task);
    }),

    task_update_status: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const taskId = requireArg(args, 'task_id') as string;
      const status = requireArg(args, 'status') as string;

      if (!VALID_STATUSES.has(status)) {
        throw new Error(
          `Invalid status: ${status}. Valid values: ${[...VALID_STATUSES].join(', ')}`,
        );
      }

      const task = db.get<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
      if (!task) {
        throw new Error(`Not found: ${taskId}`);
      }

      const now = nowISO();
      const attempts = args['attempts'] !== undefined ? (args['attempts'] as number) : task.attempts;
      const completedAt = status === 'completed' ? now : task.completed_at;

      db.run(
        `UPDATE tasks SET status = ?, attempts = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
        [status, attempts, now, completedAt, taskId],
      );

      const updated = db.get<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
      return ok(updated);
    }),

    task_first_actionable: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const issueId = requireArg(args, 'issue_id') as string;

      const task = db.get<Task>(
        `SELECT * FROM tasks
         WHERE issue_id = ? AND status IN ('pending', 'failed')
         ORDER BY branch_id ASC
         LIMIT 1`,
        [issueId],
      );

      return ok(task ?? null);
    }),
  };

  return { definitions, handlers };
}
