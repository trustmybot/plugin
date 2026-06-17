import { nowISO } from '../db.js';
const VALID_TRUST_TIERS = new Set(['curated', 'agent']);
// Skill name must be kebab-case: starts with a lowercase letter, followed by
// lowercase letters, digits, or hyphens, max 64 chars total. The tmb_ prefix
// (with underscore, not hyphen) is reserved for plugin-shipped skills registered
// at scope='global'; user-created skills at scope='project-local' or 'template'
// must not use it to avoid confusion with the canonical plugin catalog.
const SKILL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
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
const VALID_SCOPES = new Set(['global', 'template', 'project-local']);
export function skillTools(db) {
    const definitions = [
        {
            name: 'skill_register',
            description: 'Register a new skill. Status defaults to draft. Scope defaults to project-local (the common case for tmb_skill-creator output); plugin-shipped skills are schema-seeded with scope=global.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    file_path: { type: 'string' },
                    trust_tier: { type: 'string', enum: ['curated', 'agent'] },
                    scope: {
                        type: 'string',
                        enum: ['global', 'template', 'project-local'],
                        description: 'Defaults to project-local.',
                    },
                },
                required: ['agent', 'name', 'description', 'file_path', 'trust_tier'],
            },
        },
        {
            name: 'skill_invocations_list',
            description: 'List skill_invocations rows. Bidirectional: filter by skill_name (which agent_runs used skill X?) or by agent_run_id/task_id (what did this run/task touch?).',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    skill_name: { type: 'string' },
                    agent_run_id: { type: 'integer' },
                    task_id: { type: 'integer' },
                    limit: { type: 'integer', description: 'Default 200, max 1000.' },
                },
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
            const scope = args['scope'] ?? 'project-local';
            if (!VALID_TRUST_TIERS.has(trustTier)) {
                throw new Error(`Invalid trust_tier: "${trustTier}". Allowed values: ${[...VALID_TRUST_TIERS].join(', ')}`);
            }
            if (!VALID_SCOPES.has(scope)) {
                throw new Error(`Invalid scope: "${scope}". Allowed values: ${[...VALID_SCOPES].join(', ')}`);
            }
            if (!SKILL_NAME_RE.test(name)) {
                throw new Error(`skill_register rejected: invalid name "${name}". ` +
                    `Skill names must match ^[a-z][a-z0-9-]{0,63}$ — ` +
                    `lowercase letters, digits, and hyphens only, starting with a letter, max 64 chars. ` +
                    `Examples: my-skill, data-export-v2.`);
            }
            if (name.startsWith('tmb_') && scope !== 'global') {
                throw new Error(`skill_register rejected: the 'tmb_' prefix is reserved for plugin-shipped global skills. ` +
                    `Rename your skill (e.g. replace 'tmb_' with your project prefix) or set scope='global' ` +
                    `if you are contributing an official plugin skill.`);
            }
            const now = nowISO();
            // Skills are origin='builtin' rows in the unified cheatcodes registry
            // (#101): kind='skill', source_url NULL, installed_at mirrors created_at.
            db.run(`INSERT INTO cheatcodes
           (name, kind, origin, description, file_path, scope, trust_tier, status, installed_at, created_at, updated_at)
         VALUES (?, 'skill', 'builtin', ?, ?, ?, ?, 'draft', ?, ?, ?)`, [name, description, filePath, scope, trustTier, now, now, now]);
            const row = db.get('SELECT * FROM cheatcodes WHERE rowid = last_insert_rowid()');
            return ok(row);
        }),
        skill_invocations_list: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const filters = [];
            const params = [];
            if (typeof args['skill_name'] === 'string') {
                filters.push('skill_name = ?');
                params.push(args['skill_name']);
            }
            if (args['agent_run_id'] !== undefined && args['agent_run_id'] !== null) {
                filters.push('agent_run_id = ?');
                params.push(Number(args['agent_run_id']));
            }
            if (args['task_id'] !== undefined && args['task_id'] !== null) {
                filters.push('task_id = ?');
                params.push(Number(args['task_id']));
            }
            const where = filters.length > 0 ? 'WHERE ' + filters.join(' AND ') : '';
            const limit = Math.min(Math.max(1, Number(args['limit'] ?? 200)), 1000);
            params.push(limit);
            const rows = db.all(`SELECT id, skill_name, agent_name, agent_run_id, task_id, invoked_at, outcome
           FROM skill_invocations
           ${where}
           ORDER BY id DESC
           LIMIT ?`, params);
            return ok({ rows, count: rows.length });
        }),
        skill_promote: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const name = requireArg(args, 'name');
            const fromStatus = requireArg(args, 'from_status');
            const toStatus = requireArg(args, 'to_status');
            const skill = db.get(`SELECT * FROM cheatcodes WHERE name = ? AND origin = 'builtin'`, [name]);
            if (!skill) {
                throw new Error(`Skill not registered: ${name}`);
            }
            const isStatusTransition = VALID_STATUS_TRANSITIONS.get(fromStatus)?.has(toStatus) ?? false;
            const isTierTransition = VALID_TIER_TRANSITIONS.get(fromStatus)?.has(toStatus) ?? false;
            if (!isStatusTransition && !isTierTransition) {
                throw new Error(`Invalid transition: ${fromStatus}→${toStatus}`);
            }
            if (isStatusTransition && skill.status !== fromStatus) {
                throw new Error(`skill_promote rejected: skill '${name}' is in status '${skill.status}', not '${fromStatus}'. ` +
                    `from_status must match the skill's current status.`);
            }
            if (isTierTransition && skill.trust_tier !== fromStatus) {
                throw new Error(`skill_promote rejected: skill '${name}' has trust_tier '${skill.trust_tier}', not '${fromStatus}'. ` +
                    `from_status must match the skill's current trust_tier for tier transitions.`);
            }
            const now = nowISO();
            if (isStatusTransition) {
                db.run(`UPDATE cheatcodes SET status = ?, updated_at = ? WHERE name = ? AND origin = 'builtin'`, [toStatus, now, name]);
            }
            else {
                db.run(`UPDATE cheatcodes SET trust_tier = ?, updated_at = ? WHERE name = ? AND origin = 'builtin'`, [toStatus, now, name]);
            }
            const updated = db.get(`SELECT * FROM cheatcodes WHERE name = ? AND origin = 'builtin'`, [name]);
            return ok(updated);
        }),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=skills.js.map