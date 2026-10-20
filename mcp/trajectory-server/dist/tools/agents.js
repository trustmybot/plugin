import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { insertAudit } from './audit.js';
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
const VALID_ROOTS = new Set(['plugin', 'project']);
// 'bro' is permanently reserved — it is the orchestrator persona loaded at
// bro-session start; registering it as an agent would shadow the persona.
// 'swe' and 'pr-reviewer' are backbone roles that ship with the plugin; a
// project: registration with the same name would shadow the plugin's file and
// silently deactivate the backbone, so only a plugin: path is accepted for them.
const RESERVED_NAME = 'bro';
const BACKBONE_PLUGIN_ONLY = new Set(['swe', 'pr-reviewer']);
// Plugin root holds templates/agents/<name>.md. CC always sets
// CLAUDE_PLUGIN_ROOT to the installed plugin's source root (L6 sets it via
// --plugin-dir); prefer it. Fall back to walking up from this module until a
// dir with .claude-plugin/plugin.json is found — correct for BOTH the tsc
// layout (dist/tools/agents.js) and the esbuild bundle (dist/index.js), which
// sit at different depths. No hardcoded dirname count.
function resolvePluginRoot() {
    const env = process.env['CLAUDE_PLUGIN_ROOT'];
    if (env && existsSync(join(env, '.claude-plugin', 'plugin.json')))
        return env;
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
        if (existsSync(join(dir, '.claude-plugin', 'plugin.json')))
            return dir;
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    // Last resort: trust CLAUDE_PLUGIN_ROOT even without a verified manifest.
    return env ?? dirname(fileURLToPath(import.meta.url));
}
const PLUGIN_ROOT = resolvePluginRoot();
function resolveWorkspaceRoot(dbPath) {
    if (!dbPath || dbPath === ':memory:')
        return '';
    return dbPath.replace(/\.claude\/[^/]+\/trajectory\.db$/, '').replace(/\/$/, '');
}
function parseMarkedPath(filePath) {
    const m = /^(plugin|project):(.+)$/.exec(filePath);
    if (!m) {
        throw new Error(`invalid_file_path: '${filePath}' carries no root marker. ` +
            `Use 'plugin:<path under the plugin root>' (e.g. 'plugin:templates/agents/cto.md') ` +
            `or 'project:<path under the workspace root>' (e.g. 'project:.claude/agents/cto.md').`);
    }
    return { root: m[1], rel: m[2] };
}
function resolveMarkedPath(filePath, workspaceRoot) {
    const { root, rel } = parseMarkedPath(filePath);
    if (root === 'plugin')
        return join(PLUGIN_ROOT, rel);
    return workspaceRoot ? join(workspaceRoot, rel) : null;
}
function backboneShadowError(tool, name) {
    return new Error(`${tool} rejected: '${name}' is a backbone agent whose file_path must be plugin:. ` +
        `A project: '${name}' would shadow the backbone and disable it. ` +
        `To extend ${name}, create a differently-named consultant agent instead.`);
}
function validateAgentName(name) {
    if (name === RESERVED_NAME) {
        throw new Error(`agent_resolve rejected: '${name}' is a reserved orchestrator name and cannot be registered as an agent. ` +
            `Choose a different name for your consultant (e.g. 'security-advisor', 'legal-reviewer').`);
    }
    if (BACKBONE_PLUGIN_ONLY.has(name)) {
        throw backboneShadowError('agent_resolve', name);
    }
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
        throw new Error(`agent_resolve rejected: '${name}' is not a valid agent name. Names must be kebab-case (lowercase letters, digits, hyphens; must start with a letter).`);
    }
}
export function agentTools(db, dbPath = '') {
    const definitions = [
        {
            name: 'agent_list',
            description: 'List registered agents, optionally filtered by the root their file_path ships from. Each row carries resolved_path.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    root: { type: 'string', enum: ['plugin', 'project'] },
                },
                required: ['agent'],
            },
        },
        {
            name: 'agent_register',
            description: "Register a new agent. file_path carries its root: 'plugin:<path>' or 'project:<path>'. A project: path promotes a plugin: consultant row; emits tmb_agent_created on a project: consultant insert or promotion. Re-registration is a no-op. Returns the row with resolved_path.",
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    name: { type: 'string' },
                    kind: { type: 'string', enum: ['backbone', 'consultant'] },
                    file_path: { type: 'string', description: "'plugin:<path>' or 'project:<path>'." },
                },
                required: ['agent', 'name', 'kind', 'file_path'],
            },
        },
        {
            name: 'agent_resolve',
            description: 'Read-only: resolves creation mode for /tmb:agent-create. ' +
                'Validates the name, then returns one of three modes: ' +
                '"collision" (resolved_path exists — bro runs collision dialog); ' +
                '"template-copy" (plugin template found — bro Writes the file then calls agent_register); ' +
                '"from-scratch" (no template — bro scaffolds from templates/agents/template.md then calls agent_register). ' +
                'Returns file_path (marked, pass it to agent_register) and its absolute resolved_path. bro owns the file Write and the agent_register call.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    name: { type: 'string', description: 'Kebab-case agent name to resolve.' },
                    file_path: { type: 'string', description: "Target 'plugin:<path>' or 'project:<path>'; default 'project:.claude/agents/<name>.md'." },
                },
                required: ['agent', 'name'],
            },
        },
    ];
    const workspaceRoot = resolveWorkspaceRoot(dbPath);
    const withResolvedPath = (row) => ({
        ...row,
        resolved_path: resolveMarkedPath(row.file_path, workspaceRoot),
    });
    const handlers = {
        agent_list: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const root = args['root'];
            if (root !== undefined && !VALID_ROOTS.has(root)) {
                throw new Error(`Invalid root: "${root}". Allowed values: ${[...VALID_ROOTS].join(', ')}`);
            }
            const rows = root
                ? db.all('SELECT * FROM agents WHERE file_path LIKE ? ORDER BY name', [`${root}:%`])
                : db.all('SELECT * FROM agents ORDER BY name');
            return ok({ agents: rows.map(withResolvedPath) });
        }),
        agent_register: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const name = requireArg(args, 'name');
            const kind = requireArg(args, 'kind');
            const filePath = requireArg(args, 'file_path');
            if (!VALID_KINDS.has(kind)) {
                throw new Error(`Invalid kind: "${kind}". Allowed values: ${[...VALID_KINDS].join(', ')}`);
            }
            const { root } = parseMarkedPath(filePath);
            if (name === RESERVED_NAME) {
                throw new Error(`agent_register rejected: '${name}' is a reserved orchestrator name and cannot be registered as an agent. ` +
                    `Choose a different name for your consultant (e.g. 'security-advisor', 'legal-reviewer').`);
            }
            if (BACKBONE_PLUGIN_ONLY.has(name) && root !== 'plugin') {
                throw backboneShadowError('agent_register', name);
            }
            const existing = db.get('SELECT * FROM agents WHERE name = ?', [name]);
            let promoted = false;
            if (existing) {
                if (root === 'project' && existing.kind === 'consultant' && existing.file_path.startsWith('plugin:')) {
                    db.run(`UPDATE agents SET kind = ?, file_path = ?, updated_at = ?
             WHERE name = ?`, [kind, filePath, nowISO(), name]);
                    promoted = true;
                }
            }
            else {
                db.run(`INSERT INTO agents (name, kind, file_path)
           VALUES (?, ?, ?)`, [name, kind, filePath]);
            }
            const row = db.get('SELECT * FROM agents WHERE name = ?', [name]);
            const inserted = !existing && (db.get('SELECT changes() AS n', [])?.n ?? 0) > 0;
            if (root === 'project' && kind === 'consultant' && (inserted || promoted) && row) {
                const contentJson = JSON.stringify({ name, mode: 'agent_register', agent_id: row.id });
                insertAudit(db, {
                    issue_id: -1,
                    from_node: String(args['agent']),
                    event_type: 'tmb_agent_created',
                    summary: `Agent registered: ${name}`,
                    content_json: contentJson,
                });
            }
            return ok(row ? withResolvedPath(row) : row);
        }),
        agent_resolve: requireRoles('agent_resolve', ['bro'], wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const name = requireArg(args, 'name');
            validateAgentName(name);
            const filePath = args['file_path'] ?? `project:.claude/agents/${name}.md`;
            const resolvedPath = resolveMarkedPath(filePath, workspaceRoot);
            const target = { file_path: filePath, resolved_path: resolvedPath };
            if (resolvedPath && existsSync(resolvedPath)) {
                return ok({ mode: 'collision', ...target });
            }
            const templatePath = join(PLUGIN_ROOT, 'templates', 'agents', `${name}.md`);
            if (existsSync(templatePath)) {
                return ok({ mode: 'template-copy', source_path: templatePath, ...target });
            }
            const scaffoldPath = join(PLUGIN_ROOT, 'templates', 'agents', 'template.md');
            return ok({ mode: 'from-scratch', scaffold_path: scaffoldPath, ...target });
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=agents.js.map