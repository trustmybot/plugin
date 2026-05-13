import { nowISO } from '../db.js';
const VALID_SCOPES = new Set(['global', 'template', 'project-local']);
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
export function commandTools(db) {
    const definitions = [
        {
            name: 'command_register',
            description: 'Register a new slash command. Plugin-shipped commands (/scan, /onboard, /monitor, /roundtable) are schema-seeded; project-local commands land at `<project>/.claude/commands/<name>.md`.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    name: { type: 'string', description: 'Bare slash-command name (no leading slash).' },
                    description: { type: 'string' },
                    file_path: { type: 'string' },
                    scope: {
                        type: 'string',
                        enum: ['global', 'template', 'project-local'],
                        description: 'Defaults to project-local.',
                    },
                    args_schema: {
                        type: 'string',
                        description: 'JSON string with optional shape metadata (e.g. `{"argument_hint":"<PR number>"}`). Defaults to "{}".',
                    },
                },
                required: ['agent', 'name', 'description', 'file_path'],
            },
        },
        {
            name: 'command_list',
            description: 'List registered slash commands, optionally filtered by scope.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    scope: { type: 'string', enum: ['global', 'template', 'project-local'] },
                },
            },
        },
    ];
    const handlers = {
        command_register: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const name = requireArg(args, 'name');
            const description = requireArg(args, 'description');
            const filePath = requireArg(args, 'file_path');
            const scope = args['scope'] ?? 'project-local';
            const argsSchema = args['args_schema'] ?? '{}';
            if (!VALID_SCOPES.has(scope)) {
                throw new Error(`Invalid scope: "${scope}". Allowed: ${[...VALID_SCOPES].join(', ')}`);
            }
            // Sanity-check args_schema parses as JSON (server-side gate; we don't
            // store invalid JSON in a column declared as JSON-shaped text).
            try {
                JSON.parse(argsSchema);
            }
            catch (parseErr) {
                throw new Error(`args_schema must be a JSON string: ${parseErr.message}`);
            }
            const now = nowISO();
            db.run(`INSERT INTO commands
           (name, description, file_path, scope, args_schema, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`, [name, description, filePath, scope, argsSchema, now, now]);
            const row = db.get('SELECT * FROM commands WHERE rowid = last_insert_rowid()');
            return ok(row);
        }),
        command_list: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const scope = args['scope'];
            const params = [];
            let where = '';
            if (typeof scope === 'string') {
                if (!VALID_SCOPES.has(scope)) {
                    throw new Error(`Invalid scope filter: "${scope}".`);
                }
                where = 'WHERE scope = ?';
                params.push(scope);
            }
            const rows = db.all(`SELECT id, name, description, file_path, scope, args_schema, status, created_at, updated_at
           FROM commands
           ${where}
           ORDER BY name`, params);
            return ok({ commands: rows });
        }),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=commands.js.map