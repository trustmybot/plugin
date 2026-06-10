import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';

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

export function agentTools(db: TrajectoryDB): {
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
      description: 'Register a new agent. Returns existing row unchanged if name already present (INSERT OR IGNORE).',
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

      db.run(
        `INSERT OR IGNORE INTO agents (name, kind, scope, file_path)
         VALUES (?, ?, ?, ?)`,
        [name, kind, scope, filePath],
      );

      const row = db.get<Agent>('SELECT * FROM agents WHERE name = ?', [name]);

      // When a new project-local consultant is inserted, emit a tmb_agent_created
      // audit row automatically. changes() > 0 distinguishes a real insert from
      // an INSERT OR IGNORE no-op (idempotent re-registration).
      if (scope === 'project-local' && kind === 'consultant') {
        const changed = db.get<{ n: number }>('SELECT changes() AS n', []);
        if (changed && changed.n > 0 && row) {
          const contentJson = JSON.stringify({ name, mode: 'agent_register', agent_id: row.id });
          db.run(
            `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (-1, NULL, ?, 'tmb_agent_created', ?, ?, datetime('now'))`,
            [String(args['agent']), `Agent registered: ${name}`, contentJson],
          );
        }
      }

      return ok(row);
    }),
  };

  return { definitions, handlers };
}
