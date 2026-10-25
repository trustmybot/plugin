import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { normalizeAgent, requireRoles } from '../middleware/agent-scope.js';
import { elapsedMs, reworkCount, SWE_SPAWN_SQL } from '../task-rework.js';

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

// Per-token cost rates in USD (Anthropic claude-opus-4-8 tiers).
// cache_read is ~11x cheaper than plain input; cache_creation is ~25% more expensive.
// Using per-million token rates: input=$15, output=$75, cache_read=$1.50, cache_creation=$18.75.
// Rates are defined here as constants so callers can see the assumption and the
// estimated_cost_usd field stays meaningful even when the model changes.
const RATE_INPUT_PER_MTK = 15.0;
const RATE_OUTPUT_PER_MTK = 75.0;
const RATE_CACHE_READ_PER_MTK = 1.50;
const RATE_CACHE_CREATION_PER_MTK = 18.75;

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

// tokens_total is computed, never stored: tokens_in + tokens_out +
// cache_read_tokens + cache_creation_tokens (NULL counts as 0). It is NULL on a
// spawn row that was never measured.
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
  host: string | null;
  model: string | null;
  root_dir: string | null;
  exit_reason: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_total: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  tool_uses: number;
  duration_ms: number;
  completed_at: string | null;
  usage_source: string | null;
}

