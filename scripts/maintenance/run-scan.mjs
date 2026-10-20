#!/usr/bin/env node
// Standalone scan invoker. Used by post-task-close-rescan.sh hook to
// re-run /scan against the current commit after bro_atomic_close.
//
// Reads the same scan_run logic as the MCP tool, so pruning / summary
// preservation behave identically. Silent on failure — the hook never
// blocks bro's response. The DB is resolved and checked before any tool
// module is imported: with no trajectory DB it exits 2 and creates nothing.
//
// Usage: run-scan.mjs [project-root]. The project root is the argument, else
// CLAUDE_PROJECT_DIR (set on every Claude Code hook) — never the working
// directory, which may be a worktree or a subdirectory. Neither → exit 2.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { TrajectoryDB, resolveDbPath } from '../../mcp/trajectory-server/dist/db.js';

function resolveProjectRoot() {
  const root = process.argv[2] || process.env.CLAUDE_PROJECT_DIR;
  return root ? resolve(root) : null;
}

async function main() {
  const projectRoot = resolveProjectRoot();
  if (!projectRoot) {
    console.error('[post-close-rescan] no project root: pass it as the first argument or set CLAUDE_PROJECT_DIR; nothing scanned');
    process.exit(2);
  }
  const dbPath = resolveDbPath({ env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot }, cwd: projectRoot });
  if (dbPath === ':memory:' || !existsSync(dbPath)) {
    console.error(`[post-close-rescan] no trajectory DB at ${dbPath}; nothing scanned`);
    process.exit(2);
  }
  const { GraphHolder, WorldModelGraph, resolveGraphDbPath, isKuzuLockError } = await import('../../mcp/trajectory-server/dist/graph-db.js');
  const { scanTools } = await import('../../mcp/trajectory-server/dist/tools/scan.js');
  const db = new TrajectoryDB(dbPath);

  let graph = null;
  let openError = null;
  try {
    const graphPath = resolveGraphDbPath(dbPath);
    graph = new WorldModelGraph(graphPath);
  } catch (e) {
    // Mirror the server holder's lock-only contract: surface lock errors
    // (holder identifiable via lsof, retry meaningful) so scan hard-fails;
    // a missing kuzu binding stays silent — scan proceeds without
    // world-model writes.
    openError = isKuzuLockError(e) ? (e instanceof Error ? e.message : String(e)) : null;
  }

  try {
    // scan_run expects a GraphHolder (since #1089). This one-shot invoker runs
    // a single scan and exits, so wrap the already-resolved graph as an inert
    // holder — no lazy re-open is wanted.
    const tools = scanTools(db, GraphHolder.fixed(graph, openError), dbPath);
    const handler = tools.handlers.scan_run;
    const result = await handler({
      agent: 'bro',
      session_dir: projectRoot,
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
