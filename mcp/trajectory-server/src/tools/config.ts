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

export interface ConfigValueInput {
  readonly key: string;
  readonly value: unknown;
}

export type ConfigValues = Readonly<Record<string, unknown | null>>;

export function storedConfigParseErrorPrefix(key: string): string {
  return `config key ${JSON.stringify(key)}: stored value is not valid JSON`;
}

/**
 * Persist one or more shared plugin-config values atomically. Callers remain
 * responsible for exposing only the keys their host contract permits.
 */
export function setConfigValues(
  db: TrajectoryDB,
  entries: readonly ConfigValueInput[],
): void {
  const serialized = entries.map(({ key, value }) => ({
    key,
    valueJson: serializeConfigValue(key, value),
  }));
  db.transaction(() => {
    for (const { key, valueJson } of serialized) {
      db.run(
        `INSERT INTO plugin_config (key, value_json)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
        [key, valueJson],
      );
    }
  });
}

/**
 * Read a bounded set of shared plugin-config values from one SQLite statement.
 * A single statement gives callers one database snapshot even when another
 * host process atomically replaces related keys at the same time.
 */
export function getConfigValues(
  db: TrajectoryDB,
  keys: readonly string[],
): ConfigValues {
  if (keys.length === 0) return Object.freeze({});

  const placeholders = keys.map(() => '?').join(', ');
  const rows = db.all<{ key: string; value_json: string }>(
    `SELECT key, value_json
     FROM plugin_config
     WHERE key IN (${placeholders})`,
    [...keys],
  );
  const result: Record<string, unknown | null> = Object.fromEntries(
    keys.map((key) => [key, null]),
  );
  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.value_json);
    } catch {
      throw new Error(
        `${storedConfigParseErrorPrefix(row.key)} — raw: ${row.value_json.slice(0, 200)}`,
      );
    }
  }
  return Object.freeze(result);
}

function serializeConfigValue(key: unknown, rawValue: unknown): string {
  if (typeof key !== 'string' || !KEY_REGEX.test(key)) {
    throw new Error(
      `Invalid config key ${JSON.stringify(key)}: must match /^[a-z][a-z0-9_.-]{0,63}$/i`,
    );
  }
  if (rawValue === undefined || rawValue === null) {
    throw new Error('Missing required arg: value');
  }
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('{') && trimmed.endsWith('}'))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null) {
          throw new Error(
            `config value for key=${JSON.stringify(key)} looks like a pre-serialized JSON ${Array.isArray(parsed) ? 'array' : 'object'} (passed as a string). Pass the raw value directly — e.g. value=["main"], not value="[\\"main\\"]". The server calls JSON.stringify() on whatever you pass; double-encoding it breaks downstream consumers that expect the original shape.`,
          );
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          // not valid JSON — fall through, treat as a plain string value
        } else {
          throw error;
        }
      }
    }
  }

  try {
    // Preserve config_set's existing runtime behavior for JSON.stringify
    // inputs whose result is undefined; node:sqlite remains the final binder
    // check for those unsupported values.
    return JSON.stringify(rawValue) as string;
  } catch {
    throw new Error('config value not JSON-serializable');
  }
}

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
    config_set: requireRoles('config_set', ['bro'], wrapHandler(async (args) => {
      const key = args['key'];
      setConfigValues(db, [{ key: key as string, value: args['value'] }]);
      return ok({ key });
    })),

    config_get: wrapHandler(async (args) => {
      const key = args['key'] as string;
      return ok(getConfigValues(db, [key])[key] ?? null);
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
            `${storedConfigParseErrorPrefix(row.key)} — raw: ${row.value_json.slice(0, 200)}`,
          );
        }
      }

      return ok(result);
    }),
  };

  return { definitions, handlers };
}
