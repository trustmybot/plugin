import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

const META_KEY = '_meta_detected_stack';

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

function resolveScriptPath(): string {
  const pluginRoot = process.env['CLAUDE_PLUGIN_ROOT'];
  if (pluginRoot) {
    return join(pluginRoot, 'skills', 'tmb_project-prescan', 'scripts', 'detect-stack.sh');
  }
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // From dist/tools/ → go up to trajectory-server root (dist/tools → dist → trajectory-server),
  // then up through mcp/ to the plugin root, then into skills/
  return join(__dirname, '..', '..', '..', '..', 'skills', 'tmb_project-prescan', 'scripts', 'detect-stack.sh');
}

function readExistingStack(db: TrajectoryDB): { value: Record<string, unknown> | null; detected_at: string | null } {
  const row = db.get<{ value_json: string }>(
    `SELECT value_json FROM plugin_config WHERE key = ?`,
    [META_KEY],
  );
  if (!row) return { value: null, detected_at: null };
  try {
    const parsed = JSON.parse(row.value_json) as Record<string, unknown>;
    return { value: parsed, detected_at: (parsed['detected_at'] as string) ?? null };
  } catch {
    return { value: null, detected_at: null };
  }
}

function stackSignature(stack: Record<string, unknown>): string {
  const fields = ['languages', 'package_managers', 'test_runners', 'linters'];
  const parts = fields.map((f) => {
    const val = stack[f];
    if (Array.isArray(val)) return JSON.stringify((val as string[]).slice().sort());
    return JSON.stringify(val ?? null);
  });
  return parts.join('|');
}

export function projectMetadataTools(db: TrajectoryDB): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'project_metadata_detect',
      description:
        'Run the stack-detection script against the repo and persist the result to the config table. Idempotent — diffs against the previous value; returns changed=true only when languages/tools shifted. Bro-only write.',
      inputSchema: {
        type: 'object',
        properties: {
          repo_path: {
            type: 'string',
            description: 'Absolute path to the repo root. Defaults to process.cwd().',
          },
        },
      },
    },
    {
      name: 'project_metadata_get',
      description:
        'Return the last persisted stack-detection result from the config table. Returns null if project_metadata_detect has never run. Read-only; safe for bro, swe, pr-reviewer, and consultant agents.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ];

  const handlers: Record<string, Fn> = {
    project_metadata_detect: requireRoles(
      'project_metadata_detect',
      ['bro'],
      wrapHandler(async (args) => {
        const repoPath = (args['repo_path'] as string | undefined) ?? process.cwd();

        const scriptPath = resolveScriptPath();
        if (!existsSync(scriptPath)) {
          return err(`detect-stack.sh not found at: ${scriptPath}`);
        }

        let stdout: string;
        try {
          stdout = execFileSync('bash', [scriptPath, '--cwd', repoPath], {
            timeout: 5000,
            encoding: 'utf-8',
          });
        } catch (e) {
          const execErr = e as Error & { stderr?: string; status?: number };
          const stderrText = execErr.stderr ?? '';
          return err(
            `detect-stack.sh failed (exit ${execErr.status ?? 'unknown'}): ${stderrText || execErr.message}`,
          );
        }

        let detected: Record<string, unknown>;
        try {
          detected = JSON.parse(stdout) as Record<string, unknown>;
        } catch {
          return err(`detect-stack.sh returned invalid JSON: ${stdout.slice(0, 200)}`);
        }

        const { value: existing, detected_at: previousDetectedAt } = readExistingStack(db);
        const newSig = stackSignature(detected);
        const oldSig = existing ? stackSignature(existing) : null;
        const changed = oldSig === null || newSig !== oldSig;

        const valueJson = JSON.stringify(detected);
        const now = nowISO();
        db.run(
          `INSERT INTO plugin_config (key, value_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value_json = excluded.value_json,
             updated_at = excluded.updated_at`,
          [META_KEY, valueJson, now],
        );

        return ok({
          detected,
          changed,
          previous_detected_at: previousDetectedAt,
        });
      }),
    ),

    project_metadata_get: requireRoles(
      'project_metadata_get',
      ['bro', 'swe', 'pr-reviewer', 'consultant'],
      wrapHandler(async (_args) => {
        const { value } = readExistingStack(db);
        return ok(value);
      }),
    ),
  };

  return { definitions, handlers };
}
