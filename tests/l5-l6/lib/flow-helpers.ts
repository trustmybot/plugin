// TypeScript port of flow-helpers.sh (GH 1692), the shared helpers of the L5 row runs: the
// test state dir, scratch project setup and DB seeding, the TEST MODE prompt preamble, the
// claude run of one prompt, scoring and cleanup. What the .sh read from runner globals
// (PLUGIN_ROOT, FLOW_NAME, RUN_ID, TMB_CLAUDE_TIMEOUT, L5_KEEP_ARTIFACTS) comes from the env
// or options passed in; nothing here writes process.env.

import { spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPluginName } from '../../../mcp/trajectory-server/dist/hooks/lib/install.js';
import { runWithTimeout } from './timeout.ts';

export const LIB_DIR = dirname(fileURLToPath(import.meta.url));
export const L5_DOGFOOD_DIR = dirname(LIB_DIR);
export const PLUGIN_ROOT = dirname(dirname(L5_DOGFOOD_DIR));

const TEST_PROMPT_PREFIX =
  "[TEST MODE] Do not call AskUserQuestion. Apply sensible defaults and continue; where a skill's normal flow is to hold for the Human (e.g. concerns-protocol), record the note and hold — don't push past it. The Human is not in the loop here. TEST MODE does NOT bypass routing hints from PreToolUse / UserPromptSubmit hooks — when a hook injects a `[tmb consultant-spawn enforcement]` or similar enforcement context, follow it exactly as you would in production. The ceremony (e.g. `/tmb:agent-create`) is the test purpose. If the onboard flow asks its Bash sandbox question, answer No: pass `sandbox_enforcement: 'no'` to `onboard_apply`.";

export interface RunOptions {
  pluginRoot?: string;
  env?: NodeJS.ProcessEnv;
}

