/**
 * PostToolUse hook on task_update_status and validation_record (GH 1692), the
 * port of scripts/hooks/cleanup-worktree-on-task-close.sh: once a task is
 * closed (bro's task_update_status to closed, or a passing validation_record
 * on a closed task whose pass is anchored to its commit), the task's linked
 * worktree under `<repo>/.claude/worktrees/<slug>` is removed and pruned, and
 * the main checkout is moved to the repo's PR target unless
 * TMB_KEEP_HEAD_ON_CLOSE=1. Every other payload, or a piece that does not
 * resolve, is a silent no-op. Bypass: TMB_KEEP_CLOSED_WORKTREES=1.
 *
 * A worktree the task adopted from the session (tasks.worktree_adopted=1,
 * GH 2032) is not the task's to remove: it is kept, with a note on stderr.
 * Unlike the .sh, it needs neither jq nor the sqlite3 CLI (decision 703).
 */
import { HAS_PASS_SQL } from '../review-sql.js';
import { taskLocation } from './lib/agent-context.js';
import { ALLOW, type GateResult, type SyncGate } from './gate.js';
import { branchSlug, dbPath, haveSqlite, sqlInt, sqliteRo } from './lib/db.js';
import { gitOk, gitOut, isDir } from './lib/git.js';
import { jqCapture, jqInput } from './lib/jq-raw.js';
import { posixDirname } from './lib/project-env.js';
import { repoPathByName, repoResolve, repoSinglePath } from './lib/repo.js';
import { statSync } from 'node:fs';

export const GATE_NAME = 'cleanup-worktree-on-task-close';
export const BYPASS_ENV = 'TMB_KEEP_CLOSED_WORKTREES';
export const KEEP_HEAD_ENV = 'TMB_KEEP_HEAD_ON_CLOSE';
const TOOL = /^mcp__[\s\S]*trajectory-server__(?:task_update_status|validation_record)$/;
const DEFAULT_PR_TARGET = 'dev';
const WORKTREE_LINE = 'worktree ';

export type StderrWriter = (line: string) => void;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The awk match `wt ~ ("/\\.claude/worktrees/" slug "$")`, false where the slug is no valid pattern. */
function slugMatcher(slug: string): (path: string) => boolean {
  try {
    const re = new RegExp(`/\\.claude/worktrees/${slug}$`);
    return (path) => re.test(path);
  } catch {
    return () => false;
  }
}

/** The first linked worktree of `git worktree list --porcelain` that `matches` accepts. */
function listedWorktree(repoRoot: string, matches: (path: string) => boolean, env: NodeJS.ProcessEnv): string {
  for (const line of gitOut(repoRoot, ['worktree', 'list', '--porcelain'], env).split('\n')) {
    if (!line.startsWith(WORKTREE_LINE)) continue;
    const wt = line.slice(WORKTREE_LINE.length);
    if (matches(wt)) return wt;
  }
  return '';
}

/** The repo root the .sh resolves: tasks.repo's repos.path or `<workspace>/<repo>`, else the sole repo, else the workspace. */
function taskRepoRoot(db: string, taskId: string, env: NodeJS.ProcessEnv): string {
  const taskRepo = sqliteRo(db, `SELECT repo FROM tasks WHERE id=${taskId} LIMIT 1;`, env);
  const workspace = posixDirname(posixDirname(posixDirname(db)));
  if (taskRepo !== '') return repoPathByName(db, taskRepo, env) || `${workspace}/${taskRepo}`;
  return repoSinglePath(db, env) || workspace;
}

function resetHead(db: string, repoRoot: string, taskId: string, env: NodeJS.ProcessEnv, stderr: StderrWriter): void {
  const target = repoResolve(db, repoRoot, env).split('|')[0] || DEFAULT_PR_TARGET;
  const current = gitOut(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], env);
  if (!gitOk(repoRoot, ['rev-parse', '--verify', target], env) || current === target) return;
  if (gitOk(repoRoot, ['checkout', target], env)) {
    stderr(`tmb: checked out ${target} after task #${taskId} closed (was on ${current})\n`);
  } else {
    stderr(`tmb: post-close checkout of ${target} failed — leaving on ${current}\n`);
  }
}

export function cleanupWorktree(payload: string, env: NodeJS.ProcessEnv, stderr: StderrWriter): GateResult {
  const input = jqInput(payload);
  const tool = jqCapture(input, ['tool_name']);
  if (!TOOL.test(tool)) return ALLOW;
  if ((env[BYPASS_ENV] ?? '0') === '1') return ALLOW;
  const taskId = jqCapture(input, ['tool_input', 'task_id']);
  const isValidation = tool.endsWith('validation_record');
  if (isValidation) {
    if (jqCapture(input, ['tool_input', 'verdict']) !== 'pass') return ALLOW;
  } else {
    if (jqCapture(input, ['tool_input', 'agent']) !== 'bro') return ALLOW;
    if (jqCapture(input, ['tool_input', 'status']) !== 'closed') return ALLOW;
  }
  const safeId = sqlInt(taskId);
  if (safeId === '') return ALLOW;
  const db = dbPath(env);
  if (db === null || db === '' || !isFile(db) || !haveSqlite(env)) return ALLOW;
  if (isValidation) {
    const passed = sqliteRo(db, `SELECT 1 FROM tasks t WHERE t.id=${safeId} AND t.status='closed' AND ${HAS_PASS_SQL};`, env);
    if (passed !== '1') return ALLOW;
  }
  const branch = sqliteRo(db, `SELECT branch_id FROM tasks WHERE id=${safeId} LIMIT 1;`, env);
  if (branch === '') return ALLOW;
  if (sqliteRo(db, `SELECT worktree_adopted FROM tasks WHERE id=${safeId} LIMIT 1;`, env) === '1') {
    const kept = taskLocation(db, safeId, env);
    if (kept.code === 0) stderr(`tmb: kept adopted worktree ${kept.worktree} after task #${taskId} closed (GH 2032)\n`);
    return ALLOW;
  }
  const repoRoot = taskRepoRoot(db, safeId, env);
  if (!isDir(`${repoRoot}/.git`)) return ALLOW;
  const worktree = listedWorktree(repoRoot, slugMatcher(branchSlug(branch)), env);
  if (worktree === '' || worktree === repoRoot) return ALLOW;
  if (!gitOk(repoRoot, ['worktree', 'remove', worktree, '--force'], env)) {
    stderr(`tmb: worktree remove failed for ${worktree} — leaving in place\n`);
    return ALLOW;
  }
  gitOk(repoRoot, ['worktree', 'prune'], env);
  if (env[KEEP_HEAD_ENV] !== '1') resetHead(db, repoRoot, taskId, env, stderr);
  stderr(`tmb: cleaned up worktree ${worktree} after task #${taskId} closed\n`);
  return ALLOW;
}

export const cleanupWorktreeOnTaskClose: SyncGate = (payload, env) =>
  cleanupWorktree(payload, env, (line) => process.stderr.write(line));
