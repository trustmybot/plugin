// Identity tools — pure onboarded-marker. Bro doesn't ask for or store the
// user's name; the row's existence at id=1 is the whole signal. Row present
// = /onboard completed in this project; row absent = first-contact, fire
// /onboard. The legacy `human_name` column is migrated away in db.ts.

import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function wrapHandler(fn: (args: Record<string, unknown>) => Promise<CallToolResult>): Fn {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      const msg = (e as Error & { code?: string }).message;
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: msg }) }],
        isError: true,
      };
    }
  };
}

type IdentityRow = {
  id: number;
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
        'Probe whether /onboard has run in this project. Returns { onboarded: bool, created_at, updated_at }. Row absence (`onboarded: false`) is the auto-fire signal — bro should run /onboard immediately when this returns false.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'identity_set',
      description:
        'Mark the project as onboarded by inserting the identity row at id=1. Idempotent — calling on an already-onboarded project just bumps updated_at. No-args; the row is a pure marker, no name or other fields are stored.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'identity_reset',
      description:
        'Delete the identity row — flips the project back to first-contact state, so the next session auto-fires /onboard again.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ];

  const handlers: Record<string, Fn> = {
    identity_get: wrapHandler(async () => {
      const row = db.get<IdentityRow>(`SELECT id, created_at, updated_at FROM identity WHERE id = 1`);
      if (!row) {
        return ok({ onboarded: false, created_at: null, updated_at: null });
      }
      return ok({
        onboarded: true,
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
    }),

    identity_set: requireRoles(
      'identity_set',
      ['bro'],
      wrapHandler(async () => {
        const now = nowISO();
        db.run(
          `INSERT INTO identity (id, created_at, updated_at) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
          [now, now],
        );
        const row = db.get<IdentityRow>(`SELECT id, created_at, updated_at FROM identity WHERE id = 1`);
        return ok({
          onboarded: true,
          created_at: row!.created_at,
          updated_at: row!.updated_at,
        });
      }),
    ),

    identity_reset: requireRoles(
      'identity_reset',
      ['bro'],
      wrapHandler(async () => {
        db.run(`DELETE FROM identity`);
        return ok({ ok: true });
      }),
    ),
  };

  return { definitions, handlers };
}