/** What a shell `$(...)` capture keeps: trailing newlines dropped. */
export function stripTrailingNewlines(text: string): string {
  return text.replace(/\n+$/, '');
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function tmpParent(env: NodeJS.ProcessEnv): string {
  return (env.TMPDIR || '/tmp').replace(/\/+$/, '');
}

function prefixLines(text: string, prefix: string): string {
  return stripTrailingNewlines(text)
    .split('\n')
    .map((line) => `${prefix}${line}\n`)
    .join('');
}

/** tmb_test_state_dir <plugin_root>: <project>/.claude/<plugin>, or null (with a stderr line) when no project resolves. */
export function tmbTestStateDir(pluginRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
  let project = env.CLAUDE_PROJECT_DIR ?? '';
  if (project === '') {
    const r = spawnSync('git', ['-C', LIB_DIR, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { env, encoding: 'utf8' });
    const common = r.status === 0 ? stripTrailingNewlines(r.stdout) : '';
    if (common !== '') project = dirname(common);
  }
  if (project === '') {
    process.stderr.write(`tmb_test_state_dir: CLAUDE_PROJECT_DIR is unset and ${LIB_DIR} is not inside a git repo\n`);
    return null;
  }
  const plugin = installPluginName({ ...env, CLAUDE_PLUGIN_ROOT: pluginRoot });
  return `${project}/.claude/${plugin}`;
}

/** l5_init_state_dir <project_dir>: <project>/.claude/tmb plus its empty `standalone` marker (GH 1553). */
export function l5InitStateDir(project: string): void {
  mkdirSync(join(project, '.claude', 'tmb'), { recursive: true });
  writeFileSync(join(project, '.claude', 'tmb', 'standalone'), '');
}

/** l5_setup_scratch_project: a fresh git repo under $TMPDIR with one commit and the state dir; returns its path. */
export function l5SetupScratchProject(env: NodeJS.ProcessEnv = process.env): string {
  const dir = mkdtempSync(`${tmpParent(env)}/tmb-l5-`);
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, env, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'l6@l6.test');
  git('config', 'user.name', 'L5 Test');
  writeFileSync(join(dir, 'README.md'), 'init\n');
  writeFileSync(join(dir, '.gitignore'), '.claude/\n');
  if (git('add', '.').status === 0) git('commit', '-qm', 'init');
  l5InitStateDir(dir);
  return dir;
}

function sqliteScript(db: string, script: string, env: NodeJS.ProcessEnv): number {
  const r = spawnSync('sqlite3', [db], { input: readFileSync(script), env, stdio: ['pipe', 'inherit', 'inherit'] });
  return r.status ?? 1;
}

/** l5_seed_db <project_dir> <fixture_name>: applies schema.sql then fixtures/<name>.sql; returns the last sqlite3 exit code. */
export function l5SeedDb(project: string, fixture: string, opts: RunOptions = {}): number {
  const env = opts.env ?? process.env;
  const fixturePath = join(L5_DOGFOOD_DIR, 'fixtures', `${fixture}.sql`);
  if (!isFile(fixturePath)) {
    process.stderr.write(`  ✗ fixture not found: ${fixturePath}\n`);
    return 1;
  }
  const db = join(project, '.claude', 'tmb', 'trajectory.db');
  sqliteScript(db, join(opts.pluginRoot ?? PLUGIN_ROOT, 'mcp', 'trajectory-server', 'src', 'schema.sql'), env);
  return sqliteScript(db, fixturePath, env);
}

/** l5_preserve_trajectory <project_dir> <flow> <run_id>: best-effort copy of the run log and DB into the state dir. */
export function l5PreserveTrajectory(project: string, flow: string, runId: string, opts: RunOptions = {}): void {
  const state = tmbTestStateDir(opts.pluginRoot ?? PLUGIN_ROOT, opts.env ?? process.env);
  if (state === null) return;
  const dest = `${state}/l5-trajectories/${flow}/${runId}`;
  try {
    mkdirSync(dest, { recursive: true });
  } catch {
    return;
  }
  for (const [src, name] of [
    [join(project, 'trajectory.jsonl'), 'trajectory.jsonl'],
    [join(project, '.claude', 'tmb', 'trajectory.db'), 'trajectory.db'],
  ]) {
    if (!isFile(src)) continue;
    try {
      copyFileSync(src, join(dest, name));
    } catch {
      continue;
    }
  }
}

/** _l5_test_prompt_prefix: the TEST MODE preamble, as its `$(...)` capture reads. */
export function l5TestPromptPrefix(): string {
  return TEST_PROMPT_PREFIX;
}

/** l5_compose_test_prompt <prompt>: the preamble, one blank line, then the prompt. */
export function l5ComposeTestPrompt(prompt: string): string {
  return `${TEST_PROMPT_PREFIX}\n\n${prompt}`;
}

/** _l5_write_pre_run_git_snapshot <project_dir>: .claude/tmb/_l5_pre_run_git.json with HEAD and branch, when HEAD resolves. */
export function l5WritePreRunGitSnapshot(project: string, env: NodeJS.ProcessEnv = process.env): void {
  const rev = (...args: string[]) => spawnSync('git', ['-C', project, 'rev-parse', ...args], { env, encoding: 'utf8' });
  const head = rev('HEAD');
  if (head.status !== 0) return;
  const branch = rev('--abbrev-ref', 'HEAD');
  l5InitStateDir(project);
  const preHead = stripTrailingNewlines(head.stdout);
  const preBranch = branch.status === 0 ? stripTrailingNewlines(branch.stdout) : '';
  writeFileSync(join(project, '.claude', 'tmb', '_l5_pre_run_git.json'), `{"head":"${preHead}","branch":"${preBranch}"}\n`);
}

/** The env one claude step runs with: TMB_DEBUG_TRAJECTORY=1 and CLAUDE_CODE_OAUTH_TOKEN exported. */
export function claudeStepEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, TMB_DEBUG_TRAJECTORY: '1', CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN ?? '' };
}

export function claudeTimeoutSecs(env: NodeJS.ProcessEnv): number {
  const secs = Number(env.TMB_CLAUDE_TIMEOUT || '600');
  return Number.isFinite(secs) ? secs : 600;
}

