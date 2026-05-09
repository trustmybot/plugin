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
const VALID_KINDS = new Set(['backbone', 'consultant']);
const VALID_SCOPES = new Set(['global', 'template', 'project-local']);
const VALID_TMB_OWNERS = new Set(['bro', 'user-adopted', 'user']);
export function agentTools(db) {
    const definitions = [
        {
            name: 'agent_list',
            description: 'List registered agents, optionally filtered by scope.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    scope: { type: 'string', enum: ['global', 'template', 'project-local'] },
                },
                required: ['agent'],
            },
        },
        {
            name: 'agent_register',
            description: 'Register a new agent. Returns existing row unchanged if name already present (INSERT OR IGNORE).',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    name: { type: 'string' },
                    kind: { type: 'string', enum: ['backbone', 'consultant'] },
                    scope: { type: 'string', enum: ['global', 'template', 'project-local'] },
                    file_path: { type: 'string' },
                    tmb_owner: { type: 'string', enum: ['bro', 'user-adopted', 'user'] },
                },
                required: ['agent', 'name', 'kind', 'scope', 'file_path'],
            },
        },
    ];
    const handlers = {
        agent_list: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const scope = args['scope'];
            if (scope !== undefined && !VALID_SCOPES.has(scope)) {
                throw new Error(`Invalid scope: "${scope}". Allowed values: ${[...VALID_SCOPES].join(', ')}`);
            }
            const rows = scope
                ? db.all('SELECT * FROM agents WHERE scope = ? ORDER BY name', [scope])
                : db.all('SELECT * FROM agents ORDER BY name');
            return ok({ agents: rows });
        }),
        agent_register: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const name = requireArg(args, 'name');
            const kind = requireArg(args, 'kind');
            const scope = requireArg(args, 'scope');
            const filePath = requireArg(args, 'file_path');
            const tmbOwner = args['tmb_owner'] ?? 'bro';
            if (!VALID_KINDS.has(kind)) {
                throw new Error(`Invalid kind: "${kind}". Allowed values: ${[...VALID_KINDS].join(', ')}`);
            }
            if (!VALID_SCOPES.has(scope)) {
                throw new Error(`Invalid scope: "${scope}". Allowed values: ${[...VALID_SCOPES].join(', ')}`);
            }
            if (!VALID_TMB_OWNERS.has(tmbOwner)) {
                throw new Error(`Invalid tmb_owner: "${tmbOwner}". Allowed values: ${[...VALID_TMB_OWNERS].join(', ')}`);
            }
            db.run(`INSERT OR IGNORE INTO agents (name, kind, scope, file_path, tmb_owner)
         VALUES (?, ?, ?, ?, ?)`, [name, kind, scope, filePath, tmbOwner]);
            const row = db.get('SELECT * FROM agents WHERE name = ?', [name]);
            return ok(row);
        }),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=agents.js.map