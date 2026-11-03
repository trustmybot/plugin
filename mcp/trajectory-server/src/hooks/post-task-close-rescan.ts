/**
 * PostToolUse hook on bro_atomic_close (GH 1692), the port of
 * scripts/hooks/post-task-close-rescan.sh: re-runs the scan
 * (scripts/maintenance/run-scan.mjs) against the DB the hooks resolve, so the
 * world model catches up with what the close landed. The scan is a detached
 * child with its stdio ignored and unref'd, node's `& disown`: the hook
 * returns without waiting for it. Bypass: TMB_SKIP_AUTO_RESCAN=1.
 *
 * Divergence (decision 703): the .sh exits 0 without jq; this gate needs none.
 */
import { spawn, type SpawnOptions } from 'node:child_process';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALLOW, type GateResult } from './gate.js';
import { dbPath } from './lib/db.js';
import { jqCapture, jqInput } from './lib/jq-raw.js';
import { installRoot, posixDirname } from './lib/project-env.js';

export const GATE_NAME = 'post-task-close-rescan';

const CLOSE_TOOL = /^mcp__[\s\S]*trajectory-server__bro_atomic_close$/;

export interface Detachable {
  on(event: 'error', listener: (err: Error) => void): unknown;
  unref(): void;
}

export type Spawner = (command: string, args: readonly string[], options: SpawnOptions) => Detachable;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function pluginRoot(): string {
  return installRoot(posixDirname(fileURLToPath(import.meta.url))) ?? '';
}

/** `TRAJECTORY_DB_PATH=<db> node --experimental-sqlite <invoker> >/dev/null 2>&1 & disown`. */
export function launchDetached(spawner: Spawner, invoker: string, db: string, env: NodeJS.ProcessEnv): void {
  const child = spawner(process.execPath, ['--experimental-sqlite', invoker], {
    detached: true,
    stdio: 'ignore',
    env: { ...env, TRAJECTORY_DB_PATH: db },
  });
  child.on('error', () => undefined);
  child.unref();
}

/** The gate with its spawner and plugin root injected. */
export function rescan(payload: string, env: NodeJS.ProcessEnv, spawner: Spawner = spawn, root: string = pluginRoot()): GateResult {
  const toolName = jqCapture(jqInput(payload), ['tool_name']);
  if (!CLOSE_TOOL.test(toolName)) return ALLOW;
  if ((env.TMB_SKIP_AUTO_RESCAN || '0') === '1') return ALLOW;
  const invoker = `${root}/scripts/maintenance/run-scan.mjs`;
  if (root === '' || !isFile(invoker)) return ALLOW;
  const db = dbPath(env, (line) => process.stderr.write(`${line}\n`));
  if (db === null) return ALLOW;
  try {
    launchDetached(spawner, invoker, db, env);
  } catch {
    /* a scan that cannot start leaves the close as it is */
  }
  return ALLOW;
}

export function postTaskCloseRescan(payload: string, env: NodeJS.ProcessEnv): GateResult {
  return rescan(payload, env);
}
