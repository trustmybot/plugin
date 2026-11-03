import { normalizeAgent, requireRoles } from '../middleware/agent-scope.js';
import { elapsedMs, reworkCount, SWE_SPAWN_SQL } from '../task-rework.js';
const ALLOWED_ROLES = ['bro', 'swe', 'code-reviewer', 'consultant'];
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
// Per-task cost is the task's swe and code-reviewer runs: bro is metered per
// session, so a legacy per-task bro row is history, not task cost.
const TASK_COST_AGENTS_SQL = "agent_type IN ('swe', 'code-reviewer')";
// The task's swe reworks by kind (GH 1742): fresh = every fresh swe spawn
// after the first, resumed = every run resumed through SendMessage
// (resumed_from set). wall_clock_ms sums the runs' duration_ms.
function reworkKinds(db, taskId) {
    const rows = db.all(`SELECT CASE WHEN resumed_from IS NULL THEN 'fresh' ELSE 'resumed' END AS kind,
            COUNT(*) AS count,
            COALESCE(SUM(duration_ms), 0) AS wall_clock_ms,
            COALESCE(SUM(tool_uses), 0) AS tool_uses,
            COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
       FROM agent_runs
      WHERE task_id = ? AND ${SWE_SPAWN_SQL}
        AND (resumed_from IS NOT NULL
             OR id > (SELECT MIN(id) FROM agent_runs WHERE task_id = ? AND ${SWE_SPAWN_SQL} AND resumed_from IS NULL))
      GROUP BY kind`, [taskId, taskId]);
    const empty = () => ({ count: 0, wall_clock_ms: 0, tool_uses: 0, cache_read_tokens: 0 });
    const reworks = { fresh: empty(), resumed: empty() };
    for (const { kind, ...totals } of rows)
        reworks[kind] = totals;
    return reworks;
}
// Computed at read time, nothing stored. wall_clock_ms runs from the task's
// created_at to its close (updated_at of a closed task: the close is its last
// write) or to now while it is open; null for an unknown task.
export function reworkStats(db, taskId, now) {
    const task = db.get('SELECT status, created_at, updated_at FROM tasks WHERE id = ?', [taskId]);
    const fails = db.get("SELECT COUNT(*) AS n FROM validation_attempts WHERE task_id = ? AND verdict = 'fail'", [taskId]);
    const spawns = db.get(`SELECT COUNT(*) AS n FROM agent_runs WHERE task_id = ? AND ${SWE_SPAWN_SQL}`, [taskId]);
    const sweSpawnCount = spawns?.n ?? 0;
    const endedAt = task?.status === 'closed' ? new Date(task.updated_at) : now;
    return {
        wall_clock_ms: task ? elapsedMs(task.created_at, endedAt) : null,
        review_fail_count: fails?.n ?? 0,
        swe_spawn_count: sweSpawnCount,
        rework_count: reworkCount(sweSpawnCount),
        reworks: reworkKinds(db, taskId),
    };
}
/** Tool calls and cache-read tokens summed over every swe spawn of the task. */
export function sweRunTotals(db, taskId) {
    const row = db.get(`SELECT COALESCE(SUM(tool_uses), 0) AS tool_uses, COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
       FROM agent_runs WHERE task_id = ? AND ${SWE_SPAWN_SQL}`, [taskId]);
    return { tool_uses: row?.tool_uses ?? 0, cache_read_tokens: row?.cache_read_tokens ?? 0 };
}
const WRITE_PATH_RULE = /write target ".*" cannot be judged|comes from a process|depends on a variable/s;
// GH 1915: classifies one hook_denied row; the first match wins. A gate that
// timed out or crashed (GH 1861) is a gate failure, not a denial.
export function hookBlockReason(hook, rule) {
    const h = hook ?? 'unknown';
    const r = rule ?? '';
    if (r.includes('dispatch failed') || r.includes('ran past'))
        return { reason: `${h}:gate_failure`, gate_failure: true };
    if (r.includes('ambiguous_git_target'))
        return { reason: `${h}:ambiguous_git_target`, gate_failure: false };
    if (WRITE_PATH_RULE.test(r))
        return { reason: `${h}:write_path`, gate_failure: false };
    if (r.startsWith('BLOCKED: containment'))
        return { reason: `${h}:containment`, gate_failure: false };
    if (r.includes('SWE may only edit files inside'))
        return { reason: `${h}:swe_worktree`, gate_failure: false };
    return { reason: h, gate_failure: false };
}
function sortedReasons(counts) {
    return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}
