#!/usr/bin/env node
// Standalone scan invoker. Used by post-task-close-rescan.sh hook to
// re-run /scan against the current commit after bro_atomic_close.
//
// Reads the same scan_run logic as the MCP tool, so pruning / summary
// preservation behave identically. Silent on failure — the hook never
// blocks bro's response.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { TrajectoryDB, resolveDbPath, resolvePluginName } from '../../mcp/trajectory-server/dist/db.js';
import { WorldModelGraph, resolveGraphDbPath } from '../../mcp/trajectory-server/dist/graph-db.js';
import { scanTools } from '../../mcp/trajectory-server/dist/tools/scan.js';

// Derive the session_dir by walking up from cwd to find the directory that
// holds the .claude/<plugin>/trajectory.db. This handles the workspace-pattern
// where the MCP server's cwd is the workspace root but post-close-rescan.sh
// runs with PWD set to an inner worktree path.
function resolveSessionDir() {
  const dbPath = resolveDbPath();
  if (!dbPath || dbPath === ':memory:') return process.cwd();
  // dbPath is <sessionDir>/.claude/<plugin>/trajectory.db — walk up three dirs.
  return dirname(dirname(dirname(dbPath)));
}

async function main() {
  const dbPath = resolveDbPath();
  const db = new TrajectoryDB(dbPath);

  let graph = null;
  try {
    const graphPath = resolveGraphDbPath(dbPath);
    graph = new WorldModelGraph(graphPath);
  } catch {
    // kuzu unavailable — scan proceeds without world-model writes.
  }

  try {
    const tools = scanTools(db, graph, dbPath);
    const handler = tools.handlers.scan_run;
    const sessionDir = resolveSessionDir();

    const result = await handler({
      agent: 'bro',
      session_dir: sessionDir,
      source: 'bro_auto_post_close',
    });
    if (result.isError) {
      console.error(`[post-close-rescan] scan_run error: ${result.content?.[0]?.text ?? '?'}`);
      return;
    }
    const summary = JSON.parse(result.content[0].text);
    console.error(
      `[post-close-rescan] OK — discovered ${summary.repos_discovered} repos, ` +
        `upserted ${summary.repos_upserted}, retired ${summary.repos_retired ?? 0}; ` +
        `${summary.dirs_upserted} dirs upserted, ${summary.dirs_retired ?? 0} retired`,
    );
  } finally {
    graph?.close();
    db.close();
  }
}

main().catch((e) => {
  // Silent failure — never block the hook.
  console.error(`[post-close-rescan] invoker error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(0);
});
