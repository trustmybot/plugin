import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { normalizeAgent, requireRoles } from '../middleware/agent-scope.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

const ALLOWED_ROLES = ['bro', 'swe', 'pr-reviewer', 'consultant'] as const;

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

// Per-token cost rates in USD (Anthropic claude-sonnet-4-5 / claude-opus-4 tiers).
// cache_read is ~11x cheaper than plain input; cache_creation is ~25% more expensive.
// Using per-million token rates: input=$3, output=$15, cache_read=$0.30, cache_creation=$3.75.
// Rates are defined here as constants so callers can see the assumption and the
// estimated_cost_usd field stays meaningful even when the model changes.
const RATE_INPUT_PER_MTK = 3.0;
const RATE_OUTPUT_PER_MTK = 15.0;
const RATE_CACHE_READ_PER_MTK = 0.30;
const RATE_CACHE_CREATION_PER_MTK = 3.75;

function estimateCostUsd(
  tokensIn: number,
  tokensOut: number,
  cacheRead: number,
  cacheCreation: number,
): number {
  return (
    (tokensIn * RATE_INPUT_PER_MTK +
      tokensOut * RATE_OUTPUT_PER_MTK +
      cacheRead * RATE_CACHE_READ_PER_MTK +
      cacheCreation * RATE_CACHE_CREATION_PER_MTK) /
    1_000_000
  );
}

interface AgentRunsAggregate {
  spawn_count: number;
  tokens_in: number;
  tokens_out: number;
  tokens_total: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  tool_uses: number;
  duration_ms: number;
  estimated_cost_usd: number;
}

interface AgentRunRow {
  id: number;
  agent_type: string;
  tokens_in: number;
  tokens_out: number;
  tokens_total: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  tool_uses: number;
  duration_ms: number;
  completed_at: string;
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
          sum_cache_read: number | null;
          sum_cache_creation: number | null;
          sum_tool_uses: number | null;
          sum_duration_ms: number | null;
        }>(
          'SELECT COUNT(*) as spawn_count,' +
          ' SUM(tokens_in) as sum_tokens_in,' +
          ' SUM(tokens_out) as sum_tokens_out,' +
          ' SUM(tokens_total) as sum_tokens_total,' +
          ' SUM(cache_read_tokens) as sum_cache_read,' +
          ' SUM(cache_creation_tokens) as sum_cache_creation,' +
          ' SUM(tool_uses) as sum_tool_uses,' +
          ' SUM(duration_ms) as sum_duration_ms' +
          ' FROM agent_runs WHERE task_id = ?',
          [taskId],
        );

        const sumIn = aggRow?.sum_tokens_in ?? 0;
        const sumOut = aggRow?.sum_tokens_out ?? 0;
        const sumCacheRead = aggRow?.sum_cache_read ?? 0;
        const sumCacheCreation = aggRow?.sum_cache_creation ?? 0;

        const aggregate: AgentRunsAggregate = {
          spawn_count: aggRow?.spawn_count ?? 0,
          tokens_in: sumIn,
          tokens_out: sumOut,
          tokens_total: aggRow?.sum_tokens_total ?? 0,
          cache_read_tokens: sumCacheRead,
          cache_creation_tokens: sumCacheCreation,
          tool_uses: aggRow?.sum_tool_uses ?? 0,
          duration_ms: aggRow?.sum_duration_ms ?? 0,
          estimated_cost_usd: estimateCostUsd(sumIn, sumOut, sumCacheRead, sumCacheCreation),
        };

        const spawns = db.all<AgentRunRow>(
          'SELECT id, agent_type, tokens_in, tokens_out, tokens_total,' +
          ' cache_read_tokens, cache_creation_tokens, tool_uses, duration_ms, completed_at' +
          ' FROM agent_runs WHERE task_id = ? ORDER BY id',
          [taskId],
        );

        return ok({ task_id: taskId, aggregate, spawns });
      }),
    ),
  };

  return { definitions, handlers };
}
