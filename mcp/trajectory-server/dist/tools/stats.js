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
export function statsTools(db) {
    const definitions = [
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
                ' SUM(tokens_total) as sum_tokens_total,' +
                ' SUM(tool_uses) as sum_tool_uses,' +
                ' SUM(duration_ms) as sum_duration_ms' +
                ' FROM agent_runs WHERE task_id = ?', [taskId]);
            const aggregate = {
                spawn_count: aggRow?.spawn_count ?? 0,
                tokens_in: aggRow?.sum_tokens_in ?? 0,
                tokens_out: aggRow?.sum_tokens_out ?? 0,
                tokens_total: aggRow?.sum_tokens_total ?? 0,
                tool_uses: aggRow?.sum_tool_uses ?? 0,
                duration_ms: aggRow?.sum_duration_ms ?? 0,
            };
            const spawns = db.all('SELECT id, agent_type, tokens_in, tokens_out, tokens_total,' +
                ' tool_uses, duration_ms, completed_at' +
                ' FROM agent_runs WHERE task_id = ? ORDER BY id', [taskId]);
            return ok({ task_id: taskId, aggregate, spawns });
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=stats.js.map