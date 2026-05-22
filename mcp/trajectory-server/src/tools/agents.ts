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

      // UPSERT: insert new agent, OR update kind/scope/file_path on an existing
      // row when any of them actually changed. This is the meaningful case
      // when bro promotes a template-scope seed row to a project-local
      // instance (Branch B in tmb_agent-creator): the existing 'template'
      // row must be updated, not left alone.
      db.run(
        `INSERT INTO agents (name, kind, scope, file_path)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           kind = excluded.kind,
           scope = excluded.scope,
           file_path = excluded.file_path
         WHERE agents.kind != excluded.kind
            OR agents.scope != excluded.scope
            OR agents.file_path != excluded.file_path`,
        [name, kind, scope, filePath],
      );

      const row = db.get<Agent>('SELECT * FROM agents WHERE name = ?', [name]);

      // When a project-local consultant is registered (insert OR meaningful
      // upsert), emit a tmb_agent_created audit row automatically. This closes
      // the detection loop even when bro calls agent_register without a
      // subsequent explicit audit_log call. changes() > 0 covers both cases —
      // pure no-op re-registrations leave changes() == 0 and skip the audit.
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
