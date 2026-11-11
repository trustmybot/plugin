/**
 * Shared fixtures for the swe-verification-gate l3 ports (GH 1692). The layout
 * mirrors the real TMB workspace: the DB at <ws>/.claude/tmb/trajectory.db, the
 * repo at <ws>/plugin and worktrees under <ws>/plugin/.claude/worktrees/<slug>,
 * resolved through tasks.repo → repos.path (#156). Each case runs
 * `node dist/hooks.js swe-verification-gate` with CLAUDE_PROJECT_DIR pinned to
 * the workspace, PWD set and mise's state kept inside the sandbox.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOOKS_JS, jsonValues, makeSandbox, runGate, type HookRun, type Sandbox } from './hook-sandbox.js';
import { git, sql } from './git-push-guard-l3.js';
import { execDb, q } from './swe-atomic-close-l3.js';

export const GATE = 'swe-verification-gate';
export const TOOL_NAME = 'mcp__tmb__trajectory-server__task_update_status';

const SCHEMA = `
CREATE TABLE issues (
  id INTEGER PRIMARY KEY,
  objective TEXT NOT NULL DEFAULT 'test',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  repo TEXT
);
CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  target_branch TEXT
);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  branch_id TEXT NOT NULL,
  parent_branch_id TEXT,
  repo TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  spec_body TEXT NOT NULL DEFAULT '',
  verification TEXT NOT NULL DEFAULT '[]',
  commit_sha TEXT
);
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL,
  branch_id TEXT,
  from_node TEXT NOT NULL DEFAULT 'swe',
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL DEFAULT '{}',
  repo TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE verification_runs (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('gate','manual')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_code INTEGER,
  budget_s INTEGER NOT NULL,
  timed_out INTEGER NOT NULL DEFAULT 0 CHECK (timed_out IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE verification_run_commands (
  run_id INTEGER NOT NULL REFERENCES verification_runs(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER,
  elapsed_s REAL,
  output_tail TEXT,
  PRIMARY KEY (run_id, ordinal)
);
INSERT INTO issues VALUES (1, 'test', '', 'open', datetime('now'), datetime('now'), NULL);
`;

export const FINDINGS_SCHEMA = `
CREATE TABLE review_findings (
  id TEXT PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_n INTEGER NOT NULL,
  criterion_id TEXT,
  probe_cmd TEXT NOT NULL,
  expected TEXT NOT NULL,
  observed TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','fixed','wontfix')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
`;

export interface Ws {
  sb: Sandbox;
  ws: string;
  db: string;
  repo: string;
  wtRoot: string;
  lockRoot: string;
}

/**
 * The workspace with repos row `plugin` and tasks 1–4 with their worktree dirs (task 1's holds a passing tests/run.sh).
 * <ws>/plugin is a git repo with one empty commit, so a plain worktree dir resolves its HEAD and PR target there
 * and passes the gate's changelog and doc checks on an empty diff (GH 2866).
 */
export function makeWs(name: string): Ws {
  const sb = makeSandbox(name);
  const ws = join(sb.dir, 'ws');
  const db = join(ws, '.claude/tmb/trajectory.db');
  const repo = join(ws, 'plugin');
  const wtRoot = join(repo, '.claude/worktrees');
  mkdirSync(join(ws, '.claude/tmb'), { recursive: true });
  for (const slug of ['my-feature/tests', 'fail-verify', 'no-verify', 'multi-cmd']) mkdirSync(join(wtRoot, slug), { recursive: true });
  for (const d of ['data', 'state', 'cache']) mkdirSync(join(sb.dir, 'mise', d), { recursive: true });
  execDb(db, SCHEMA);
  sql(db, "INSERT INTO repos (id, name, path) VALUES (1, 'plugin', ?)", repo);
  mkdirSync(repo, { recursive: true });
  git(sb.env, repo, 'init', '--quiet');
  git(sb.env, repo, 'commit', '--quiet', '--allow-empty', '-m', 'init');
  addTask(db, 1, 'my-feature', ['bash tests/run.sh']);
  addTask(db, 2, 'no-verify', []);
  addTask(db, 3, 'fail-verify', ['exit 1']);
  addTask(db, 4, 'multi-cmd', ['echo ok', 'exit 0']);
  const runSh = join(wtRoot, 'my-feature/tests/run.sh');
  writeFileSync(runSh, '#!/usr/bin/env bash\necho "all tests pass"\n');
  chmodSync(runSh, 0o755);
  return { sb, ws, db, repo, wtRoot, lockRoot: join(ws, '.claude/tmb/locks') };
}

