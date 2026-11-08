// TypeScript port of l6-chain-helpers.sh (GH 1692), the L6 chain runner helpers. The chain walks
// the journey rows in order against one cumulative trajectory DB, a fresh `claude -p` per turn:
// continuity is DB-driven, not session-driven (tests/l5-l6/l6-chain/chain-manifest.json holds the
// row order and between-row seeds). Functions that exported into the caller's shell take an env
// and return the new one; nothing here writes process.env.

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  claudeStepEnv,
  l5ComposeTestPrompt,
  LIB_DIR,
  PLUGIN_ROOT,
  runClaudeToFile,
  scoreAll,
  stripTrailingNewlines,
  tmbTestStateDir,
  type RunOptions,
} from './flow-helpers.ts';
import { tmbTestSandboxInit, tmbTestSandboxTeardown } from './sandbox.ts';

export const DISABLE_PROJECT_TRAJECTORY_SERVER = '{"disabledMcpjsonServers":["trajectory-server"]}';

const CLI_JS = join(LIB_DIR, '..', '..', '..', 'mcp', 'trajectory-server', 'dist', 'cli.js');

export type StepRunner = (project: string, rowDir: string, outJsonl: string, env: NodeJS.ProcessEnv) => unknown;

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** jq -r's rendering of one value. */
function jqRaw(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

/** jq's `a // b`: b when a is null, false or missing. */
function alt<T>(value: unknown, fallback: T): unknown {
  return value === undefined || value === null || value === false ? fallback : value;
}

/** l6c_resolve_runs_root <plugin_root>: L6C_RUNS_DIR when set, else <state dir>/l6-chain-runs; null when no state dir resolves. */
export function l6cResolveRunsRoot(pluginRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.L6C_RUNS_DIR) return env.L6C_RUNS_DIR;
  const state = tmbTestStateDir(pluginRoot, env);
  return state === null ? null : `${state}/l6-chain-runs`;
}

/**
 * l6c_isolate_home <run_dir>: the env with HOME at <run_dir>/home (mode 0700), the model cache and
 * mise installs/config still reachable through env, and bun and mise caches/state under
 * <run_dir>/tool-state.
 */
export function l6cIsolateHome(runDir: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const realHome = baseEnv.HOME ?? '';
  const tools = `${runDir}/tool-state`;
  let cache = env.TMB_MODEL_CACHE_DIR || env.HF_HOME || '';
  if (cache === '' && isDir(`${realHome}/.cache/huggingface`)) cache = `${realHome}/.cache/huggingface`;
  if (cache !== '') {
    env.TMB_MODEL_CACHE_DIR = cache;
    env.HF_HOME = env.HF_HOME || cache;
    env.TRANSFORMERS_CACHE = env.TRANSFORMERS_CACHE || cache;
  }
  env.BUN_INSTALL_CACHE_DIR = env.BUN_INSTALL_CACHE_DIR || `${tools}/bun-install-cache`;
  env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = env.BUN_RUNTIME_TRANSPILER_CACHE_PATH || `${tools}/bun-transpiler-cache`;
  env.MISE_STATE_DIR = env.MISE_STATE_DIR || `${tools}/mise-state`;
  env.MISE_CACHE_DIR = env.MISE_CACHE_DIR || `${tools}/mise-cache`;
  if (!env.MISE_DATA_DIR && isDir(`${realHome}/.local/share/mise`)) env.MISE_DATA_DIR = `${realHome}/.local/share/mise`;
  if (!env.MISE_CONFIG_DIR && isDir(`${realHome}/.config/mise`)) env.MISE_CONFIG_DIR = `${realHome}/.config/mise`;
  mkdirSync(runDir, { recursive: true });
  try {
    mkdirSync(`${runDir}/home`, { mode: 0o700 });
  } catch {
    chmodSync(`${runDir}/home`, 0o700);
  }
  env.HOME = `${runDir}/home`;
  return env;
}

function homeLeaks(home: string, dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = `${dir}/${name}`;
    if (path === `${home}/.cache/huggingface`) continue;
    if (path !== `${home}/.cache`) out.push(path);
    if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) homeLeaks(home, path, out);
  }
}

