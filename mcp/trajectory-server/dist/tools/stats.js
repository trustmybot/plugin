import { normalizeAgent, requireRoles } from '../middleware/agent-scope.js';
const ALLOWED_ROLES = ['bro', 'swe', 'pr-reviewer', 'consultant'];
function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function err(message) {
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
    };
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
// Per-token cost rates in USD (Anthropic claude-opus-4-8 tiers).
// cache_read is ~11x cheaper than plain input; cache_creation is ~25% more expensive.
// Using per-million token rates: input=$15, output=$75, cache_read=$1.50, cache_creation=$18.75.
// Rates are defined here as constants so callers can see the assumption and the
// estimated_cost_usd field stays meaningful even when the model changes.
const RATE_INPUT_PER_MTK = 15.0;
const RATE_OUTPUT_PER_MTK = 75.0;
const RATE_CACHE_READ_PER_MTK = 1.50;
const RATE_CACHE_CREATION_PER_MTK = 18.75;
function estimateCostUsd(tokensIn, tokensOut, cacheRead, cacheCreation) {
    return ((tokensIn * RATE_INPUT_PER_MTK +
        tokensOut * RATE_OUTPUT_PER_MTK +
        cacheRead * RATE_CACHE_READ_PER_MTK +
        cacheCreation * RATE_CACHE_CREATION_PER_MTK) /
        1_000_000);
}
const PRICE_FIELDS = ['input', 'output', 'cache_read', 'cache_creation'];
// plugin_config.model_prices as a map of complete price entries; an entry
// missing a numeric field is treated as unpriced.
export function readModelPrices(db) {
    const prices = new Map();
    const row = db.get(`SELECT value_json FROM plugin_config WHERE key = 'model_prices'`);
    if (!row)
        return prices;
    let parsed;
    try {
        parsed = JSON.parse(row.value_json);
    }
    catch {
        return prices;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return prices;
    for (const [model, entry] of Object.entries(parsed)) {
        if (entry === null || typeof entry !== 'object')
            continue;
        const e = entry;
        if (PRICE_FIELDS.every((f) => typeof e[f] === 'number' && Number.isFinite(e[f]))) {
            prices.set(model, {
                input: e['input'],
                output: e['output'],
                cache_read: e['cache_read'],
                cache_creation: e['cache_creation'],
            });
        }
    }
    return prices;
}
const round4 = (n) => Math.round(n * 10_000) / 10_000;
// Σ per row tokens × model_prices[model]; a row whose model has no price
// contributes its tokens to unpriced_tokens instead. Grouped by (host, model).
export function costEstimate(rows, prices) {
    const groups = new Map();
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
const TOKENS_TOTAL_SQL = 'CASE WHEN COALESCE(tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens) IS NULL THEN NULL' +
    ' ELSE COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0) END';
// Per-task cost is the task's swe and pr-reviewer runs: bro is metered per
// session, so a legacy per-task bro row is history, not task cost.
const TASK_COST_AGENTS_SQL = "agent_type IN ('swe', 'pr-reviewer')";
export function statsTools(db) {
    const definitions = [
        {
            name: 'task_stats',
            description: 'Return token/duration aggregate + per-spawn breakdown of one task\'s swe and pr-reviewer runs (bro is metered per session, not per task). tokens_total = tokens_in + tokens_out + cache_read_tokens + cache_creation_tokens; each spawn carries its usage_source, host, model, root_dir and exit_reason. cost_estimate (USD, 4 decimals) prices each row by plugin_config.model_prices[model]; tokens of rows with no priced model are reported as unpriced_tokens; cost_groups breaks both down by (host, model).',
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
    const handlers = {
        task_stats: requireRoles('task_stats', [...ALLOWED_ROLES], wrapHandler(async (args) => {
            normalizeAgent(args['agent']);
            const rawTaskId = args['task_id'];
            const taskId = Number(rawTaskId);
            if (!Number.isInteger(taskId) || taskId <= 0) {
                throw new Error('task_id must be a positive integer');
            }
            const aggRow = db.get('SELECT COUNT(*) as spawn_count,' +
                ' SUM(tokens_in) as sum_tokens_in,' +
                ' SUM(tokens_out) as sum_tokens_out,' +
                ` SUM(${TOKENS_TOTAL_SQL}) as sum_tokens_total,` +
                ' SUM(cache_read_tokens) as sum_cache_read,' +
                ' SUM(cache_creation_tokens) as sum_cache_creation,' +
                ' SUM(tool_uses) as sum_tool_uses,' +
                ' SUM(duration_ms) as sum_duration_ms' +
                ` FROM agent_runs WHERE task_id = ? AND ${TASK_COST_AGENTS_SQL}`, [taskId]);
            const sumIn = aggRow?.sum_tokens_in ?? 0;
            const sumOut = aggRow?.sum_tokens_out ?? 0;
            const sumCacheRead = aggRow?.sum_cache_read ?? 0;
            const sumCacheCreation = aggRow?.sum_cache_creation ?? 0;
            const aggregate = {
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
            const spawns = db.all(`SELECT id, agent_type, host, model, root_dir, exit_reason, tokens_in, tokens_out, ${TOKENS_TOTAL_SQL} AS tokens_total,` +
                ' cache_read_tokens, cache_creation_tokens, tool_uses, duration_ms, completed_at, usage_source' +
                ` FROM agent_runs WHERE task_id = ? AND ${TASK_COST_AGENTS_SQL} ORDER BY id`, [taskId]);
            const cost = costEstimate(spawns, readModelPrices(db));
            return ok({
                task_id: taskId,
                aggregate,
                cost_estimate: cost.cost_estimate,
                unpriced_tokens: cost.unpriced_tokens,
                cost_groups: cost.groups,
                spawns,
            });
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=stats.js.map