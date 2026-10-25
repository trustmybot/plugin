// Startup catch-up scan (ADR 0001, GH 1680): after the server connects, a
// detached `run-scan.mjs <projectRoot>` brings the world model up to the
// working tree, so edits made while no server ran are indexed before the
// first query. The scan lock in tools/scan.ts serialises it with any other
// scan; the child never holds the stdio event loop.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serverLog } from './logger.js';

export const RUN_SCAN_SCRIPT = fileURLToPath(new URL('../../../scripts/maintenance/run-scan.mjs', import.meta.url));

export type CatchupDecision =
  | { spawn: true; script: string; projectRoot: string; reason: 'spawned' }
  | { spawn: false; reason: 'memory-db' | 'skip-env' | 'test-context' | 'no-project-root' | 'script-missing' };

export function decideStartupCatchup(opts: {
  dbPath: string;
  env: NodeJS.ProcessEnv;
  script?: string;
  exists?: (path: string) => boolean;
}): CatchupDecision {
  const script = opts.script ?? RUN_SCAN_SCRIPT;
  const exists = opts.exists ?? existsSync;
  if (opts.dbPath === ':memory:') return { spawn: false, reason: 'memory-db' };
  if (opts.env['TMB_SKIP_AUTO_RESCAN'] === '1') return { spawn: false, reason: 'skip-env' };
  if (opts.env['NODE_TEST_CONTEXT']) return { spawn: false, reason: 'test-context' };
  const projectRoot = opts.env['CLAUDE_PROJECT_DIR']?.trim();
  if (!projectRoot) return { spawn: false, reason: 'no-project-root' };
  if (!exists(script)) return { spawn: false, reason: 'script-missing' };
  return { spawn: true, script, projectRoot, reason: 'spawned' };
}

export function startStartupCatchup(dbPath: string): CatchupDecision {
  const decision = decideStartupCatchup({ dbPath, env: process.env });
  if (decision.spawn) {
    try {
      const child = spawn(process.execPath, [...process.execArgv, decision.script, decision.projectRoot], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, TRAJECTORY_DB_PATH: dbPath },
      });
      child.on('error', (e) => serverLog({ kind: 'startup_catchup_error', error_message: e.message }));
      child.unref();
    } catch (e) {
      serverLog({ kind: 'startup_catchup', spawned: false, reason: 'spawn-error', error_message: (e as Error).message });
      return decision;
    }
  }
  serverLog({ kind: 'startup_catchup', spawned: decision.spawn, reason: decision.reason });
  return decision;
}
