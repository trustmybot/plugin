import { nowISO } from '../db.js';
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
            const msg = e.message;
            const code = e.code;
            if (code === 'SQLITE_CONSTRAINT_CHECK' || code === 'SQLITE_CONSTRAINT') {
                return err(`DB constraint violation: ${msg}`);
            }
            return err(msg);
        }
    };
}
const NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9 _.-]{0,31}$/;
const DEFAULT_IDENTITY = {
    human_name: null,
    created_at: null,
    updated_at: null,
};
export function identityTools(db) {
    const definitions = [
        {
            name: 'identity_get',
            description: 'Get the human name on file for the project. Returns defaults when no identity has been set.',
            inputSchema: {
                type: 'object',
                properties: {},
            },
        },
        {
            name: 'identity_set',
            description: 'Set the identity row. Pass human_name to record a name, OR anonymous:true to record an anonymous identity (row exists with human_name=NULL). Both forms create a row; downstream code distinguishes "onboarded" by row existence (created_at is non-null), not by human_name nullity.',
            inputSchema: {
                type: 'object',
                properties: {
                    human_name: {
                        type: 'string',
                        description: '1-32 chars, must start with a letter. Mutually exclusive with anonymous.',
                    },
                    anonymous: {
                        type: 'boolean',
                        description: 'true to record an anonymous identity (human_name stored as NULL). Mutually exclusive with human_name.',
                    },
                },
            },
        },
        {
            name: 'identity_reset',
            description: 'Delete the identity row; identity_get will return defaults again.',
            inputSchema: {
                type: 'object',
                properties: {},
            },
        },
    ];
    const handlers = {
        identity_get: wrapHandler(async () => {
            const row = db.get(`SELECT * FROM identity LIMIT 1`);
            if (!row) {
                return ok(DEFAULT_IDENTITY);
            }
            return ok({
                human_name: row.human_name,
                created_at: row.created_at,
                updated_at: row.updated_at,
            });
        }),
        identity_set: requireRoles('identity_set', ['bro'], wrapHandler(async (args) => {
            const rawHuman = args['human_name'];
            const rawAnonymous = args['anonymous'];
            const hasHuman = rawHuman !== undefined && rawHuman !== null;
            const isAnonymous = rawAnonymous === true;
            if (hasHuman && isAnonymous) {
                return err('identity_set: pass either human_name OR anonymous:true, not both');
            }
            // No-arg call: probe current state without writing.
            if (!hasHuman && !isAnonymous) {
                const row = db.get(`SELECT * FROM identity LIMIT 1`);
                if (!row)
                    return ok(DEFAULT_IDENTITY);
                return ok({
                    human_name: row.human_name,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                });
            }
            let humanValue;
            if (isAnonymous) {
                humanValue = null;
            }
            else {
                if (typeof rawHuman !== 'string' || !NAME_REGEX.test(rawHuman)) {
                    return err(`Invalid human_name ${JSON.stringify(rawHuman)}: must match /^[a-zA-Z][a-zA-Z0-9 _.-]{0,31}$/`);
                }
                humanValue = rawHuman;
            }
            const now = nowISO();
            const existingRow = db.get(`SELECT * FROM identity WHERE id = 1`);
            if (existingRow) {
                db.run(`UPDATE identity SET human_name = ?, updated_at = ? WHERE id = 1`, [humanValue, now]);
            }
            else {
                db.run(`INSERT INTO identity (id, human_name, created_at, updated_at) VALUES (1, ?, ?, ?)`, [humanValue, now, now]);
            }
            const row = db.get(`SELECT * FROM identity WHERE id = 1`);
            return ok({
                human_name: row.human_name,
                created_at: row.created_at,
                updated_at: row.updated_at,
            });
        })),
        identity_reset: requireRoles('identity_reset', ['bro'], wrapHandler(async () => {
            db.run(`DELETE FROM identity`);
            return ok({ ok: true });
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=identity.js.map