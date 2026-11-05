/**
 * Shared fixtures for the git-push-guard l3 ports (GH 1692): temp git repos
 * with a bare upstream, a trajectory DB from schema.sql with task, review and
 * verification rows, and the `node dist/hooks.js git-push-guard` run with
 * CLAUDE_PROJECT_DIR pinned to the sandbox.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { PLUGIN_ROOT, runGate, type Sandbox } from './hook-sandbox.js';

export const GATE = 'git-push-guard';
export const DENY = '"permissionDecision":"deny"';
export const NO_DB = '/nonexistent.db';
export const INTEGRATE = 'dist/cli.js\\" integrate <task_id> <base>';
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');

export function tryGit(env: NodeJS.ProcessEnv, repo: string, args: string[], input?: string) {
  return spawnSync('git', ['-C', repo, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { env, input, encoding: 'utf8' });
}

export function git(env: NodeJS.ProcessEnv, repo: string, ...args: string[]): string {
  const r = tryGit(env, repo, args);
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Runs one statement on <db> with <params> bound. */
export function sql(db: string, statement: string, ...params: SQLInputValue[]): void {
  const d = new DatabaseSync(db);
  try {
    d.prepare(statement).run(...params);
  } finally {
    d.close();
  }
}

/** <repo>/.claude/tmb/trajectory.db from schema.sql, with issue 1. */
export function newDb(repo: string): string {
  const db = join(repo, '.claude/tmb/trajectory.db');
  mkdirSync(dirname(db), { recursive: true });
  const d = new DatabaseSync(db);
  try {
    d.exec(SCHEMA);
  } finally {
    d.close();
  }
  sql(db, "INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'test', 'test', 'open', datetime('now'), datetime('now'))");
  return db;
}

/** A closed task <id> of issue 1 whose commit_sha is <sha>. */
export function insertTask(db: string, id: number, sha: string, branch = `feat/x-${id}`): void {
  sql(
    db,
    `INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, commit_sha, created_at, updated_at)
       VALUES (?, 1, ?, ?, 'd', 'closed', '## body', ?, datetime('now'), datetime('now'))`,
    id,
    branch,
    `task ${id}`,
    sha,
  );
}

/** bro's bro_verification_pass audit row for task <id>'s current commit_sha, the review anchor, at <at>. */
export function anchorTask(db: string, id: number, at = new Date().toISOString()): void {
  sql(
    db,
    `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
       SELECT 1, 'bro', 'bro_verification_pass', 'verified', json_object('task_id', id, 'commit_sha', commit_sha), ? FROM tasks WHERE id = ?`,
    at,
    id,
  );
}

/** A passing code-reviewer verdict, the task's next attempt, for task <id> at <at>, with no anchor. */
export function passTask(db: string, id: number, at = new Date().toISOString()): void {
  sql(
    db,
    `INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, feedback, created_at)
       SELECT ?1, COALESCE(MAX(attempt_n), 0) + 1, 'code-reviewer', 'pass', 1, 'LGTM', ?2 FROM validation_attempts WHERE task_id = ?1`,
    id,
    at,
  );
}

/** A passing code-reviewer verdict for task <id>'s current commit_sha: its anchor, then a pass at the same instant. */
export function signTask(db: string, id: number): void {
  const at = new Date().toISOString();
  anchorTask(db, id, at);
  passTask(db, id, at);
}

/** A verification run of task <task> on <sha>. */
export function recordRun(db: string, task: number, sha: string, exitCode: number, opts: { source?: string; timedOut?: number } = {}): void {
  sql(
    db,
    `INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out)
       VALUES (?, ?, ?, '2026-10-19T00:00:00.000Z', '2026-10-19T00:01:00.000Z', ?, 900, ?)`,
    task,
    sha,
    opts.source ?? 'manual',
    exitCode,
    opts.timedOut ?? 0,
  );
}

/** A repos row; <target> null leaves target_branch unset. */
export function insertRepo(db: string, name: string, path: string, target: string | null): void {
  sql(db, 'INSERT OR REPLACE INTO repos (name, path, target_branch) VALUES (?, ?, ?)', name, path, target);
}

/** A fresh repo at <repo> on <branch> with a bare upstream.git inside it as origin. */
export function initRepo(env: NodeJS.ProcessEnv, repo: string, branch: string): void {
  mkdirSync(repo, { recursive: true });
  git(env, repo, 'init', '-q', '-b', branch);
  git(env, repo, 'init', '--bare', '-q', 'upstream.git');
  git(env, repo, 'remote', 'add', 'origin', join(repo, 'upstream.git'));
}

/** Appends each body to its path under <repo>, commits them as <msg> and returns the SHA. */
export function commit(env: NodeJS.ProcessEnv, repo: string, msg: string, files: Record<string, string>): string {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    appendFileSync(join(repo, path), body);
  }
  git(env, repo, 'add', '--', ...Object.keys(files));
  git(env, repo, 'commit', '-qm', msg);
  return git(env, repo, 'rev-parse', 'HEAD');
}

export interface PushRun {
  cwd: string;
  db?: string;
  agent?: string;
  payloadCwd?: string;
}

/** The env a shell in <cwd> hands the gate: the sandbox's, CLAUDE_PROJECT_DIR pinned to it, PWD set. */
export function gateEnv(sb: Sandbox, cwd: string): NodeJS.ProcessEnv {
  return { ...sb.env, CLAUDE_PROJECT_DIR: sb.dir, PWD: cwd };
}

/** The gate's stdout and stderr for a Bash <command> (a `2>&1`). */
export function push(sb: Sandbox, command: string, opts: PushRun): string {
  const payload: Record<string, unknown> = { tool_input: { command } };
  if (opts.agent !== undefined) payload.agent_type = opts.agent;
  if (opts.payloadCwd !== undefined) payload.cwd = opts.payloadCwd;
  const r = runGate(GATE, {
    cwd: opts.cwd,
    input: JSON.stringify(payload),
    env: { ...gateEnv(sb, opts.cwd), TRAJECTORY_DB_PATH: opts.db ?? NO_DB },
  });
  return r.stdout + r.stderr;
}

export const has = (out: string, s: string, msg: string) => assert.ok(out.includes(s), `${msg}\n--- output ---\n${out}`);
export const hasNot = (out: string, s: string, msg: string) => assert.ok(!out.includes(s), `${msg}\n--- output ---\n${out}`);
