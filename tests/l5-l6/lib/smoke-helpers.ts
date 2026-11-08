// TypeScript port of smoke-helpers.sh (GH 1692), the substrate-health checks a runner makes
// before it spends tokens on claude: the MCP server spawns and lists its tools, the OAuth token
// answers a `claude -p`, and claude loads the plugin. The MCP and plugin-load smokes point
// TRAJECTORY_DB_PATH at one throwaway DB per process, removed on exit, so a smoke never
// migrates a parent project's live DB. Nothing here writes process.env.

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runWithTimeout } from './timeout.ts';

const MCP_REQUEST = `${[
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
].join('\n')}\n`;

let smokeDbDir = '';
let cleanupHooked = false;

/** _l5_smoke_isolate_db: the env with TRAJECTORY_DB_PATH at this process's throwaway DB, made on first use. */
export function l5SmokeIsolateDb(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (smokeDbDir === '') {
    smokeDbDir = mkdtempSync(`${(env.TMPDIR || '/tmp').replace(/\/+$/, '')}/l5-smoke-db.`);
    mkdirSync(join(smokeDbDir, '.claude', 'tmb'), { recursive: true });
    if (!cleanupHooked) {
      process.on('exit', l5SmokeCleanupDb);
      cleanupHooked = true;
    }
  }
  return { ...env, TRAJECTORY_DB_PATH: join(smokeDbDir, '.claude', 'tmb', 'trajectory.db') };
}

/** _l5_smoke_cleanup_db: removes the throwaway DB dir. */
export function l5SmokeCleanupDb(): void {
  if (smokeDbDir !== '' && existsSync(smokeDbDir)) {
    rmSync(smokeDbDir, { recursive: true, force: true });
    smokeDbDir = '';
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** l5_smoke_mcp <plugin_dir>: 0 when dist/index.js answers tools/list within 10s, else 1. */
export function l5SmokeMcp(pluginDir: string, baseEnv: NodeJS.ProcessEnv = process.env): number {
  const env = l5SmokeIsolateDb(baseEnv);
  const entry = `${pluginDir}/mcp/trajectory-server/dist/index.js`;
  if (!isFile(entry)) {
    process.stderr.write(`  ✗ MCP smoke: entrypoint missing at ${entry}\n`);
    return 1;
  }
  const r = runWithTimeout(10, process.execPath, ['--experimental-sqlite', entry], { env, input: MCP_REQUEST });
  const resp = r.stdout + r.stderr;
  if (resp.includes('"tools"')) return 0;
  const head = resp.replace(/\n+$/, '').split('\n').slice(0, 10).map((line) => `      ${line}\n`).join('');
  process.stderr.write(`  ✗ MCP smoke: server did not return a tools list. Output:\n${head}`);
  return 1;
}

/** l5_smoke_claude_auth: 0 when CLAUDE_CODE_OAUTH_TOKEN is set and `claude -p` prints something within 30s. */
export function l5SmokeClaudeAuth(env: NodeJS.ProcessEnv = process.env): number {
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    process.stderr.write('  ✗ Auth smoke: CLAUDE_CODE_OAUTH_TOKEN is not set\n');
    return 1;
  }
  const r = runWithTimeout(30, 'claude', ['-p', 'say hi in one word'], { env, stdio: ['inherit', 'pipe', 'pipe'] });
  if ((r.stdout + r.stderr).replace(/\n+$/, '') === '') {
    process.stderr.write('  ✗ Auth smoke: claude -p returned empty output (token may be revoked)\n');
    return 1;
  }
  return 0;
}

/** l5_smoke_claude_plugin_load <plugin_dir>: 0 when `claude --plugin-dir` prints something within 60s. */
export function l5SmokeClaudePluginLoad(pluginDir: string, baseEnv: NodeJS.ProcessEnv = process.env): number {
  const env = l5SmokeIsolateDb(baseEnv);
  const r = runWithTimeout(60, 'claude', ['--plugin-dir', pluginDir, '--dangerously-skip-permissions', '-p', 'say hi in one word'], {
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  if ((r.stdout + r.stderr).replace(/\n+$/, '') === '') {
    process.stderr.write(`  ✗ Plugin-load smoke: claude --plugin-dir returned empty output\n    plugin_dir=${pluginDir}\n`);
    return 1;
  }
  return 0;
}

/**
 * l5_pre_flight_or_abort <plugin_dir>: the three smokes in order; the first failure exits the
 * process with 1. Returns the env the smokes leave behind (TRAJECTORY_DB_PATH at the throwaway).
 */
export function l5PreFlightOrAbort(pluginDir: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = (text: string) => process.stdout.write(text);
  const env = l5SmokeIsolateDb(baseEnv);
  out('=== Pre-flight substrate health (fail-fast) ===\n');
  const steps: [string, string, () => number][] = [
    ['  [1/3] MCP smoke (server spawns + responds): ', 'MCP smoke', () => l5SmokeMcp(pluginDir, env)],
    ['  [2/3] Auth smoke (claude -p basic call): ', 'auth smoke', () => l5SmokeClaudeAuth(env)],
    ['  [3/3] Plugin-load smoke (claude --plugin-dir loads cleanly): ', 'plugin-load smoke', () => l5SmokeClaudePluginLoad(pluginDir, env)],
  ];
  for (const [label, name, smoke] of steps) {
    out(label);
    if (smoke() !== 0) {
      out(`\n❌ Pre-flight FAILED at ${name}. Aborting before token spend.\n`);
      process.exit(1);
    }
    out('✓\n');
  }
  out('=== Pre-flight passed ===\n\n');
  return env;
}
