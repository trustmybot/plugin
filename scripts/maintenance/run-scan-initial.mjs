#!/usr/bin/env node
// Standalone scan invoker for the cold-world-model SessionStart prescan.
// Mirrors run-scan.mjs but uses source='bro_auto_initial' so the audit
// row is distinct from the post-close rescan source.
// Silent on failure — the hook never blocks session start.
//
// Usage: run-scan-initial.mjs [project-root]. The project root is the
// argument, else CLAUDE_PROJECT_DIR (set on every Claude Code hook) — never
// the working directory. Neither → exit 2.

import { resolve } from 'node:path';
import { TrajectoryDB, resolveDbPath } from '../../mcp/trajectory-server/dist/db.js';
import { WorldModelGraph, resolveGraphDbPath } from '../../mcp/trajectory-server/dist/graph-db.js';
import { scanTools } from '../../mcp/trajectory-server/dist/tools/scan.js';

function resolveProjectRoot() {
  const root = process.argv[2] || process.env.CLAUDE_PROJECT_DIR;
  return root ? resolve(root) : null;
}

async function main() {
  const projectRoot = resolveProjectRoot();
  if (!projectRoot) {
    console.error('[prescan-initial] no project root: pass it as the first argument or set CLAUDE_PROJECT_DIR; nothing scanned');
    process.exit(2);
  }
  const dbPath = resolveDbPath({ env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot }, cwd: projectRoot });
  const db = new TrajectoryDB(dbPath);

  let graph = null;
  try {
    const graphPath = resolveGraphDbPath(dbPath);
    // WorldModelGraph retries with bounded backoff on kuzu write-lock
    // contention (#590) — so this background prescan recovers if it briefly
    // loses the cold-start race with the MCP server instead of giving up.
    graph = new WorldModelGraph(graphPath);
  } catch {
    // kuzu still unavailable after retries (missing binding, or the lock
    // never freed) — scan proceeds without world-model writes.
  }

  try {
    const tools = scanTools(db, graph, dbPath);
    const handler = tools.handlers.scan_run;
    const result = await handler({
      agent: 'bro',
      session_dir: projectRoot,
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
