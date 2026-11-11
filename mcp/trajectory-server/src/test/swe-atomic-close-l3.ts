/**
 * Shared fixtures for the swe-atomic-close l3 ports (GH 1692): temp git repos
 * on dev, a trajectory DB from the gate's minimal schema, spawn transcripts
 * naming a task, and the `node dist/hooks.js swe-atomic-close` run with
 * CLAUDE_PROJECT_DIR pinned to the sandbox and PWD set. Query results read the
 * way the sqlite3 CLI prints them: columns joined by `|`, NULL as ''.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { runGate, type HookRun, type Sandbox } from './hook-sandbox.js';
import { gateEnv, git } from './git-push-guard-l3.js';

export const GATE = 'swe-atomic-close';
export const NO_COMMITS = 'stopped without committing';

export const MIN_SCHEMA = `
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL DEFAULT 1,
  branch_id TEXT NOT NULL,
  parent_branch_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  spec_body TEXT NOT NULL DEFAULT '',
  commit_sha TEXT,
  repo TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  effort TEXT NOT NULL DEFAULT 'medium',
  checkpoint TEXT
);
CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, target_branch TEXT, branching_model TEXT, protected_branches TEXT, file_count INTEGER NOT NULL DEFAULT 0, last_scanned_at TEXT NOT NULL DEFAULT '');
CREATE TABLE issues (id INTEGER PRIMARY KEY, repo TEXT);
INSERT INTO issues (id) VALUES (-1), (1);
CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL, branch_id TEXT, from_node TEXT NOT NULL, event_type TEXT NOT NULL, summary TEXT NOT NULL, content_json TEXT NOT NULL DEFAULT '{}', repo TEXT, created_at TEXT NOT NULL);
CREATE TABLE agent_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, issue_id INTEGER, agent_type TEXT NOT NULL, tokens_in INTEGER, tokens_out INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER, tool_uses INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, started_at TEXT, completed_at TEXT, repo TEXT, spawn_id TEXT, session_id TEXT, usage_source TEXT, root_dir TEXT, model TEXT, host TEXT, exit_reason TEXT, effort TEXT, plugin_version TEXT, stop_cause TEXT, stop_detail TEXT);
CREATE UNIQUE INDEX idx_agent_runs_spawn ON agent_runs(task_id, spawn_id) WHERE spawn_id IS NOT NULL;
CREATE TABLE verification_runs (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, commit_sha TEXT NOT NULL, source TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER, budget_s INTEGER NOT NULL, timed_out INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL DEFAULT '""');
INSERT INTO plugin_config (key, value_json) VALUES ('pr_target', '"dev"');
`;

/** Runs <statements> on <db> with foreign keys off, as the sqlite3 CLI does. */
export function execDb(db: string, statements: string): void {
  const d = new DatabaseSync(db, { enableForeignKeyConstraints: false });
  try {
    d.exec(statements);
  } finally {
    d.close();
  }
}

/** The rows of <statement> as `$(sqlite3 …)` reads them: one line per row, columns joined by `|`, NULL as '', trailing newlines cut. */
export function q(db: string, statement: string, ...params: SQLInputValue[]): string {
  const d = new DatabaseSync(db, { enableForeignKeyConstraints: false });
  try {
    return d
      .prepare(statement)
      .all(...params)
      .map((row) => Object.values(row).map((v) => (v === null ? '' : String(v))).join('|'))
      .join('\n')
      .replace(/\n+$/, '');
  } finally {
    d.close();
  }
}

/** <repo>/.claude/tmb/trajectory.db from MIN_SCHEMA. */
export function newMinDb(repo: string): string {
  const db = join(repo, '.claude/tmb/trajectory.db');
  mkdirSync(dirname(db), { recursive: true });
  execDb(db, MIN_SCHEMA);
  return db;
}

