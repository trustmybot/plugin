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
  tmb_owner: string;
  status: string;
  created_at: string;
  updated_at: string;
}

const VALID_KINDS = new Set(['backbone', 'consultant']);
const VALID_SCOPES = new Set(['global', 'template', 'project-local']);
const VALID_TMB_OWNERS = new Set(['bro', 'user-adopted', 'user']);

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
          tmb_owner: { type: 'string', enum: ['bro', 'user-adopted', 'user'] },
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
      const tmbOwner = (args['tmb_owner'] as string | undefined) ?? 'bro';

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
      if (!VALID_TMB_OWNERS.has(tmbOwner)) {
        throw new Error(
          `Invalid tmb_owner: "${tmbOwner}". Allowed values: ${[...VALID_TMB_OWNERS].join(', ')}`,
        );
      }

      db.run(
        `INSERT OR IGNORE INTO agents (name, kind, scope, file_path, tmb_owner)
         VALUES (?, ?, ?, ?, ?)`,
        [name, kind, scope, filePath, tmbOwner],
      );

      const row = db.get<Agent>('SELECT * FROM agents WHERE name = ?', [name]);
      return ok(row);
    }),
  };

  return { definitions, handlers };
}