/** Runs `claude <args>` in <cwd> under the step timeout, stdout to <outFile>, stderr echoed with a `[claude-err]` prefix. */
export function runClaudeToFile(cwd: string, args: readonly string[], outFile: string, env: NodeJS.ProcessEnv): number {
  const fd = openSync(outFile, 'w');
  try {
    const r = runWithTimeout(claudeTimeoutSecs(env), 'claude', args, { cwd, env, stdio: ['inherit', fd, 'pipe'] });
    if (r.stderr !== '') process.stderr.write(prefixLines(r.stderr, '  [claude-err] '));
    return r.status;
  } finally {
    closeSync(fd);
  }
}

function runLogSummary(jsonl: string): { assistantMsgs: number; durationMs: number } {
  let text = '';
  try {
    text = readFileSync(jsonl, 'utf8');
  } catch {
    return { assistantMsgs: 0, durationMs: 0 };
  }
  const lines = text.split('\n');
  const assistantMsgs = lines.filter((line) => line.includes('"type":"assistant"')).length;
  let durationMs = 0;
  try {
    for (const line of lines) {
      if (line.trim() === '') continue;
      const ev = JSON.parse(line) as { type?: unknown; duration_ms?: unknown };
      if (ev?.type !== 'result') continue;
      const ms = typeof ev.duration_ms === 'number' ? ev.duration_ms : 0;
      if (ms > durationMs) durationMs = ms;
    }
  } catch {
    durationMs = 0;
  }
  return { assistantMsgs, durationMs };
}

/** l5_run_claude <project_dir> <prompt>: one stream-json claude run into <dir>/trajectory.jsonl; always returns 0. */
export function l5RunClaude(project: string, prompt: string, opts: RunOptions = {}): number {
  const pluginRoot = opts.pluginRoot ?? PLUGIN_ROOT;
  const baseEnv = opts.env ?? process.env;
  const jsonl = join(project, 'trajectory.jsonl');
  const fullPrompt = stripTrailingNewlines(l5ComposeTestPrompt(prompt));

  l5WritePreRunGitSnapshot(project, baseEnv);

  const env = claudeStepEnv(baseEnv);
  process.stderr.write(
    `  ── claude invocation start ──\n  cwd: ${project}\n  plugin-dir: ${pluginRoot}\n  prompt: ${prompt}\n  jsonl: ${jsonl}\n`,
  );
  runClaudeToFile(
    project,
    [
      '--plugin-dir',
      pluginRoot,
      '--dangerously-skip-permissions',
      '--output-format',
      'stream-json',
      '--include-hook-events',
      '--include-partial-messages',
      '--verbose',
      '-p',
      fullPrompt,
    ],
    jsonl,
    env,
  );
  const { assistantMsgs, durationMs } = runLogSummary(jsonl);
  process.stderr.write(`  ── claude invocation end (assistant_msgs=${assistantMsgs}, duration_ms=${durationMs}) ──\n`);
  if (env.FLOW_NAME && env.RUN_ID) l5PreserveTrajectory(project, env.FLOW_NAME, env.RUN_ID, { pluginRoot, env });
  return 0;
}

/** Runs scorers.ts score-all with stdio inherited; returns its exit code, the fail count. */
export function scoreAll(project: string, flow: string, scorerDir: string, runId: string, env: NodeJS.ProcessEnv = process.env): number {
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--experimental-sqlite', join(LIB_DIR, 'scorers.ts'), 'score-all', project, flow, scorerDir, runId],
    { env, stdio: 'inherit' },
  );
  return r.status ?? 1;
}

/** l5_score_flow <project_dir> <flow_name> <scorer_dir> <run_id>. */
export function l5ScoreFlow(project: string, flow: string, scorerDir: string, runId: string, env: NodeJS.ProcessEnv = process.env): number {
  return scoreAll(project, flow, scorerDir, runId, env);
}

/** l5_cleanup_project <project_dir>: removes it, unless L5_KEEP_ARTIFACTS=1. */
export function l5CleanupProject(project: string, env: NodeJS.ProcessEnv = process.env): void {
  if ((env.L5_KEEP_ARTIFACTS ?? '0') === '1') return;
  if (project !== '' && isDir(project)) rmSync(project, { recursive: true, force: true });
}
