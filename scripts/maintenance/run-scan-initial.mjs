#!/usr/bin/env node
// Standalone scan invoker for the cold-world-model SessionStart prescan.
// Mirrors run-scan.mjs but uses source='bro_auto_initial' so the audit
// row is distinct from the post-close rescan source.
// Silent on failure — the hook never blocks session start.
//
// Usage: TRAJECTORY_DB_PATH=<db> run-scan-initial.mjs [project-root]. The DB
// path is required and never discovered: only the trajectory-server resolves
// and migrates the live DB (GH 1639). The project root is the argument, else
// CLAUDE_PROJECT_DIR (set on every Claude Code hook) — never the working
// directory. Neither → exit 2.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const TAG = '[prescan-initial]';

function fail(code, message) {
  console.error(`${TAG} ${message}`);
  process.exit(code);
}

async function main() {
  const dbPath = process.env.TRAJECTORY_DB_PATH?.trim();
  if (!dbPath) {
    fail(2, 'TRAJECTORY_DB_PATH is not set: pass the trajectory DB path explicitly; nothing scanned');
  }
  const projectRootArg = process.argv[2] || process.env.CLAUDE_PROJECT_DIR;
  if (!projectRootArg) {
    fail(2, 'no project root: pass it as the first argument or set CLAUDE_PROJECT_DIR; nothing scanned');
  }
  const projectRoot = resolve(projectRootArg);
  if (dbPath === ':memory:' || !existsSync(dbPath)) {
    fail(2, `no trajectory DB at ${dbPath}; nothing scanned`);
  }
  const { TrajectoryDB, GraphHolder, WorldModelGraph, scanTools } = await import(
    '../../mcp/trajectory-server/dist/run-scan.js'
  );

  let db;
  try {
    db = new TrajectoryDB(dbPath);
  } catch (e) {
    fail(1, `cannot open the trajectory DB at ${dbPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const tools = scanTools(db, GraphHolder.fixed(new WorldModelGraph(db)), dbPath);
    const result = await tools.handlers.scan_run({
      agent: 'bro',
      session_dir: projectRoot,
      source: 'bro_auto_initial',
    });
    if (result.isError) {
      console.error(`${TAG} scan_run error: ${result.content?.[0]?.text ?? '?'}`);
      return;
    }
    const summary = JSON.parse(result.content[0].text);
    console.error(
      `${TAG} OK — discovered ${summary.repos_discovered} repos, ` +
        `upserted ${summary.repos_upserted}, retired ${summary.repos_retired ?? 0}; ` +
        `${summary.dirs_upserted} dirs upserted, ${summary.dirs_retired ?? 0} retired`,
    );
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error(`${TAG} invoker error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(0);
});
