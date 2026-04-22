import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';

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

function wrapHandler(fn: (args: Record<string, unknown>) => Promise<CallToolResult>): Fn {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      const msg = (e as Error & { code?: string }).message;
      const code = (e as Error & { code?: string }).code;
      if (code === 'SQLITE_CONSTRAINT_CHECK' || code === 'SQLITE_CONSTRAINT') {
        return err(`DB constraint violation: ${msg}`);
      }
      return err(msg);
    }
  };
}

const NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9 _.-]{0,31}$/;

const DEFAULT_IDENTITY = {
  gatekeeper_name: 'bro',
  human_name: null,
  created_at: null,
  updated_at: null,
};

type IdentityRow = {
  id: number;
  gatekeeper_name: string;
  human_name: string | null;
  created_at: string;
  updated_at: string;
};

export function identityTools(db: TrajectoryDB): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'identity_get',
      description:
        "Get the plugin identity (gatekeeper name + human name). Returns defaults when no identity has been set.",
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'identity_set',
      description:
        'Set gatekeeper_name and/or human_name. Omitted fields are preserved (COALESCE semantics).',
      inputSchema: {
        type: 'object',
        properties: {
          gatekeeper_name: {
            type: 'string',
            description: '1-32 chars, must start with a letter',
          },
          human_name: {
            type: 'string',
            description: '1-32 chars, must start with a letter',
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

  const handlers: Record<string, Fn> = {
    identity_get: wrapHandler(async () => {
      const row = db.get<IdentityRow>(`SELECT * FROM identity LIMIT 1`);
      if (!row) {
        return ok(DEFAULT_IDENTITY);
      }
      return ok({
        gatekeeper_name: row.gatekeeper_name,
        human_name: row.human_name,
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
    }),

    identity_set: wrapHandler(async (args) => {
      const rawGatekeeper = args['gatekeeper_name'];
      const rawHuman = args['human_name'];

      const hasGatekeeper = rawGatekeeper !== undefined && rawGatekeeper !== null;
      const hasHuman = rawHuman !== undefined && rawHuman !== null;

      if (!hasGatekeeper && !hasHuman) {
        const row = db.get<IdentityRow>(`SELECT * FROM identity LIMIT 1`);
        if (!row) return ok(DEFAULT_IDENTITY);
        return ok({
          gatekeeper_name: row.gatekeeper_name,
          human_name: row.human_name,
          created_at: row.created_at,
          updated_at: row.updated_at,
        });
      }

      if (hasGatekeeper) {
        if (typeof rawGatekeeper !== 'string' || !NAME_REGEX.test(rawGatekeeper)) {
          return err(
            `Invalid gatekeeper_name ${JSON.stringify(rawGatekeeper)}: must match /^[a-zA-Z][a-zA-Z0-9 _.-]{0,31}$/`,
          );
        }
      }

      if (hasHuman) {
        if (typeof rawHuman !== 'string' || !NAME_REGEX.test(rawHuman)) {
          return err(
            `Invalid human_name ${JSON.stringify(rawHuman)}: must match /^[a-zA-Z][a-zA-Z0-9 _.-]{0,31}$/`,
          );
        }
      }

      const now = nowISO();
      const gatekeeperValue = hasGatekeeper ? (rawGatekeeper as string) : null;
      const humanValue = hasHuman ? (rawHuman as string) : null;

      const existingRow = db.get<IdentityRow>(`SELECT * FROM identity WHERE id = 1`);
      if (existingRow) {
        const newGatekeeper = gatekeeperValue ?? existingRow.gatekeeper_name;
        const newHuman = humanValue ?? existingRow.human_name;
        db.run(
          `UPDATE identity SET gatekeeper_name = ?, human_name = ?, updated_at = ? WHERE id = 1`,
          [newGatekeeper, newHuman, now],
        );
      } else {
        db.run(
          `INSERT INTO identity (id, gatekeeper_name, human_name, created_at, updated_at)
           VALUES (1, COALESCE(?, 'bro'), ?, ?, ?)`,
          [gatekeeperValue, humanValue, now, now],
        );
      }

      const row = db.get<IdentityRow>(`SELECT * FROM identity WHERE id = 1`);
      return ok({
        gatekeeper_name: row!.gatekeeper_name,
        human_name: row!.human_name,
        created_at: row!.created_at,
        updated_at: row!.updated_at,
      });
    }),

    identity_reset: wrapHandler(async () => {
      db.run(`DELETE FROM identity`);
      return ok({ ok: true });
    }),
  };

  return { definitions, handlers };
}
