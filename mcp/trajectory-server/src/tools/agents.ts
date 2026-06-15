import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function requireArg(args: Record<string, unknown>, name: string): unknown {
  if (args[name] === undefined || args[name] === null) {
    throw new Error(`Missing required arg: ${name}`);
  }
  return args[name];
}

function wrapHandler(fn: (args: Record<string, unknown>) => Promise<CallToolResult>): Fn {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return err((e as Error).message);
    }
  };
}

interface Agent {
  id: number;
  name: string;
  kind: string;
  scope: string;
  file_path: string;
  status: string;
  created_at: string;
  updated_at: string;
}

const VALID_KINDS = new Set(['backbone', 'consultant']);
const VALID_SCOPES = new Set(['global', 'template', 'project-local']);

// 'bro' is permanently reserved — it is the orchestrator persona loaded at
// bro-session start; registering it as an agent would shadow the persona.
// 'swe' and 'pr-reviewer' are backbone roles whose scope is fixed at 'global';
// a project-local registration with the same name would silently deactivate
// the global backbone, so we reject exact-name + scope-mismatch combinations.
const RESERVED_NAME = 'bro';
const BACKBONE_GLOBAL_ONLY = new Set(['swe', 'pr-reviewer']);

// Plugin root holds templates/agents/<name>.md. CC always sets
// CLAUDE_PLUGIN_ROOT to the installed plugin's source root (L6 sets it via
// --plugin-dir); prefer it. Fall back to walking up from this module until a
// dir with .claude-plugin/plugin.json is found — correct for BOTH the tsc
// layout (dist/tools/agents.js) and the esbuild bundle (dist/index.js), which
// sit at different depths. No hardcoded dirname count.
function resolvePluginRoot(): string {
  const env = process.env['CLAUDE_PLUGIN_ROOT'];
  if (env && existsSync(join(env, '.claude-plugin', 'plugin.json'))) return env;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort: trust CLAUDE_PLUGIN_ROOT even without a verified manifest.
  return env ?? dirname(fileURLToPath(import.meta.url));
}

const PLUGIN_ROOT = resolvePluginRoot();

function resolveWorkspaceRoot(dbPath: string): string {
  if (!dbPath || dbPath === ':memory:') return '';
  return dbPath.replace(/\.claude\/[^/]+\/trajectory\.db$/, '').replace(/\/$/, '');
}

function validateAgentName(name: string): void {
  if (name === RESERVED_NAME) {
    throw new Error(
      `agent_resolve rejected: '${name}' is a reserved orchestrator name and cannot be registered as an agent. ` +
      `Choose a different name for your consultant (e.g. 'security-advisor', 'legal-reviewer').`,
    );
  }
  if (BACKBONE_GLOBAL_ONLY.has(name)) {
    throw new Error(
      `agent_resolve rejected: '${name}' is a backbone agent whose scope must be 'global'. ` +
      `A project-local '${name}' would shadow the backbone and disable it. ` +
      `To extend ${name}, create a differently-named consultant agent instead.`,
    );
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(
      `agent_resolve rejected: '${name}' is not a valid agent name. Names must be kebab-case (lowercase letters, digits, hyphens; must start with a letter).`,
    );
  }
}