/** l6c_assert_home_clean <home>: 0 when <home> holds nothing but .cache/huggingface; else prints every other entry and returns 1. */
export function l6cAssertHomeClean(home: string): number {
  if (!isDir(home)) return 0;
  const leaks: string[] = [];
  homeLeaks(home, home, leaks);
  if (leaks.length === 0) return 0;
  const shown = leaks.map((p) => (p.startsWith(home) ? `  $HOME${p.slice(home.length)}` : p));
  process.stderr.write(
    `❌ the chain wrote under its isolated HOME ${home} — only .cache/huggingface may appear there:\n${shown.join('\n')}\n`,
  );
  return 1;
}

/** l6c_launch_step <runner> <project> <row_dir> <out_jsonl>: runs <runner> inside the per-step sandbox; returns the env teardown restores. */
export function l6cLaunchStep(
  runner: StepRunner,
  project: string,
  rowDir: string,
  outJsonl: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sandbox = tmbTestSandboxInit(project, baseEnv);
  let restored: NodeJS.ProcessEnv;
  try {
    runner(project, rowDir, outJsonl, sandbox.env);
  } finally {
    restored = tmbTestSandboxTeardown(sandbox);
  }
  return restored;
}

/** l6c_trajectory_doctor <db> <report_file>: `cli.js trajectory-doctor` into <report_file>; prints the report when unhealthy; returns its exit code. */
export function l6cTrajectoryDoctor(db: string, report: string, env: NodeJS.ProcessEnv = process.env): number {
  const fd = openSync(report, 'w');
  let rc: number;
  try {
    const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', CLI_JS, 'trajectory-doctor', '--db', db], {
      env,
      stdio: ['inherit', fd, fd],
    });
    rc = r.status ?? 1;
  } finally {
    closeSync(fd);
  }
  if (rc !== 0) {
    const body = readFileSync(report, 'utf8');
    const indented = body === '' ? '' : body.replace(/\n$/, '').split('\n').map((line) => `    ${line}\n`).join('');
    process.stdout.write(`  ✗ trajectory_doctor: ${db} is unhealthy (exit ${rc})\n${indented}`);
  }
  return rc;
}

/** l6c_uuid: a lowercase UUID for --session-id. */
export function l6cUuid(): string {
  return randomUUID();
}

/** l6c_snapshot_db <project> <out_file>: `.dump` of the trajectory DB, or a one-line failure note. */
export function l6cSnapshotDb(project: string, out: string, env: NodeJS.ProcessEnv = process.env): void {
  const fd = openSync(out, 'w');
  let ok = false;
  try {
    const r = spawnSync('sqlite3', [join(project, '.claude', 'tmb', 'trajectory.db'), '.dump'], { env, stdio: ['ignore', fd, 'ignore'] });
    ok = r.status === 0;
  } finally {
    closeSync(fd);
  }
  if (!ok) writeFileSync(out, '-- snapshot failed: trajectory.db missing or unreadable\n');
}

/** l6c_apply_seed <project> <seed_path>: runs the SQL seed when it exists; '', 'null' and a missing file return 0. */
export function l6cApplySeed(project: string, seed: string, env: NodeJS.ProcessEnv = process.env): number {
  if (seed === '' || seed === 'null') return 0;
  if (!isFile(seed)) {
    process.stderr.write(`  ⚠ seed not found, skipping: ${seed}\n`);
    return 0;
  }
  const r = spawnSync('sqlite3', [join(project, '.claude', 'tmb', 'trajectory.db')], {
    input: readFileSync(seed),
    env,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  return r.status ?? 1;
}

interface StepScript {
  maxTurns: number;
  replies: unknown[];
  terminalPattern: string;
}

function readStepScript(path: string): StepScript {
  if (!isFile(path)) return { maxTurns: 1, replies: [], terminalPattern: '' };
  let script: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed !== null && typeof parsed === 'object') script = parsed as Record<string, unknown>;
  } catch {
    script = {};
  }
  const maxTurns = Number(alt(script.max_turns, 1));
  const replies = alt(script.user_after_bro, []);
  return {
    maxTurns: Number.isFinite(maxTurns) ? maxTurns : 1,
    replies: Array.isArray(replies) ? replies : [],
    terminalPattern: String(alt(script.terminal_pattern, '')),
  };
}

