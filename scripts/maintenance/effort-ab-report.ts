#!/usr/bin/env node
// Per-arm report of the swe effort A/B (GH 1745): task count and the median and
// mean of wall-clock, swe tool calls, swe cache-read tokens, review FAILs and
// time to merge for the tasks enrolled under one label. Opens the DB read-only.
//   --db <path>     the trajectory DB (default: the one the server resolves for
//                   this workspace — TRAJECTORY_DB_PATH, else the walk up from
//                   CLAUDE_PROJECT_DIR or the cwd)
//   --label <name>  the A/B label (default: plugin_config.swe_effort_ab's label)
// Needs the built server (mcp/trajectory-server/dist). Exits 2 on bad usage.

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { effortAbReport, formatEffortAbReport } from '../../mcp/trajectory-server/dist/effort-ab-report.js';
import { resolveClaudeDbPath } from '../../mcp/trajectory-server/dist/platform.js';
import { readEffortAb } from '../../mcp/trajectory-server/dist/tools/config.js';

function fail(message: string): never {
  process.stderr.write(`effort-ab-report: ${message}\n`);
  process.exit(2);
}

let values: { db?: string; label?: string };
try {
  ({ values } = parseArgs({ options: { db: { type: 'string' }, label: { type: 'string' } } }));
} catch (e) {
  fail((e as Error).message);
}

const dbPath = values.db ?? resolveClaudeDbPath();
if (!existsSync(dbPath)) fail(`no trajectory DB at ${dbPath}`);

const raw = new DatabaseSync(dbPath, { readOnly: true });
const reader = {
  get: <T>(sql: string, params: unknown[] = []): T | undefined => raw.prepare(sql).get(...(params as never[])) as T | undefined,
  all: <T>(sql: string, params: unknown[] = []): T[] => raw.prepare(sql).all(...(params as never[])) as T[],
};

try {
  const label = values.label ?? readEffortAb(reader)?.label;
  if (!label) fail('no --label given and plugin_config.swe_effort_ab is unset');
  process.stdout.write(formatEffortAbReport(effortAbReport(reader, label, new Date())));
} finally {
  raw.close();
}