/** Task <id> on branch feat/<slug> of repo `plugin` with <verification>. */
export function addTask(db: string, id: number, slug: string, verification: string[], opts: { status?: string; commitSha?: string } = {}): void {
  sql(
    db,
    "INSERT INTO tasks (id, issue_id, branch_id, repo, status, spec_body, verification, commit_sha) VALUES (?, 1, ?, 'plugin', ?, '', ?, ?)",
    id,
    `feat/${slug}`,
    opts.status ?? 'pending',
    JSON.stringify(verification),
    opts.commitSha ?? null,
  );
}

/** The task_update_status payload for <agent> setting <status> on <task>, with commit_sha when given. */
export function makeInput(agent: string, status: string, task: number | string, sha = '', extra: Record<string, unknown> = {}): string {
  const toolInput: Record<string, unknown> = { agent, status, task_id: String(task) };
  if (sha !== '') toolInput.commit_sha = sha;
  return JSON.stringify({ tool_name: TOOL_NAME, tool_input: { ...toolInput, ...extra } });
}

/** The env the gate runs in from <cwd>: CLAUDE_PROJECT_DIR pinned to the workspace, PWD set, mise state in the sandbox. */
export function gateEnvOf(w: Ws, cwd: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...w.sb.env,
    CLAUDE_PROJECT_DIR: w.ws,
    PWD: cwd,
    TRAJECTORY_DB_PATH: w.db,
    MISE_DATA_DIR: join(w.sb.dir, 'mise/data'),
    MISE_STATE_DIR: join(w.sb.dir, 'mise/state'),
    MISE_CACHE_DIR: join(w.sb.dir, 'mise/cache'),
    ...extra,
  };
}

/** The gate run for <input> from <cwd> (default the repo). */
export function runHook(w: Ws, input: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv; gate?: string } = {}): HookRun {
  const cwd = opts.cwd ?? w.repo;
  return runGate(opts.gate ?? GATE, { cwd, input: `${input}\n`, env: gateEnvOf(w, cwd, opts.env) });
}

/** The gate's stdout + stderr (a `2>&1`). */
export function hook(w: Ws, input: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const r = runHook(w, input, opts);
  return r.stdout + r.stderr;
}

/** The gate run as a child that may overlap another; resolves to its stdout + stderr. */
export function hookAsync(w: Ws, input: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [HOOKS_JS, GATE], { cwd: w.repo, env: gateEnvOf(w, w.repo, env) });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    child.stderr.on('data', (b: Buffer) => (out += b.toString()));
    child.on('error', fail);
    child.on('close', () => done(out));
    child.stdin.end(`${input}\n`);
  });
}

function hookOutput(stdout: string): Record<string, unknown> | undefined {
  const v = jsonValues(stdout)[0] as { hookSpecificOutput?: Record<string, unknown> } | undefined;
  return v?.hookSpecificOutput;
}

/** hookSpecificOutput.permissionDecisionReason of the gate's JSON, '' when absent. */
export function reasonOf(stdout: string): string {
  const r = hookOutput(stdout)?.permissionDecisionReason;
  return typeof r === 'string' ? r : '';
}

/** hookSpecificOutput.additionalContext of the gate's JSON, '' when absent. */
export function contextOfGate(stdout: string): string {
  const c = hookOutput(stdout)?.additionalContext;
  return typeof c === 'string' ? c : '';
}

export const hasDenyReasonKey = (stdout: string): boolean => {
  const h = hookOutput(stdout);
  return h !== undefined && 'denyReason' in h;
};

export const runsOf = (w: Ws, task: number) => q(w.db, 'SELECT COUNT(*) FROM verification_runs WHERE task_id = ?', task);

/** The worktree <slug> as a git repo with one empty commit; returns HEAD. */
export function gitWorktree(w: Ws, slug: string): string {
  const wt = join(w.wtRoot, slug);
  mkdirSync(wt, { recursive: true });
  git(w.sb.env, wt, 'init', '--quiet');
  git(w.sb.env, wt, 'commit', '--quiet', '--allow-empty', '-m', 'init');
  return git(w.sb.env, wt, 'rev-parse', 'HEAD');
}

/** The worktree <slug> as a git repo with no commit, so its HEAD does not resolve. */
export function unbornWorktree(w: Ws, slug: string): void {
  const wt = join(w.wtRoot, slug);
  mkdirSync(wt, { recursive: true });
  git(w.sb.env, wt, 'init', '--quiet');
}

/** An empty commit <msg> in worktree <slug>; returns HEAD. */
export function gitCommit(w: Ws, slug: string, msg: string): string {
  const wt = join(w.wtRoot, slug);
  git(w.sb.env, wt, 'commit', '--quiet', '--allow-empty', '-m', msg);
  return git(w.sb.env, wt, 'rev-parse', 'HEAD');
}

/** The number of lines in <path> (a `wc -l`), 0 when it is absent. */
export function lineCount(path: string): number {
  if (!existsSync(path)) return 0;
  return (readFileSync(path, 'utf8').match(/\n/g) ?? []).length;
}

export { execDb, q };