// Computed at read time from audit hook_denied rows, nothing stored
// (containment_denied duplicates containment-guard's hook_denied, so it is
// left out). A row goes to the run of its task_id and agent_type whose
// [started_at, completed_at ?? now] holds created_at; when runs overlap, the
// latest started_at wins, so each row counts at most once.
export function hookBlockStats(db, runs, now) {
    const perRun = new Map(runs.map((r) => [r.id, 0]));
    const byReason = new Map();
    let denials = 0;
    let gateFailures = 0;
    const windows = runs
        .filter((r) => r.task_id !== null && r.started_at !== null && !Number.isNaN(Date.parse(r.started_at)))
        .map((r) => ({
        id: r.id,
        task_id: r.task_id,
        agent_type: r.agent_type,
        start: Date.parse(r.started_at),
        end: r.completed_at !== null && !Number.isNaN(Date.parse(r.completed_at)) ? Date.parse(r.completed_at) : now.getTime(),
    }))
        .sort((a, b) => b.start - a.start);
    if (windows.length === 0)
        return { denials, gate_failures: gateFailures, by_reason: {}, per_run: perRun };
    const taskIds = [...new Set(windows.map((w) => w.task_id))];
    const rows = db.all(`SELECT json_extract(content_json, '$.task_id') AS task_id,
            json_extract(content_json, '$.agent_type') AS agent_type,
            json_extract(content_json, '$.hook') AS hook,
            json_extract(content_json, '$.rule') AS rule,
            created_at
       FROM audit
      WHERE event_type = 'hook_denied'
        AND CAST(json_extract(content_json, '$.task_id') AS INTEGER) IN (${taskIds.map(() => '?').join(', ')})`, taskIds);
    for (const row of rows) {
        const at = Date.parse(row.created_at);
        if (Number.isNaN(at) || row.task_id === null || row.agent_type === null)
            continue;
        const taskId = Number(row.task_id);
        const agentType = row.agent_type.startsWith('tmb:') ? row.agent_type.slice(4) : row.agent_type;
        const run = windows.find((w) => w.task_id === taskId && w.agent_type === agentType && w.start <= at && at <= w.end);
        if (!run)
            continue;
        const { reason, gate_failure } = hookBlockReason(row.hook, row.rule);
        if (gate_failure)
            gateFailures += 1;
        else
            denials += 1;
        byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
        perRun.set(run.id, (perRun.get(run.id) ?? 0) + 1);
    }
    return { denials, gate_failures: gateFailures, by_reason: sortedReasons(byReason), per_run: perRun };
}
const HOOK_BLOCK_RUN_COLUMNS = 'id, task_id, agent_type, started_at, completed_at';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
function parseSince(raw) {
    if (typeof raw !== 'string' || !ISO_DATE.test(raw) || Number.isNaN(Date.parse(raw))) {
        throw new Error('since must be an ISO date, e.g. 2026-10-26 or 2026-10-26T00:00:00Z');
    }
    return new Date(raw);
}
function hookBlockWindow(db, since, now) {
    const runs = db.all(`SELECT ${HOOK_BLOCK_RUN_COLUMNS} FROM agent_runs
      WHERE agent_type = 'swe' AND started_at IS NOT NULL AND julianday(started_at) >= julianday(?)
      ORDER BY id`, [since.toISOString()]);
    const stats = hookBlockStats(db, runs, now);
    const blocks = stats.denials + stats.gate_failures;
    return {
        runs: runs.length,
        runs_with_blocks: [...stats.per_run.values()].filter((n) => n > 0).length,
        denials: stats.denials,
        gate_failures: stats.gate_failures,
        blocks_per_run: runs.length === 0 ? 0 : Math.round((blocks / runs.length) * 100) / 100,
        by_reason: stats.by_reason,
    };
}
export const TOOL_OUTPUT_TOP = 10;
// GH 1957: the agent_run_tool_output rows of the runs <runsWhere> selects,
// summed per (agent_type, tool); per agent type the top TOOL_OUTPUT_TOP tools
// by est_tokens, each with its share of that type's total.
export function toolOutputStats(db, runsWhere, params) {
    const rows = db.all(`SELECT r.agent_type AS agent_type, o.tool_name AS tool_name,
            SUM(o.calls) AS calls, SUM(o.est_tokens) AS est_tokens
       FROM agent_run_tool_output o JOIN agent_runs r ON r.id = o.run_id
      WHERE ${runsWhere}
      GROUP BY r.agent_type, o.tool_name
      ORDER BY r.agent_type, est_tokens DESC, o.tool_name`, params);
    const out = {};
    for (const row of rows) {
        const group = (out[row.agent_type] ??= { total_est_tokens: 0, tools: [] });
        group.total_est_tokens += row.est_tokens;
        group.tools.push({ tool_name: row.tool_name, calls: row.calls, est_tokens: row.est_tokens, share: 0 });
    }
    for (const group of Object.values(out)) {
        group.tools = group.tools.slice(0, TOOL_OUTPUT_TOP).map((t) => ({
            ...t,
            share: group.total_est_tokens === 0 ? 0 : Math.round((t.est_tokens / group.total_est_tokens) * 1000) / 1000,
        }));
    }
    return out;
}
export function statsTools(db, clock = () => new Date()) {
    const definitions = [
        {
            name: 'task_stats',
            description: 'Token/duration aggregate + per-spawn breakdown of one task\'s swe and code-reviewer runs. tokens_total = tokens_in + tokens_out + cache_read_tokens + cache_creation_tokens; each spawn carries its usage_source, host, model, root_dir and exit_reason. cost_estimate (USD, 4 decimals) prices each row by plugin_config.model_prices[model]; tokens of rows with no priced model are unpriced_tokens; cost_groups splits both by (host, model). Also wall_clock_ms (created_at to close, or now), review_fail_count, swe_spawn_count, rework_count (spawns - 1), and reworks split into fresh (fresh swe spawns after the first) and resumed (swe runs resumed through SendMessage), each with count, wall_clock_ms (summed run durations), tool_uses and cache_read_tokens. hook_blocks counts the audit hook_denied rows attributed to the task\'s runs: { denials, gate_failures (timed-out or crashed gates), by_reason (per reason, highest first) }, and each spawn its own hook_blocks count. tool_output: per agent_type, { total_est_tokens, tools: top 10 by est_tokens (result chars / 4) with calls and share }. Two modes: pass task_id for one task, or pass since (ISO date) without task_id: { since, window: { runs, runs_with_blocks, denials, gate_failures, blocks_per_run, by_reason } (swe runs started since then), tool_output (all runs) }.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string', description: 'Calling agent identity' },
                    task_id: { type: 'integer', description: 'Task ID to query stats for (task mode)' },
                    since: { type: 'string', description: 'ISO date; without task_id, returns hook-block stats over swe runs and tool_output over all runs started at or after it (window mode)' },
                },
                required: ['agent'],
            },
        },
    ];
    const handlers = {
        task_stats: requireRoles('task_stats', [...ALLOWED_ROLES], wrapHandler(async (args) => {
            normalizeAgent(args['agent']);
            const rawTaskId = args['task_id'];
            if (rawTaskId === undefined || rawTaskId === null) {
                if (args['since'] === undefined || args['since'] === null) {
                    throw new Error('task_stats needs task_id (one task) or since (window across runs)');
                }
                const since = args['since'];
                const sinceDate = parseSince(since);
                return ok({
                    since,
                    window: hookBlockWindow(db, sinceDate, clock()),
                    tool_output: toolOutputStats(db, 'r.started_at IS NOT NULL AND julianday(r.started_at) >= julianday(?)', [
                        sinceDate.toISOString(),
                    ]),
                });
            }
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
            const blocks = hookBlockStats(db, db.all(`SELECT ${HOOK_BLOCK_RUN_COLUMNS} FROM agent_runs WHERE task_id = ? AND ${TASK_COST_AGENTS_SQL}`, [taskId]), clock());
            const hookBlocks = { denials: blocks.denials, gate_failures: blocks.gate_failures, by_reason: blocks.by_reason };
            return ok({
                task_id: taskId,
                aggregate,
                cost_estimate: cost.cost_estimate,
                unpriced_tokens: cost.unpriced_tokens,
                cost_groups: cost.groups,
                ...reworkStats(db, taskId, clock()),
                hook_blocks: hookBlocks,
                tool_output: toolOutputStats(db, `r.task_id = ? AND r.${TASK_COST_AGENTS_SQL}`, [taskId]),
                spawns: spawns.map((s) => ({ ...s, hook_blocks: blocks.per_run.get(s.id) ?? 0 })),
            });
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=stats.js.map