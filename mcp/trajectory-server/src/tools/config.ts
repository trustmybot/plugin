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

const KEY_REGEX = /^[a-z][a-z0-9_.-]{0,63}$/i;

export function configTools(db: TrajectoryDB): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'config_set',
      description: 'Set a plugin config key to a JSON-serializable value.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Config key (1-64 chars, must match /^[a-z][a-z0-9_.-]{0,63}$/i)' },
          value: { description: 'Any JSON-serializable value' },
        },
        required: ['key', 'value'],
      },
    },
    {
      name: 'config_get',
      description: 'Get a plugin config value by key. Returns null if not set.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
        },
        required: ['key'],
      },
    },
    {
      name: 'config_list',
      description: 'List all plugin config entries as a key→value object.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ];

  const handlers: Record<string, Fn> = {
    config_set: requireRoles('config_set', ['bro', 'architect'], wrapHandler(async (args) => {
      const key = args['key'];
      if (typeof key !== 'string' || !KEY_REGEX.test(key)) {
        return err(
          `Invalid config key ${JSON.stringify(key)}: must match /^[a-z][a-z0-9_.-]{0,63}$/i`,
        );
      }

      let valueJson: string;
      try {
        valueJson = JSON.stringify(args['value']);
      } catch {
        return err('config value not JSON-serializable');
      }

      const now = nowISO();
      db.run(
        `INSERT INTO plugin_config (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
        [key, valueJson, now],
      );

      return ok({ key, updated_at: now });
    })),

    config_get: wrapHandler(async (args) => {
      const key = args['key'] as string;
      const row = db.get<{ key: string; value_json: string; updated_at: string }>(
        `SELECT key, value_json, updated_at FROM plugin_config WHERE key = ?`,
        [key],
      );

      if (!row) {
        return ok(null);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value_json);
      } catch {
        return err(
          `config key ${JSON.stringify(key)}: stored value is not valid JSON — raw: ${row.value_json.slice(0, 200)}`,
        );
      }

      return ok(parsed);
    }),

    config_list: wrapHandler(async () => {
      const rows = db.all<{ key: string; value_json: string }>(
        `SELECT key, value_json FROM plugin_config ORDER BY key`,
      );

      const result: Record<string, unknown> = {};
      for (const row of rows) {
        try {
          result[row.key] = JSON.parse(row.value_json);
        } catch {
          return err(
            `config key ${JSON.stringify(row.key)}: stored value is not valid JSON — raw: ${row.value_json.slice(0, 200)}`,
          );
        }
      }

      return ok(result);
    }),
  };

  return { definitions, handlers };
}
