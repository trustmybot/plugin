import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
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

function wrapHandler(fn: (args: Record<string, unknown>) => Promise<CallToolResult>): Fn {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return err((e as Error).message);
    }
  };
}

const VALID_TARGETS = new Set([
  'file_registry',
  'codebase_tree',
  'erd',
  'module_graph',
  'changelog',
]);

const SHA_REGEX = /^[0-9a-f]{7,40}$/i;

type RegenStateRow = {
  target: string;
  last_regen_at: string | null;
  last_seen_sha: string | null;
  notes: string;
};

function validateTarget(raw: unknown): string | null {
  if (typeof raw !== 'string' || !VALID_TARGETS.has(raw)) return null;
  return raw;
}

export function regenStateTools(db: TrajectoryDB): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'regen_state_get',
      description:
        'Get the regen_state row for a given target. Returns null when the target has never regenerated.',
      inputSchema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description:
              'One of: file_registry | codebase_tree | erd | module_graph | changelog',
          },
        },
        required: ['target'],
      },
    },
    {
      name: 'regen_state_set',
      description:
        'Upsert the regen_state row for a target. Defaults: last_regen_at=now, last_seen_sha="", notes="". Returns the upserted row.',
      inputSchema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description:
              'One of: file_registry | codebase_tree | erd | module_graph | changelog',
          },
          last_regen_at: {
            type: 'string',
            description: 'ISO 8601 timestamp. Defaults to now if omitted.',
          },
          last_seen_sha: {
            type: 'string',
            description:
              '7-40 hex chars, or empty string for "no SHA yet". Defaults to "" if omitted.',
          },
          notes: {
            type: 'string',
            description: 'Optional notes, max 2000 chars.',
          },
        },
        required: ['target'],
      },
    },
  ];

  const handlers: Record<string, Fn> = {
    regen_state_get: wrapHandler(async (args) => {
      const target = validateTarget(args['target']);
      if (target === null) {
        return err(
          `Invalid target ${JSON.stringify(args['target'])}: must be one of file_registry, codebase_tree, erd, module_graph, changelog`,
        );
      }

      const row = db.get<RegenStateRow>(
        `SELECT target, last_regen_at, last_seen_sha, notes FROM regen_state WHERE target = ?`,
        [target],
      );

      if (!row) {
        return ok(null);
      }

      return ok({
        target: row.target,
        last_regen_at: row.last_regen_at,
        last_seen_sha: row.last_seen_sha,
        notes: row.notes,
      });
    }),

    regen_state_set: requireRoles('regen_state_set', ['architect', 'gatekeeper', 'pr-reviewer'], wrapHandler(async (args) => {
      const target = validateTarget(args['target']);
      if (target === null) {
        return err(
          `Invalid target ${JSON.stringify(args['target'])}: must be one of file_registry, codebase_tree, erd, module_graph, changelog`,
        );
      }

      const rawSha = args['last_seen_sha'];
      let lastSeenSha = '';
      if (rawSha !== undefined && rawSha !== null) {
        if (typeof rawSha !== 'string') {
          return err('last_seen_sha must be a string');
        }
        if (rawSha !== '' && !SHA_REGEX.test(rawSha)) {
          return err(
            `Invalid last_seen_sha ${JSON.stringify(rawSha)}: must be a 7-40 char hex string or empty string`,
          );
        }
        lastSeenSha = rawSha;
      }

      const rawNotes = args['notes'];
      let notes = '';
      if (rawNotes !== undefined && rawNotes !== null) {
        if (typeof rawNotes !== 'string') {
          return err('notes must be a string');
        }
        if (rawNotes.length > 2000) {
          return err('notes must be 2000 chars or fewer');
        }
        notes = rawNotes;
      }

      const rawRegenAt = args['last_regen_at'];
      let lastRegenAt: string;
      if (rawRegenAt !== undefined && rawRegenAt !== null) {
        if (typeof rawRegenAt !== 'string') {
          return err('last_regen_at must be a string');
        }
        lastRegenAt = rawRegenAt;
      } else {
        lastRegenAt = nowISO();
      }

      db.run(
        `INSERT INTO regen_state (target, last_regen_at, last_seen_sha, notes)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(target) DO UPDATE SET
           last_regen_at = excluded.last_regen_at,
           last_seen_sha = excluded.last_seen_sha,
           notes = excluded.notes`,
        [target, lastRegenAt, lastSeenSha, notes],
      );

      const row = db.get<RegenStateRow>(
        `SELECT target, last_regen_at, last_seen_sha, notes FROM regen_state WHERE target = ?`,
        [target],
      );

      return ok({
        target: row!.target,
        last_regen_at: row!.last_regen_at,
        last_seen_sha: row!.last_seen_sha,
        notes: row!.notes,
      });
    })),
  };

  return { definitions, handlers };
}
