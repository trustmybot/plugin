import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { normalizeAgent, requireRoles } from '../middleware/agent-scope.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

const ALLOWED_ROLES = ['bro', 'architect', 'swe', 'pr-reviewer'] as const;

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
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

interface AgentRunsAggregate {
  spawn_count: number;
  tokens_in: number;
  tokens_out: number;
  tokens_total: number;
  tool_uses: number;
  duration_ms: number;
}

interface AgentRunRow {
  id: number;
  agent_type: string;
  tokens_in: number;
  tokens_out: number;
  tokens_total: number;
  tool_uses: number;
  duration_ms: number;
  started_at: string | null;
  completed_at: string;
  exit_status: string;
}

export function statsTools(db: TrajectoryDB): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'task_stats',
      description: 'Return token/duration aggregate + per-spawn breakdown for one task.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Calling agent identity' },
          task_id: { type: 'integer', description: 'Task ID to query stats for' },
        },
        required: ['agent', 'task_id'],
      },
    },
  ];

  const handlers: Record<string, Fn> = {
    task_stats: requireRoles(
      'task_stats',
      [...ALLOWED_ROLES],
      wrapHandler(async (args) => {
        normalizeAgent(args['agent'] as string | undefined);

        const rawTaskId = args['task_id'];
        const taskId = Number(rawTaskId);
        if (!Number.isInteger(taskId) || taskId <= 0) {
          throw new Error('task_id must be a positive integer');
        }

        const aggRow = db.get<{
          spawn_count: number;
          sum_tokens_in: number | null;
          sum_tokens_out: number | null;
          sum_tokens_total: number | null;
          sum_tool_uses: number | null;
          sum_duration_ms: number | null;
        }>(
          'SELECT COUNT(*) as spawn_count,' +
          ' SUM(tokens_in) as sum_tokens_in,' +
          ' SUM(tokens_out) as sum_tokens_out,' +
          ' SUM(tokens_total) as sum_tokens_total,' +
          ' SUM(tool_uses) as sum_tool_uses,' +
          ' SUM(duration_ms) as sum_duration_ms' +
          ' FROM agent_runs WHERE task_id = ?',
          [taskId],
        );

        const aggregate: AgentRunsAggregate = {
          spawn_count: aggRow?.spawn_count ?? 0,
          tokens_in: aggRow?.sum_tokens_in ?? 0,
          tokens_out: aggRow?.sum_tokens_out ?? 0,
          tokens_total: aggRow?.sum_tokens_total ?? 0,
          tool_uses: aggRow?.sum_tool_uses ?? 0,
          duration_ms: aggRow?.sum_duration_ms ?? 0,
        };

        const spawns = db.all<AgentRunRow>(
          'SELECT id, agent_type, tokens_in, tokens_out, tokens_total,' +
          ' tool_uses, duration_ms, started_at, completed_at, exit_status' +
          ' FROM agent_runs WHERE task_id = ? ORDER BY id',
          [taskId],
        );

        return ok({ task_id: taskId, aggregate, spawns });
      }),
    ),
  };

  return { definitions, handlers };
}
