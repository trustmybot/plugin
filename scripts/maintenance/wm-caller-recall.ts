#!/usr/bin/env node
// Caller recall of the world model (GH 1988): a seeded sample of one repo's
// TS/TSX function, method and class symbols, their callers per the TypeScript
// language service set against their world-model callers, with recall,
// precision and every miss classed. Opens the DB read-only; never writes the repo.
//   --db <path>         the trajectory DB (default: the one the server resolves
//                       for this workspace)
//   --repo <name>       the repo (default: plugin)
//   --repo-path <dir>   its checkout (default: the repos row's path)
//   --sample <n>        sample size (default: 100)
//   --seed <n>          sample seed (default: 1988)
//   --json              print the full report as JSON instead of markdown
// Needs the built server (mcp/trajectory-server/dist) and its typescript
// devDependency. Exits 2 on bad usage.

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { callerRecall, formatCallerRecall, repoPathFromDb } from '../../mcp/trajectory-server/dist/caller-recall.js';
import { resolveClaudeDbPath } from '../../mcp/trajectory-server/dist/platform.js';

function fail(message: string): never {
  process.stderr.write(`wm-caller-recall: ${message}\n`);
  process.exit(2);
}

function count(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) fail(`--${name} takes a non-negative integer, got '${raw}'`);
  return Number(raw);
}

let values: { db?: string; repo?: string; 'repo-path'?: string; sample?: string; seed?: string; json?: boolean };
try {
  ({ values } = parseArgs({
    options: {
      db: { type: 'string' },
      repo: { type: 'string' },
      'repo-path': { type: 'string' },
      sample: { type: 'string' },
      seed: { type: 'string' },
      json: { type: 'boolean' },
    },
  }));
} catch (e) {
  fail((e as Error).message);
}

const sample = count('sample', values.sample, 100);
const seed = count('seed', values.seed, 1988);
const repo = values.repo ?? 'plugin';
const dbPath = values.db ?? resolveClaudeDbPath();
if (!existsSync(dbPath)) fail(`no trajectory DB at ${dbPath}`);

const raw = new DatabaseSync(dbPath, { readOnly: true });
const reader = {
  get: <T>(sql: string, params: unknown[] = []): T | undefined => raw.prepare(sql).get(...(params as never[])) as T | undefined,
  all: <T>(sql: string, params: unknown[] = []): T[] => raw.prepare(sql).all(...(params as never[])) as T[],
};

try {
  const repoPath = values['repo-path'] ?? repoPathFromDb(reader, repo, dbPath);
  if (!repoPath) fail(`no --repo-path given and no repos row with a path for '${repo}'`);
  if (!existsSync(repoPath)) fail(`no repo checkout at ${repoPath}`);
  const report = callerRecall(reader, { repo, repoPath, sample, seed });
  process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatCallerRecall(report));
} finally {
  raw.close();
}
