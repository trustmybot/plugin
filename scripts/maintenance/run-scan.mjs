#!/usr/bin/env node
// Standalone scan invoker. Used by post-task-close-rescan.sh hook to
// re-run /scan against the current commit after bro_atomic_close.
//
// Reads the same scan_run logic as the MCP tool, so md5-driven drift
// detection / summary preservation behave identically. Silent on failure
// — the hook never blocks bro's response.

import { TrajectoryDB, resolveDbPath } from '../../mcp/trajectory-server/dist/db.js';
import { scanTools } from '../../mcp/trajectory-server/dist/tools/scan.js';

async function main() {
  const dbPath = resolveDbPath();
  const db = new TrajectoryDB(dbPath);
  try {
    const tools = scanTools(db);
    const handler = tools.handlers.scan_run;
    const result = await handler({ agent: 'bro', session_dir: process.cwd() });
    if (result.isError) {
      console.error(`[post-close-rescan] scan_run error: ${result.content?.[0]?.text ?? '?'}`);
      return;
    }
    const summary = JSON.parse(result.content[0].text);
    console.error(
      `[post-close-rescan] OK — ${summary.repos_upserted} repos, ` +
        `${summary.files_upserted} files (${summary.files_md5_changed} md5-changed)`,
    );
  } finally {
    db.close();
  }
}

main().catch((e) => {
  // Silent failure — never block the hook.
  console.error(`[post-close-rescan] invoker error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(0);
});
