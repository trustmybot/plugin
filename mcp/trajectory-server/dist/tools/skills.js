import { nowISO } from '../db.js';
const VALID_TRUST_TIERS = new Set(['curated', 'agent']);
const VALID_STATUS_TRANSITIONS = new Map([
    ['draft', new Set(['pending_review'])],
    ['pending_review', new Set(['active'])],
    ['active', new Set(['deprecated'])],
]);
const VALID_TIER_TRANSITIONS = new Map([
    ['agent', new Set(['curated'])],
]);
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
export function skillTools(db) {
    const definitions = [
        {
            name: 'skill_register',
            description: 'Register a new skill. Status defaults to draft.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    file_path: { type: 'string' },
                    trust_tier: { type: 'string', enum: ['curated', 'agent'] },
                },
                required: ['agent', 'name', 'description', 'file_path', 'trust_tier'],
            },
        },
        {
            name: 'skill_record_outcome',
            description: 'Record a success or failure outcome for a skill, updating effectiveness.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    name: { type: 'string' },
                    success: { type: 'boolean' },
                },
                required: ['agent', 'name', 'success'],
            },
        },
        {
            name: 'skill_promote',
            description: 'Promote or deprecate a skill status or trust_tier.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    name: { type: 'string' },
                    from_status: { type: 'string' },
                    to_status: { type: 'string' },
                },
                required: ['agent', 'name', 'from_status', 'to_status'],
            },
        },
    ];
    const handlers = {
        skill_register: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const name = requireArg(args, 'name');
            const description = requireArg(args, 'description');
            const filePath = requireArg(args, 'file_path');
            const trustTier = requireArg(args, 'trust_tier');
            if (!VALID_TRUST_TIERS.has(trustTier)) {
                throw new Error(`Invalid trust_tier: "${trustTier}". Allowed values: ${[...VALID_TRUST_TIERS].join(', ')}`);
            }
            const now = nowISO();
            db.run(`INSERT INTO skills
           (name, description, file_path, trust_tier, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'draft', ?, ?)`, [name, description, filePath, trustTier, now, now]);
            const row = db.get('SELECT * FROM skills WHERE rowid = last_insert_rowid()');
            return ok(row);
        }),
        skill_record_outcome: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const name = requireArg(args, 'name');
            requireArg(args, 'success');
            const success = args['success'];
            const updated = db.transaction(() => {
                const skill = db.get('SELECT * FROM skills WHERE name = ?', [name]);
                if (!skill) {
                    throw new Error(`Skill not registered: ${name}`);
                }
                const now = nowISO();
                const newUses = skill.uses + 1;
                const newSuccesses = skill.successes + (success ? 1 : 0);
                const newEffectiveness = newSuccesses / newUses;
                db.run(`UPDATE skills
           SET uses = ?, successes = ?, effectiveness = ?, updated_at = ?
           WHERE name = ?`, [newUses, newSuccesses, newEffectiveness, now, name]);
                return db.get('SELECT * FROM skills WHERE name = ?', [name]);
            });
            return ok(updated);
        }),
        skill_promote: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const name = requireArg(args, 'name');
            const fromStatus = requireArg(args, 'from_status');
            const toStatus = requireArg(args, 'to_status');
            const skill = db.get('SELECT * FROM skills WHERE name = ?', [name]);
            if (!skill) {
                throw new Error(`Skill not registered: ${name}`);
            }
            const isStatusTransition = VALID_STATUS_TRANSITIONS.get(fromStatus)?.has(toStatus) ?? false;
            const isTierTransition = VALID_TIER_TRANSITIONS.get(fromStatus)?.has(toStatus) ?? false;
            if (!isStatusTransition && !isTierTransition) {
                throw new Error(`Invalid transition: ${fromStatus}→${toStatus}`);
            }
            const now = nowISO();
            if (isStatusTransition) {
                db.run(`UPDATE skills SET status = ?, updated_at = ? WHERE name = ?`, [toStatus, now, name]);
            }
            else {
                db.run(`UPDATE skills SET trust_tier = ?, updated_at = ? WHERE name = ?`, [toStatus, now, name]);
            }
            const updated = db.get('SELECT * FROM skills WHERE name = ?', [name]);
            return ok(updated);
        }),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=skills.js.map