export function agentTools(db: TrajectoryDB, dbPath = ''): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
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
      description: 'Register a new agent. Promotes a template-seeded row to project-local when called with scope=project-local; emits tmb_agent_created audit on insert or promotion. True idempotent re-registration (already project-local) is a silent no-op.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          name: { type: 'string' },
          kind: { type: 'string', enum: ['backbone', 'consultant'] },
          scope: { type: 'string', enum: ['global', 'template', 'project-local'] },
          file_path: { type: 'string' },
        },
        required: ['agent', 'name', 'kind', 'scope', 'file_path'],
      },
    },
    {
      name: 'agent_resolve',
      description:
        'Read-only: resolves creation mode for /tmb:agent-create. ' +
        'Validates the name, then returns one of three modes: ' +
        '"collision" (target path exists — bro runs collision dialog); ' +
        '"template-copy" (plugin template found — bro Writes the file then calls agent_register); ' +
        '"from-scratch" (no template — bro scaffolds from templates/agents/template.md then calls agent_register). ' +
        'Paths returned are absolute. bro owns the file Write and the agent_register call.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          name: { type: 'string', description: 'Kebab-case agent name to resolve.' },
        },
        required: ['agent', 'name'],
      },
    },
  ];

  const handlers: Record<string, Fn> = {
    agent_list: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const scope = args['scope'] as string | undefined;

      if (scope !== undefined && !VALID_SCOPES.has(scope)) {
        throw new Error(
          `Invalid scope: "${scope}". Allowed values: ${[...VALID_SCOPES].join(', ')}`,
        );
      }

      const rows = scope
        ? db.all<Agent>('SELECT * FROM agents WHERE scope = ? ORDER BY name', [scope])
        : db.all<Agent>('SELECT * FROM agents ORDER BY name');

      return ok({ agents: rows });
    }),

    agent_register: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const name = requireArg(args, 'name') as string;
      const kind = requireArg(args, 'kind') as string;
      const scope = requireArg(args, 'scope') as string;
      const filePath = requireArg(args, 'file_path') as string;

      if (!VALID_KINDS.has(kind)) {
        throw new Error(
          `Invalid kind: "${kind}". Allowed values: ${[...VALID_KINDS].join(', ')}`,
        );
      }
      if (!VALID_SCOPES.has(scope)) {
        throw new Error(
          `Invalid scope: "${scope}". Allowed values: ${[...VALID_SCOPES].join(', ')}`,
        );
      }

      if (name === RESERVED_NAME) {
        throw new Error(
          `agent_register rejected: '${name}' is a reserved orchestrator name and cannot be registered as an agent. ` +
          `Choose a different name for your consultant (e.g. 'security-advisor', 'legal-reviewer').`,
        );
      }
      if (BACKBONE_GLOBAL_ONLY.has(name) && scope !== 'global') {
        throw new Error(
          `agent_register rejected: '${name}' is a backbone agent whose scope must be 'global'. ` +
          `A project-local '${name}' would shadow the backbone and disable it. ` +
          `To extend ${name}, create a differently-named consultant agent instead.`,
        );
      }

      const existing = db.get<Agent>('SELECT * FROM agents WHERE name = ?', [name]);

      let promoted = false;
      if (existing) {
        if (scope === 'project-local' && (existing.scope === 'template')) {
          db.run(
            `UPDATE agents SET scope = ?, kind = ?, file_path = ?, updated_at = datetime('now')
             WHERE name = ?`,
            [scope, kind, filePath, name],
          );
          promoted = true;
        }
        // already project-local or other idempotent case: silent no-op
      } else {
        db.run(
          `INSERT INTO agents (name, kind, scope, file_path)
           VALUES (?, ?, ?, ?)`,
          [name, kind, scope, filePath],
        );
      }

      const row = db.get<Agent>('SELECT * FROM agents WHERE name = ?', [name]);

      const inserted = !existing && (db.get<{ n: number }>('SELECT changes() AS n', [])?.n ?? 0) > 0;
      if (scope === 'project-local' && kind === 'consultant' && (inserted || promoted) && row) {
        const contentJson = JSON.stringify({ name, mode: 'agent_register', agent_id: row.id });
        db.run(
          `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
           VALUES (-1, NULL, ?, 'tmb_agent_created', ?, ?, datetime('now'))`,
          [String(args['agent']), `Agent registered: ${name}`, contentJson],
        );
      }

      return ok(row);
    }),

    agent_resolve: requireRoles(
      'agent_resolve',
      ['bro'],
      wrapHandler(async (args) => {
        requireArg(args, 'agent');
        const name = requireArg(args, 'name') as string;

        validateAgentName(name);

        const workspaceRoot = resolveWorkspaceRoot(dbPath);
        const targetPath = workspaceRoot
          ? join(workspaceRoot, '.claude', 'agents', `${name}.md`)
          : join('.claude', 'agents', `${name}.md`);

        if (workspaceRoot && existsSync(targetPath)) {
          return ok({ mode: 'collision', existing_path: targetPath });
        }

        const templatePath = join(PLUGIN_ROOT, 'templates', 'agents', `${name}.md`);
        if (existsSync(templatePath)) {
          return ok({
            mode: 'template-copy',
            source_path: templatePath,
            target_path: targetPath,
          });
        }

        const scaffoldPath = join(PLUGIN_ROOT, 'templates', 'agents', 'template.md');
        return ok({
          mode: 'from-scratch',
          scaffold_path: scaffoldPath,
          target_path: targetPath,
        });
      }),
    ),
  };

  return { definitions, handlers };
}