/** The last 4000 bytes of every assistant text block of a stream-json log. */
export function lastAssistantText(jsonl: string): string {
  let text = '';
  try {
    text = readFileSync(jsonl, 'utf8');
  } catch {
    return '';
  }
  const parts: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let ev: { type?: unknown; message?: { content?: unknown } };
    try {
      ev = JSON.parse(line);
    } catch {
      break;
    }
    if (ev?.type !== 'assistant' || !Array.isArray(ev.message?.content)) continue;
    for (const block of ev.message.content as { type?: unknown; text?: unknown }[]) {
      if (block?.type === 'text') parts.push(`${jqRaw(block.text)}\n`);
    }
  }
  const bytes = Buffer.from(parts.join(''), 'utf8');
  return stripTrailingNewlines(bytes.subarray(Math.max(0, bytes.length - 4000)).toString('utf8'));
}

/** The argv of one chain turn: a fresh --session-id, then the run flags and the prompt. */
export function l6cClaudeArgs(pluginRoot: string, prompt: string, sessionId: string = l6cUuid()): string[] {
  return [
    '--session-id',
    sessionId,
    '--plugin-dir',
    pluginRoot,
    '--dangerously-skip-permissions',
    '--output-format',
    'stream-json',
    '--include-hook-events',
    '--include-partial-messages',
    '--verbose',
    '--settings',
    DISABLE_PROJECT_TRAJECTORY_SERVER,
    '-p',
    prompt,
  ];
}

/**
 * l6c_run_step <project> <row_dir> <out_jsonl>: one chain step. Turn 1 is the composed prompt.txt;
 * each later turn is the next user_after_bro[] entry, each a fresh session. A terminal_pattern
 * match in bro's last text ends the step early.
 */
export function l6cRunStep(project: string, rowDir: string, outJsonl: string, opts: RunOptions = {}): void {
  const pluginRoot = opts.pluginRoot ?? PLUGIN_ROOT;
  const env = claudeStepEnv(opts.env ?? process.env);
  const { maxTurns, replies, terminalPattern } = readStepScript(join(rowDir, 'script.json'));

  writeFileSync(outJsonl, '');
  let current = stripTrailingNewlines(l5ComposeTestPrompt(stripTrailingNewlines(readFileSync(join(rowDir, 'prompt.txt'), 'utf8'))));

  for (let turn = 1; turn <= maxTurns; turn++) {
    const turnJsonl = `${outJsonl}.turn${turn}`;
    runClaudeToFile(project, l6cClaudeArgs(pluginRoot, current), turnJsonl, env);
    appendFileSync(outJsonl, readFileSync(turnJsonl));

    const broText = lastAssistantText(turnJsonl);
    if (terminalPattern !== '' && broText !== '') {
      const re = new RegExp(terminalPattern);
      if (broText.split('\n').some((line) => re.test(line))) {
        rmSync(turnJsonl, { force: true });
        break;
      }
    }

    const reply = alt(replies[turn - 1], undefined);
    const next = reply === undefined ? '' : stripTrailingNewlines(jqRaw(reply));
    rmSync(turnJsonl, { force: true });
    if (next === '') break;
    current = next;
  }
}

/** l6c_score_step <project> <step_name> <row_dir> <run_id>: scorers.ts score-all; returns the fail count. */
export function l6cScoreStep(project: string, step: string, rowDir: string, runId: string, env: NodeJS.ProcessEnv = process.env): number {
  return scoreAll(project, step, rowDir, runId, env);
}

/** l6c_write_chain_summary <run_dir> <results_jsonl>: <run_dir>/chain-summary.md, one table row per result line. */
export function l6cWriteChainSummary(runDir: string, results: string): void {
  const rows = [
    `# L6 chain summary — ${basename(runDir)}\n\n`,
    '| #  | Row | Status | Scorer fails | Tokens | Duration (ms) | Notes |\n',
    '|----|-----|--------|--------------|--------|----------------|-------|\n',
  ];
  for (const line of readFileSync(results, 'utf8').split('\n')) {
    if (line === '') continue;
    let r: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(line) as unknown;
      r = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      r = null;
    }
    const cell = (key: string) => (r === null ? '' : stripTrailingNewlines(jqRaw(r[key])));
    const notes = r === null ? '' : stripTrailingNewlines(jqRaw(alt(r.notes, '')));
    rows.push(`| ${cell('id')} | ${cell('name')} | ${cell('status')} | ${cell('scorer_fails')} | ${cell('tokens')} | ${cell('duration_ms')} | ${notes} |\n`);
  }
  writeFileSync(join(runDir, 'chain-summary.md'), rows.join(''));
}
