import { requireRoles } from '../middleware/agent-scope.js';
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
const KEY_REGEX = /^[a-z][a-z0-9_.-]{0,63}$/i;
export function configTools(db) {
    const definitions = [
        {
            name: 'config_set',
            description: 'Set a plugin config key to a JSON-serializable value.',
            inputSchema: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'Config key (1-64 chars, must match /^[a-z][a-z0-9_.-]{0,63}$/i)' },
                    value: { description: 'Any JSON-serializable value' },
                },
                required: ['key', 'value'],
            },
        },
        {
            name: 'config_get',
            description: 'Get a plugin config value by key. Returns null if not set.',
            inputSchema: {
                type: 'object',
                properties: {
                    key: { type: 'string' },
                },
                required: ['key'],
            },
        },
        {
            name: 'config_list',
            description: 'List all plugin config entries as a key→value object.',
            inputSchema: {
                type: 'object',
                properties: {},
            },
        },
    ];
    const handlers = {
        config_set: requireRoles('config_set', ['bro'], wrapHandler(async (args) => {
            const key = args['key'];
            if (typeof key !== 'string' || !KEY_REGEX.test(key)) {
                return err(`Invalid config key ${JSON.stringify(key)}: must match /^[a-z][a-z0-9_.-]{0,63}$/i`);
            }
            const rawValue = args['value'];
            if (typeof rawValue === 'string') {
                const trimmed = rawValue.trim();
                if ((trimmed.startsWith('[') && trimmed.endsWith(']')) ||
                    (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
                    try {
                        const parsed = JSON.parse(trimmed);
                        if (typeof parsed === 'object' && parsed !== null) {
                            return err(`config value for key=${JSON.stringify(key)} looks like a pre-serialized JSON ${Array.isArray(parsed) ? 'array' : 'object'} (passed as a string). Pass the raw value directly — e.g. value=["main"], not value="[\\"main\\"]". The server calls JSON.stringify() on whatever you pass; double-encoding it breaks downstream consumers that expect the original shape.`);
                        }
                    }
                    catch {
                        // not valid JSON — fall through, treat as a plain string value
                    }
                }
            }
            let valueJson;
            try {
                valueJson = JSON.stringify(rawValue);
            }
            catch {
                return err('config value not JSON-serializable');
            }
            db.run(`INSERT INTO plugin_config (key, value_json)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`, [key, valueJson]);
            return ok({ key });
        })),
        config_get: wrapHandler(async (args) => {
            const key = args['key'];
            const row = db.get(`SELECT key, value_json FROM plugin_config WHERE key = ?`, [key]);
            if (!row) {
                return ok(null);
            }
            let parsed;
            try {
                parsed = JSON.parse(row.value_json);
            }
            catch {
                return err(`config key ${JSON.stringify(key)}: stored value is not valid JSON — raw: ${row.value_json.slice(0, 200)}`);
            }
            return ok(parsed);
        }),
        config_list: wrapHandler(async () => {
            const rows = db.all(`SELECT key, value_json FROM plugin_config ORDER BY key`);
            const result = {};
            for (const row of rows) {
                try {
                    result[row.key] = JSON.parse(row.value_json);
                }
                catch {
                    return err(`config key ${JSON.stringify(row.key)}: stored value is not valid JSON — raw: ${row.value_json.slice(0, 200)}`);
                }
            }
            return ok(result);
        }),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=config.js.map