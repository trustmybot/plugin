#!/usr/bin/env node
// Standalone scan invoker for the cold-world-model SessionStart prescan.
// Mirrors run-scan.mjs but uses source='bro_auto_initial' so the audit
// row is distinct from the post-close rescan source.
// Silent on failure — the hook never blocks session start.

import { dirname } from 'node:path';
import { TrajectoryDB, resolveDbPath } from '../../mcp/trajectory-server/dist/db.js';
import { WorldModelGraph, resolveGraphDbPath } from '../../mcp/trajectory-server/dist/graph-db.js';
import { scanTools } from '../../mcp/trajectory-server/dist/tools/scan.js';

function resolveSessionDir() {
  const dbPath = resolveDbPath();
  if (!dbPath || dbPath === ':memory:') return process.cwd();
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
      source: 'bro_auto_initial',
    });
    if (result.isError) {
      console.error(`[prescan-initial] scan_run error: ${result.content?.[0]?.text ?? '?'}`);
      return;
    }
    const summary = JSON.parse(result.content[0].text);
    console.error(
      `[prescan-initial] OK — discovered ${summary.repos_discovered} repos, ` +
        `upserted ${summary.repos_upserted}, retired ${summary.repos_retired ?? 0}; ` +
        `${summary.dirs_upserted} dirs upserted, ${summary.dirs_retired ?? 0} retired`,
    );
  } finally {
    graph?.close();
    db.close();
  }
}

main().catch((e) => {
  console.error(`[prescan-initial] invoker error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(0);
});