// USD per 1M tokens for one model (plugin_config.model_prices[<model>]).
interface ModelPrice {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

interface CostGroup {
  host: string | null;
  model: string | null;
  spawn_count: number;
  tokens_total: number;
  cost_estimate: number;
  unpriced_tokens: number;
}

const PRICE_FIELDS = ['input', 'output', 'cache_read', 'cache_creation'] as const;

// plugin_config.model_prices as a map of complete price entries; an entry
// missing a numeric field is treated as unpriced.
export function readModelPrices(db: TrajectoryDB): Map<string, ModelPrice> {
  const prices = new Map<string, ModelPrice>();
  const row = db.get<{ value_json: string }>(`SELECT value_json FROM plugin_config WHERE key = 'model_prices'`);
  if (!row) return prices;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value_json);
  } catch {
    return prices;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return prices;
  for (const [model, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (PRICE_FIELDS.every((f) => typeof e[f] === 'number' && Number.isFinite(e[f]))) {
      prices.set(model, {
        input: e['input'] as number,
        output: e['output'] as number,
        cache_read: e['cache_read'] as number,
        cache_creation: e['cache_creation'] as number,
      });
    }
  }
  return prices;
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

// Σ per row tokens × model_prices[model]; a row whose model has no price
// contributes its tokens to unpriced_tokens instead. Grouped by (host, model).
export function costEstimate(
  rows: ReadonlyArray<Pick<AgentRunRow, 'host' | 'model' | 'tokens_in' | 'tokens_out' | 'cache_read_tokens' | 'cache_creation_tokens'>>,
  prices: ReadonlyMap<string, ModelPrice>,
): { cost_estimate: number; unpriced_tokens: number; groups: CostGroup[] } {
  const groups = new Map<string, CostGroup & { cost: number }>();
  let cost = 0;
  let unpriced = 0;
  for (const r of rows) {
    const ti = r.tokens_in ?? 0;
    const to = r.tokens_out ?? 0;
    const cr = r.cache_read_tokens ?? 0;
    const cc = r.cache_creation_tokens ?? 0;
    const total = ti + to + cr + cc;
    const price = r.model !== null ? prices.get(r.model) : undefined;
    const rowCost = price
      ? (ti * price.input + to * price.output + cr * price.cache_read + cc * price.cache_creation) / 1_000_000
      : 0;
    const rowUnpriced = price ? 0 : total;
    cost += rowCost;
    unpriced += rowUnpriced;
    const key = JSON.stringify([r.host, r.model]);
    const g = groups.get(key) ?? {
      host: r.host, model: r.model, spawn_count: 0, tokens_total: 0, cost_estimate: 0, unpriced_tokens: 0, cost: 0,
    };
    g.spawn_count += 1;
    g.tokens_total += total;
    g.cost += rowCost;
    g.unpriced_tokens += rowUnpriced;
    groups.set(key, g);
  }
  return {
    cost_estimate: round4(cost),
    unpriced_tokens: unpriced,
    groups: [...groups.values()].map(({ cost: c, ...g }) => ({ ...g, cost_estimate: round4(c) })),
  };
}

const TOKENS_TOTAL_SQL =
  'CASE WHEN COALESCE(tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens) IS NULL THEN NULL' +
  ' ELSE COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0) END';

// Per-task cost is the task's swe and pr-reviewer runs: bro is metered per
// session, so a legacy per-task bro row is history, not task cost.
const TASK_COST_AGENTS_SQL = "agent_type IN ('swe', 'pr-reviewer')";

interface ReworkStats {
  wall_clock_ms: number | null;
  review_fail_count: number;
  swe_spawn_count: number;
  rework_count: number;
}

// Computed at read time, nothing stored. wall_clock_ms runs from the task's
// created_at to its close (updated_at of a closed task: the close is its last
// write) or to now while it is open; null for an unknown task.
function reworkStats(db: TrajectoryDB, taskId: number, now: Date): ReworkStats {
  const task = db.get<{ status: string; created_at: string; updated_at: string }>(
    'SELECT status, created_at, updated_at FROM tasks WHERE id = ?',
    [taskId],
  );
  const fails = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM validation_attempts WHERE task_id = ? AND verdict = 'fail'",
    [taskId],
  );
  const spawns = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM agent_runs WHERE task_id = ? AND ${SWE_SPAWN_SQL}`, [taskId]);
  const sweSpawnCount = spawns?.n ?? 0;
  const endedAt = task?.status === 'closed' ? new Date(task.updated_at) : now;
  return {
    wall_clock_ms: task ? elapsedMs(task.created_at, endedAt) : null,
    review_fail_count: fails?.n ?? 0,
    swe_spawn_count: sweSpawnCount,
    rework_count: reworkCount(sweSpawnCount),
  };
}

export function statsTools(db: TrajectoryDB, clock: () => Date = () => new Date()): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'task_stats',
      description:
        'Return token/duration aggregate + per-spawn breakdown of one task\'s swe and pr-reviewer runs (bro is metered per session, not per task). tokens_total = tokens_in + tokens_out + cache_read_tokens + cache_creation_tokens; each spawn carries its usage_source, host, model, root_dir and exit_reason. cost_estimate (USD, 4 decimals) prices each row by plugin_config.model_prices[model]; tokens of rows with no priced model are reported as unpriced_tokens; cost_groups breaks both down by (host, model). Also wall_clock_ms (created_at to close, or now), review_fail_count, swe_spawn_count, rework_count (spawns - 1).',
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
          ` SUM(${TOKENS_TOTAL_SQL}) as sum_tokens_total,` +
          ' SUM(cache_read_tokens) as sum_cache_read,' +
          ' SUM(cache_creation_tokens) as sum_cache_creation,' +
          ' SUM(tool_uses) as sum_tool_uses,' +
          ' SUM(duration_ms) as sum_duration_ms' +
          ` FROM agent_runs WHERE task_id = ? AND ${TASK_COST_AGENTS_SQL}`,
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
          `SELECT id, agent_type, host, model, root_dir, exit_reason, tokens_in, tokens_out, ${TOKENS_TOTAL_SQL} AS tokens_total,` +
          ' cache_read_tokens, cache_creation_tokens, tool_uses, duration_ms, completed_at, usage_source' +
          ` FROM agent_runs WHERE task_id = ? AND ${TASK_COST_AGENTS_SQL} ORDER BY id`,
          [taskId],
        );

        const cost = costEstimate(spawns, readModelPrices(db));
        return ok({
          task_id: taskId,
          aggregate,
          cost_estimate: cost.cost_estimate,
          unpriced_tokens: cost.unpriced_tokens,
          cost_groups: cost.groups,
          ...reworkStats(db, taskId, clock()),
          spawns,
        });
      }),
    ),
  };

  return { definitions, handlers };
}