/** A fresh repo at <repo> on dev with one `base` commit. */
export function initRepo(env: NodeJS.ProcessEnv, repo: string, file = 'base.txt', body = 'base\n', msg = 'base'): void {
  mkdirSync(repo, { recursive: true });
  git(env, repo, 'init', '-q', '-b', 'dev');
  git(env, repo, 'config', 'user.email', 't@t.io');
  git(env, repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, file), body);
  git(env, repo, 'add', '.');
  git(env, repo, 'commit', '-qm', msg);
}

let seq = 0;

/** Appends a fresh line to <file> in <dir>, commits it as <msg> and returns HEAD. */
export function commitIn(env: NodeJS.ProcessEnv, dir: string, file: string, msg: string): string {
  seq += 1;
  appendFileSync(join(dir, file), `${seq}-${Math.random()}\n`);
  git(env, dir, 'add', file);
  git(env, dir, 'commit', '-qm', msg);
  return git(env, dir, 'rev-parse', 'HEAD');
}

/** Writes <lines> as a JSONL transcript at <path> and returns <path>. */
export function writeTranscript(path: string, lines: Array<string | object>): string {
  writeFileSync(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return path;
}

/** A fresh swe transcript in <dir> whose plain-string spawn prompt names <task>. */
export function spawnTranscript(dir: string, task: number): string {
  seq += 1;
  return writeTranscript(join(dir, `spawn-${seq}`), [
    { type: 'user', timestamp: '2026-04-01T00:00:00.000Z', message: { role: 'user', content: `task_id=${task} You are swe. Implement the spec.` } },
    { type: 'assistant', timestamp: '2026-04-01T00:00:02.000Z', message: { role: 'assistant', usage: { input_tokens: 10, output_tokens: 5 }, content: [] } },
  ]);
}

/** A SubagentStop payload for one fresh spawn of <agentType> on <task>. */
export function spawnInput(dir: string, task: number, agentType = 'swe'): object {
  const tp = spawnTranscript(dir, task);
  return { agent_type: agentType, agent_id: tp.slice(tp.lastIndexOf('/') + 1), agent_transcript_path: tp, hook_event_name: 'SubagentStop', session_id: 'sess-test' };
}

/** The gate run from <cwd> on <db> for <payload>. */
export function runHook(sb: Sandbox, cwd: string, db: string, payload: object, extra: NodeJS.ProcessEnv = {}): HookRun {
  return runGate(GATE, { cwd, input: `${JSON.stringify(payload)}\n`, env: { ...gateEnv(sb, cwd), TRAJECTORY_DB_PATH: db, ...extra } });
}

/** The gate's stdout + stderr (a `2>&1`) for <payload>, run from <cwd> on <db>. */
export function hook(sb: Sandbox, cwd: string, db: string, payload: object, extra: NodeJS.ProcessEnv = {}): string {
  const r = runHook(sb, cwd, db, payload, extra);
  return r.stdout + r.stderr;
}

/** Records a verification_runs row for (<task>, <sha>), passing unless <exitCode>/<timedOut> say otherwise, as swe-verification-gate does. */
export function recordRun(db: string, task: number, sha: string, exitCode = 0, timedOut = 0): void {
  const d = new DatabaseSync(db, { enableForeignKeyConstraints: false });
  try {
    d.prepare(
      "INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out) VALUES (?, ?, 'gate', datetime('now'), datetime('now'), ?, 600, ?)",
    ).run(task, sha, exitCode, timedOut);
  } finally {
    d.close();
  }
}

export const gatePendingCount = (db: string, task: number) =>
  Number(q(db, "SELECT COUNT(*) FROM audit WHERE event_type='swe_atomic_close_gate_pending' AND from_node='hook:swe-atomic-close' AND json_extract(content_json, '$.task_id')=?", task));

export const skippedCount =(db: string) => q(db, "SELECT COUNT(*) FROM audit WHERE event_type='agent_runs_capture_skipped' AND from_node='hook:swe-atomic-close';");
