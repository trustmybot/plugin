// TypeScript port of run-l5.sh (GH 1692), the L5 per-row runner over the rows/ tree. Each leaf row
// is an isolated eval: fixture.txt seeds the DB, setup-l5.sh (when present) pre-seeds state,
// claude runs the row's prompt.txt and script.json inside the per-step sandbox, then the row's
// scorers and the trajectory doctor judge the result. The per-row env is an object; nothing here
// writes process.env.
//
// Usage:
//   node --experimental-strip-types --experimental-sqlite tests/l5-l6/run-l5.ts        # all rows
//   node --experimental-strip-types --experimental-sqlite tests/l5-l6/run-l5.ts 07     # rows whose name holds "07"
//
// Requirements: CLAUDE_CODE_OAUTH_TOKEN, plus claude and sqlite3 on PATH.

import { spawnSync } from 'node:child_process';
import { accessSync, constants, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  L5_DOGFOOD_DIR,
  l5CleanupProject,
  l5ScoreFlow,
  l5SeedDb,
  l5SetupScratchProject,
  l5WritePreRunGitSnapshot,
  PLUGIN_ROOT,
  stripTrailingNewlines,
} from './lib/flow-helpers.ts';
import { l6cLaunchStep, l6cRunStep, l6cTrajectoryDoctor } from './lib/l6-chain-helpers.ts';
import { l5PreFlightOrAbort } from './lib/smoke-helpers.ts';

export const REQUIRED_TOOLS = ['claude', 'sqlite3'] as const;

export type PreFlight = (pluginRoot: string, env: NodeJS.ProcessEnv) => unknown;

export interface MainOptions {
  rowsRoot?: string;
  env?: NodeJS.ProcessEnv;
  preFlight?: PreFlight;
  pluginRoot?: string;
}

export interface Row {
  name: string;
  dir: string;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function subdirs(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => !name.startsWith('.'))
    .sort()
    .map((name) => join(dir, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    });
}

/** The leaf rows one and two levels under <rowsRoot> (a leaf holds prompt.txt or fixture.txt), in the .sh glob order. */
export function discoverRows(rowsRoot: string): Row[] {
  const top = subdirs(rowsRoot);
  const candidates = [...top, ...top.flatMap(subdirs)];
  return candidates
    .filter((dir) => isFile(join(dir, 'prompt.txt')) || isFile(join(dir, 'fixture.txt')))
    .map((dir) => ({ name: basename(dir), dir }));
}

/** `command -v <cmd>` against env.PATH. */
export function onPath(cmd: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const path = join(dir, cmd);
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function printClaudeVersion(env: NodeJS.ProcessEnv): void {
  const out = (text: string) => process.stdout.write(text);
  out('=== claude --version (informational) ===\n');
  const r = spawnSync('claude', ['--version'], { env, encoding: 'utf8' });
  const text = stripTrailingNewlines(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  if (text !== '') out(text.split('\n').map((line) => `  ${line}\n`).join(''));
  if (r.error || r.status !== 0) out('  ✗ claude --version failed\n');
  out('\n');
}

type RowResult = 'passed' | 'failed';

function runRow(row: Row, runBase: string, pluginRoot: string, baseEnv: NodeJS.ProcessEnv): RowResult {
  const out = (text: string) => process.stdout.write(text);
  out(`\n=== L5 row: ${row.name} ===\n`);
  const runId = `${runBase}-${row.name}`;
  const env: NodeJS.ProcessEnv = { ...baseEnv, PLUGIN_ROOT: pluginRoot, FLOW_NAME: row.name, RUN_ID: runId };
  const project = l5SetupScratchProject(env);
  try {
    const fixtureFile = join(row.dir, 'fixture.txt');
    const fixture = isFile(fixtureFile) ? stripTrailingNewlines(readFileSync(fixtureFile, 'utf8')) : 'onboarding-named';
    if (l5SeedDb(project, fixture, { pluginRoot, env }) !== 0) {
      out(`  ✗ ${row.name}: fixture seed failed\n`);
      return 'failed';
    }

    const setup = join(row.dir, 'setup-l5.sh');
    if (isFile(setup) && spawnSync('bash', [setup, project, row.dir], { env, stdio: 'inherit' }).status !== 0) {
      out(`  ✗ ${row.name}: setup-l5.sh failed\n`);
      return 'failed';
    }

    l5WritePreRunGitSnapshot(project, env);
    const restored = l6cLaunchStep(
      (p, dir, jsonl, stepEnv) => l6cRunStep(p, dir, jsonl, { pluginRoot, env: stepEnv }),
      project,
      row.dir,
      join(project, 'trajectory.jsonl'),
      env,
    );

    let ok = true;
    if (l5ScoreFlow(project, row.name, row.dir, runId, restored) !== 0) ok = false;
    if (l6cTrajectoryDoctor(join(project, '.claude', 'tmb', 'trajectory.db'), join(project, 'trajectory-doctor.json'), restored) !== 0) {
      ok = false;
    }
    out(ok ? `  ✓ ${row.name} passed\n` : `  ✗ ${row.name} failed\n`);
    return ok ? 'passed' : 'failed';
  } catch (err) {
    out(`  ✗ ${row.name}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 'failed';
  } finally {
    l5CleanupProject(project, env);
  }
}

/** run-l5.sh [filter]: returns the exit code (1 on a failed check or any failed row). */
export function main(argv: readonly string[], opts: MainOptions = {}): number {
  const out = (text: string) => process.stdout.write(text);
  const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };
  const pluginRoot = opts.pluginRoot ?? PLUGIN_ROOT;
  const rowsRoot = opts.rowsRoot ?? join(L5_DOGFOOD_DIR, 'rows');
  const filter = argv[0] ?? '';

  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    out('❌ CLAUDE_CODE_OAUTH_TOKEN not set.\n');
    out('   For local runs: export CLAUDE_CODE_OAUTH_TOKEN=...\n');
    out('   For CI: configure as a repo secret (Settings → Secrets).\n');
    return 1;
  }
  for (const cmd of REQUIRED_TOOLS) {
    if (!onPath(cmd, env)) {
      out(`❌ ${cmd} not found in PATH.\n`);
      return 1;
    }
  }

  (opts.preFlight ?? l5PreFlightOrAbort)(pluginRoot, env);
  printClaudeVersion(env);

  const runBase = `${Math.floor(Date.now() / 1000)}-${process.pid}`;
  let pass = 0;
  const failed: string[] = [];
  for (const row of discoverRows(rowsRoot)) {
    if (filter !== '' && !row.name.includes(filter)) continue;
    if (!isFile(join(row.dir, 'prompt.txt'))) continue;
    if (runRow(row, runBase, pluginRoot, env) === 'passed') pass++;
    else failed.push(row.name);
  }

  out('\n========================================\n');
  out(`L5: ${pass} passed, ${failed.length} failed\n`);
  if (failed.length > 0) {
    out(`Failed rows: ${failed.join(' ')}\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
