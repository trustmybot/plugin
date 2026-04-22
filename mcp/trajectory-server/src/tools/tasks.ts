import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { genId, nowISO } from '../db.js';
import type { Task, TaskInput } from '../types.js';
import { requireRoles } from '../middleware/agent-scope.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

export const BRANCH_ID_RE =
  /^(feat|fix|refactor|chore|docs|test|perf|build|ci|style|revert)\/[a-z0-9][a-z0-9-]{0,62}$/;

function validateBranchId(branchId: string): void {
  if (!BRANCH_ID_RE.test(branchId)) {
    throw new Error(
      `Invalid branch_id "${branchId}". Must match git-convention format: <type>/<slug> ` +
        `where <type> is one of feat|fix|refactor|chore|docs|test|perf|build|ci|style|revert ` +
        `and <slug> is lowercase alnum + hyphens (max 63 chars). Examples: feat/user-login, fix/auth-crash.`,
    );
  }
}

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
      description:
        'Insert multiple tasks for an issue in a single transaction. branch_id MUST be a git-convention name (feat/foo, fix/bar, refactor/baz, etc.); it doubles as the working git branch.',
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
                spec_body_md: {
                  type: 'string',
                  description:
                    'Full markdown body SWE reads. Required for any task that will be SWE-executed. Max 64000 chars.',
                },
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
      description: 'Update the status of a task. Optionally records a commit SHA in the same transaction, ensuring status and SHA are persisted atomically.',
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
          commit_sha: {
            type: 'string',
            description: 'Optional git commit SHA (full 40-char or short 7+ char hex). Persisted atomically with the status update.',
          },
        },
        required: ['agent', 'task_id', 'status'],
      },
    },
    {
      name: 'task_first_actionable',
      description:
        'Returns the lex-lowest pending/failed task for an issue (groups by type prefix: chore<ci<docs<feat<...). branch_id ordering is lexicographic over git-convention names.',
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
      name: 'task_set_spec_path',
      description: 'Bind a task to its on-disk markdown spec file. Validates that the path matches docs/trustmybot/tasks/<type>-<slug>.md convention and that the filename stem contains the sanitized branch_id.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          issue_id: { type: 'string' },
          branch_id: { type: 'string', description: 'Git-convention branch name (e.g. feat/my-task)' },
          spec_path: { type: 'string', description: 'Relative path like docs/trustmybot/tasks/feat-my-task.md' },
        },
        required: ['agent', 'issue_id', 'branch_id', 'spec_path'],
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
          validateBranchId(t.branch_id);
          if (t.parent_branch_id != null) validateBranchId(t.parent_branch_id);
          if (!t.description) throw new Error('Missing required arg: description');
          if (!t.success_criteria) throw new Error('Missing required arg: success_criteria');
          if (t.spec_body_md !== undefined) {
            if (typeof t.spec_body_md !== 'string') {
              throw new Error(`spec_body_md must be a string, got ${typeof t.spec_body_md}`);
            }
            if (t.spec_body_md.length > 64000) {
              throw new Error(
                `spec_body_md exceeds 64000 char limit (actual: ${t.spec_body_md.length}). Split into multiple tasks via depends_on.`,
              );
            }
          }

          void genId('task');

          db.run(
            `INSERT INTO tasks
               (issue_id, branch_id, parent_branch_id, title, description,
                tools_required, skills_required, success_criteria,
                status, attempts, execution_plan_md, qa_results, spec_body_md, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, '', ?, ?, ?)`,
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
              t.spec_body_md ?? '',
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
      const rawCommitSha = args['commit_sha'] as string | undefined;

      if (!VALID_STATUSES.has(status)) {
        throw new Error(
          `Invalid status: ${status}. Valid values: ${[...VALID_STATUSES].join(', ')}`,
        );
      }

      if (rawCommitSha !== undefined) {
        if (rawCommitSha.length < 7 || !/^[0-9a-fA-F]+$/.test(rawCommitSha)) {
          throw new Error(
            `Invalid commit_sha: "${rawCommitSha}". Must be a hex string of at least 7 characters (short SHA) or 40 characters (full SHA).`,
          );
        }
      }

      const task = db.get<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
      if (!task) {
        throw new Error(`Not found: ${taskId}`);
      }

      const now = nowISO();
      const attempts = args['attempts'] !== undefined ? (args['attempts'] as number) : task.attempts;
      const completedAt = status === 'completed' ? now : task.completed_at;

      if (rawCommitSha !== undefined) {
        db.run(
          `UPDATE tasks SET status = ?, attempts = ?, updated_at = ?, completed_at = ?, commit_sha = ? WHERE id = ?`,
          [status, attempts, now, completedAt, rawCommitSha, taskId],
        );
      } else {
        db.run(
          `UPDATE tasks SET status = ?, attempts = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
          [status, attempts, now, completedAt, taskId],
        );
      }

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

    task_set_spec_path: requireRoles('task_set_spec_path', ['architect'], wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const issueId = requireArg(args, 'issue_id') as string;
      const branchId = requireArg(args, 'branch_id') as string;
      const specPath = requireArg(args, 'spec_path') as string;

      const SPEC_PATH_RE = /^docs\/trustmybot\/tasks\/[a-z0-9-]+\.md$/;
      if (!SPEC_PATH_RE.test(specPath)) {
        throw new Error(
          `Invalid spec_path: "${specPath}". Must match docs/trustmybot/tasks/<slug>.md where slug is lowercase alphanumeric and hyphens only.`,
        );
      }

      const sanitizedBranchId = branchId.replace('/', '-');
      const stem = specPath.replace(/^docs\/trustmybot\/tasks\//, '').replace(/\.md$/, '');
      if (!stem.includes(sanitizedBranchId)) {
        throw new Error(
          `spec_path filename stem mismatch: expected stem to contain "${sanitizedBranchId}" (from branch_id "${branchId}"), got stem "${stem}".`,
        );
      }

      const now = nowISO();
      const result = db.run(
        `UPDATE tasks SET task_spec_path = ?, updated_at = ? WHERE issue_id = ? AND branch_id = ?`,
        [specPath, now, issueId, branchId],
      );

      if (result.changes === 0) {
        throw new Error(`Not found: task with issue_id=${issueId} and branch_id="${branchId}"`);
      }

      const updated = db.get<Task>('SELECT * FROM tasks WHERE issue_id = ? AND branch_id = ?', [issueId, branchId]);
      return ok(updated);
    })),

  };

  return { definitions, handlers };
}
