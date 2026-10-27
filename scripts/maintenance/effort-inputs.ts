#!/usr/bin/env node
// The world-model effort inputs and suggested tier (GH 1904) of existing tasks,
// computed as at their creation, so the effort A/B can be scored on tasks
// enrolled before effort_inputs_recorded rows existed. Opens the DB read-only
// and prints one JSON line per task: {task_id, inputs, suggested_tier, reason,
// effort}, or {task_id, error} for an unknown id.
//   --db <path>      the trajectory DB (default: the one the server resolves)
//   --repo <name>    the world-model repo (default: each task's repo)
//   --tasks <id,…>   the task ids
// Needs the built server (mcp/trajectory-server/dist). Exits 2 on bad usage.

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { taskEffortInputs } from '../../mcp/trajectory-server/dist/effort-inputs.js';
import { resolveClaudeDbPath } from '../../mcp/trajectory-server/dist/platform.js';

function fail(message: string): never {
  process.stderr.write(`effort-inputs: ${message}\n`);
  process.exit(2);
}

let values: { db?: string; repo?: string; tasks?: string };
try {
  ({ values } = parseArgs({ options: { db: { type: 'string' }, repo: { type: 'string' }, tasks: { type: 'string' } } }));
} catch (e) {
  fail((e as Error).message);
}

const ids = (values.tasks ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
if (ids.length === 0 || ids.some((s) => !/^\d+$/.test(s))) fail('--tasks takes a comma-separated list of task ids');

const dbPath = values.db ?? resolveClaudeDbPath();
if (!existsSync(dbPath)) fail(`no trajectory DB at ${dbPath}`);

const raw = new DatabaseSync(dbPath, { readOnly: true });
const reader = {
  dbPath,
  get: <T>(sql: string, params: unknown[] = []): T | undefined => raw.prepare(sql).get(...(params as never[])) as T | undefined,
  all: <T>(sql: string, params: unknown[] = []): T[] => raw.prepare(sql).all(...(params as never[])) as T[],
} as never;

try {
  for (const id of ids.map(Number)) {
    const computed = taskEffortInputs(reader, id, values.repo);
    const line = computed
      ? { task_id: id, inputs: computed.inputs, suggested_tier: computed.tier, reason: computed.reason, effort: computed.task.effort }
      : { task_id: id, error: 'no such task' };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }
} finally {
  raw.close();
}
