#!/usr/bin/env node
// Standalone scan invoker. Used by post-task-close-rescan.sh hook to
// re-run /scan against the current commit after bro_atomic_close.
//
// Reads the same scan_run logic as the MCP tool, so pruning / summary
// preservation behave identically. The DB is checked before any tool module
// is imported: with no trajectory DB it exits 2 and creates nothing. A DB
// that fails to open (an older schema this opener may not migrate, a lock,
// corruption) exits 1 with the error.
//
// Usage: TRAJECTORY_DB_PATH=<db> run-scan.mjs [project-root] [source]. The DB path is
// required and never discovered: only the trajectory-server resolves and
// migrates the live DB (GH 1639). The project root is the argument, else
// CLAUDE_PROJECT_DIR (set on every Claude Code hook) — never the working
// directory, which may be a worktree or a subdirectory. Neither → exit 2.
// The source is scan_run's audit `source`: bro_auto_post_close by default,
// startup_catchup from the server's connect-time catch-up.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const TAG = '[post-close-rescan]';

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
  const { TrajectoryDB } = await import('../../mcp/trajectory-server/dist/db.js');
  const { GraphHolder, WorldModelGraph } = await import('../../mcp/trajectory-server/dist/graph-db.js');
  const { scanTools } = await import('../../mcp/trajectory-server/dist/tools/scan.js');

  let db;
  try {
    db = new TrajectoryDB(dbPath);
  } catch (e) {
    fail(1, `cannot open the trajectory DB at ${dbPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    // scan_run expects a GraphHolder (since #1089). This one-shot invoker runs
    // a single scan and exits, so wrap the graph as an inert holder.
    const tools = scanTools(db, GraphHolder.fixed(new WorldModelGraph(db)), dbPath);
    const result = await tools.handlers.scan_run({
      agent: 'bro',
      session_dir: projectRoot,
      source: process.argv[3] || 'bro_auto_post_close',
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
  // Silent failure — never block the hook.
  console.error(`${TAG} invoker error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(0);
});
