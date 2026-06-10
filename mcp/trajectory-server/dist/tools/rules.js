import { nowISO } from '../db.js';
const VALID_SCOPES = new Set(['global', 'template', 'project-local']);
const VALID_SEVERITIES = new Set(['advisory', 'warning', 'blocking']);
const VALID_INVOCATION_OUTCOMES = new Set(['applied', 'violated', 'skipped']);
function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function err(message) {
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
    };
}
function requireArg(args, name) {
    if (args[name] === undefined || args[name] === null) {
        throw new Error(`Missing required arg: ${name}`);
    }
    return args[name];
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
export function ruleTools(db) {
    const definitions = [
        {
            name: 'rule_register',
            description: 'Register a project-local rule from .claude/rules/*.md. Severity: advisory = inform; warning = surface; blocking = hook denies the operation.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    file_path: { type: 'string' },
                    scope: {
                        type: 'string',
                        enum: ['global', 'template', 'project-local'],
                        description: 'Defaults to project-local.',
                    },
                    severity: {
                        type: 'string',
                        enum: ['advisory', 'warning', 'blocking'],
                        description: 'Defaults to advisory.',
                    },
                },
                required: ['agent', 'name', 'description', 'file_path'],
            },
        },
        {
            name: 'rule_list',
            description: 'List registered rules, optionally filtered by scope or severity.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    scope: { type: 'string', enum: ['global', 'template', 'project-local'] },
                    severity: { type: 'string', enum: ['advisory', 'warning', 'blocking'] },
                },
            },
        },
        {
            name: 'rule_record_invocation',
            description: 'Record one rule application — bridges the catalog (rules) to the agent_run that applied it. Writes one row to rule_invocations. outcome=violated records a per-instance violation; outcome=applied is the clean case.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    rule_name: { type: 'string' },
                    agent_name: { type: 'string' },
                    agent_run_id: { type: 'integer' },
                    task_id: { type: 'integer' },
                    outcome: {
                        type: 'string',
                        enum: ['applied', 'violated', 'skipped'],
                        description: 'Defaults to applied.',
                    },
                },
                required: ['agent', 'rule_name', 'agent_name'],
            },
        },
        {
            name: 'rule_invocations_list',
            description: 'List rule_invocations rows. Bidirectional: filter by rule_name (who tripped rule X?) or by agent_run_id/task_id (which rules fired during this run?).',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    rule_name: { type: 'string' },
                    agent_run_id: { type: 'integer' },
                    task_id: { type: 'integer' },
                    outcome: { type: 'string', enum: ['applied', 'violated', 'skipped'] },
                    limit: { type: 'integer', description: 'Default 200, max 1000.' },
                },
            },
        },
    ];
    const handlers = {
        rule_register: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const name = requireArg(args, 'name');
            const description = requireArg(args, 'description');
            const filePath = requireArg(args, 'file_path');
            const scope = args['scope'] ?? 'project-local';
            const severity = args['severity'] ?? 'advisory';
            if (!VALID_SCOPES.has(scope)) {
                throw new Error(`Invalid scope: "${scope}". Allowed: ${[...VALID_SCOPES].join(', ')}`);
            }
            if (!VALID_SEVERITIES.has(severity)) {
                throw new Error(`Invalid severity: "${severity}". Allowed: ${[...VALID_SEVERITIES].join(', ')}`);
            }
            const now = nowISO();
            db.run(`INSERT INTO rules
           (name, description, file_path, scope, severity, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`, [name, description, filePath, scope, severity, now, now]);
            const row = db.get('SELECT * FROM rules WHERE rowid = last_insert_rowid()');
            return ok(row);
        }),
        rule_list: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const filters = [];
            const params = [];
            const scope = args['scope'];
            const severity = args['severity'];
            if (typeof scope === 'string') {
                if (!VALID_SCOPES.has(scope)) {
                    throw new Error(`Invalid scope filter: "${scope}".`);
                }
                filters.push('scope = ?');
                params.push(scope);
            }
            if (typeof severity === 'string') {
                if (!VALID_SEVERITIES.has(severity)) {
                    throw new Error(`Invalid severity filter: "${severity}".`);
                }
                filters.push('severity = ?');
                params.push(severity);
            }
            const where = filters.length > 0 ? 'WHERE ' + filters.join(' AND ') : '';
            const rows = db.all(`SELECT id, name, description, file_path, scope, severity, status, created_at, updated_at
           FROM rules
           ${where}
           ORDER BY name`, params);
            return ok({ rules: rows });
        }),
        rule_record_invocation: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const ruleName = requireArg(args, 'rule_name');
            const agentName = requireArg(args, 'agent_name');
            const agentRunId = args['agent_run_id'] === undefined || args['agent_run_id'] === null
                ? null
                : Number(args['agent_run_id']);
            const taskId = args['task_id'] === undefined || args['task_id'] === null
                ? null
                : Number(args['task_id']);
            const outcome = args['outcome'] ?? 'applied';
            if (!VALID_INVOCATION_OUTCOMES.has(outcome)) {
                throw new Error(`Invalid outcome: "${outcome}". Allowed: ${[...VALID_INVOCATION_OUTCOMES].join(', ')}`);
            }
            if (agentRunId !== null && !Number.isInteger(agentRunId)) {
                throw new Error('agent_run_id must be an integer when provided');
            }
            if (taskId !== null && !Number.isInteger(taskId)) {
                throw new Error('task_id must be an integer when provided');
            }
            const rule = db.get('SELECT name FROM rules WHERE name = ?', [ruleName]);
            if (!rule) {
                throw new Error(`Rule not registered: ${ruleName}`);
            }
            const now = nowISO();
            db.run(`INSERT INTO rule_invocations
           (rule_name, agent_name, agent_run_id, task_id, applied_at, outcome)
         VALUES (?, ?, ?, ?, ?, ?)`, [ruleName, agentName, agentRunId, taskId, now, outcome]);
            const row = db.get('SELECT * FROM rule_invocations WHERE rowid = last_insert_rowid()');
            return ok(row);
        }),
        rule_invocations_list: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const filters = [];
            const params = [];
            if (typeof args['rule_name'] === 'string') {
                filters.push('rule_name = ?');
                params.push(args['rule_name']);
            }
            if (args['agent_run_id'] !== undefined && args['agent_run_id'] !== null) {
                filters.push('agent_run_id = ?');
                params.push(Number(args['agent_run_id']));
            }
            if (args['task_id'] !== undefined && args['task_id'] !== null) {
                filters.push('task_id = ?');
                params.push(Number(args['task_id']));
            }
            if (typeof args['outcome'] === 'string') {
                if (!VALID_INVOCATION_OUTCOMES.has(args['outcome'])) {
                    throw new Error(`Invalid outcome filter: "${args['outcome']}".`);
                }
                filters.push('outcome = ?');
                params.push(args['outcome']);
            }
            const where = filters.length > 0 ? 'WHERE ' + filters.join(' AND ') : '';
            const limit = Math.min(Math.max(1, Number(args['limit'] ?? 200)), 1000);
            params.push(limit);
            const rows = db.all(`SELECT id, rule_name, agent_name, agent_run_id, task_id, applied_at, outcome
           FROM rule_invocations
           ${where}
           ORDER BY id DESC
           LIMIT ?`, params);
            return ok({ rows, count: rows.length });
        }),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=rules.js.map