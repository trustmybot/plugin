/**
 * TypeScript port of scripts/hooks/ensure-swe-worktree.sh (GH 1692), the
 * first PREPARE step of agent-spawn-dispatch: before a swe spawn for
 * task_id=<N> it makes sure the task's branch has a linked worktree at
 * <repo>/.claude/worktrees/<slug>, creating it with `git worktree add` when
 * none is registered. Every skip is a stderr line and exit 0; it never
 * blocks the spawn. TMB_DISABLE_ENSURE_SWE_WORKTREE=1 bypasses it.
 *
 * GH 2032 (decision 703): a task with a recorded tasks.worktree_path, read
 * through taskLocation, already has its worktree when that path exists, so
 * no slug worktree is added beside it. Unlike the .sh, it needs neither jq
 * nor the sqlite3 CLI.
 */
import { existsSync } from 'node:fs';
import { ALLOW, type GateResult, type SyncGate } from './gate.js';
import { taskLocation } from './lib/agent-context.js';
import { branchSlug, dbPath, haveSqlite, sqlInt, sqliteRo, stripTrailingNewlines } from './lib/db.js';
import { gitOk, gitRun, isDir } from './lib/git.js';
import { jqCapture, jqInput, type JqInput } from './lib/jq-raw.js';
import { commandSubstitution, posixDirname } from './lib/project-env.js';
import { repoPathByName, repoSinglePath } from './lib/repo.js';
import { normalizeRole } from './lib/role.js';
import { promptTaskId } from './require-task-spec.js';

export const GATE_NAME = 'ensure-swe-worktree';

/** `echo "$text" | cut -d'|' -f<n>` as a `$(...)` capture holds it. */
export function cutField(text: string, n: number): string {
  const lines = text.split('\n').map((line) => (line.includes('|') ? (line.split('|')[n - 1] ?? '') : line));
  return stripTrailingNewlines(lines.join('\n'));
}

/** The task id of a swe spawn payload's prompt, "" for another role or none. */
export function sweSpawnTaskId(input: JqInput): string {
  if (normalizeRole(jqCapture(input, ['tool_input', 'subagent_type'], true)) !== 'swe') return '';
  return sqlInt(promptTaskId(jqCapture(input, ['tool_input', 'prompt'], true)));
}

/** The .sh's REPO_ROOT: the repos row's path as stored, else a path under the workspace root. */
export function prepareRepoRoot(db: string, repo: string, env: NodeJS.ProcessEnv): string {
  const workspaceRoot = posixDirname(posixDirname(posixDirname(db)));
  if (repo !== '') return repoPathByName(db, repo, env) || `${workspaceRoot}/${repo}`;
  return repoSinglePath(db, env) || workspaceRoot;
}

/** The task's recorded tasks.worktree_path (GH 2032) when it is set and exists, else "". */
export function recordedWorktree(db: string, taskId: string, branch: string, env: NodeJS.ProcessEnv): string {
  const loc = taskLocation(db, taskId, env);
  if (loc.code !== 0 || loc.worktree === `${loc.repoRoot}/.claude/worktrees/${branchSlug(branch)}`) return '';
  return existsSync(loc.worktree) ? loc.worktree : '';
}

function registered(repoRoot: string, slug: string, env: NodeJS.ProcessEnv): boolean {
  let pattern: RegExp;
  try {
    pattern = new RegExp(`^worktree .*/\\.claude/worktrees/${slug}$`);
  } catch {
    return false;
  }
  return gitRun(repoRoot, ['worktree', 'list', '--porcelain'], env)
    .stdout.split('\n')
    .some((line) => pattern.test(line));
}

function skip(line: string): GateResult {
  process.stderr.write(`ensure-swe-worktree: ${line}\n`);
  return ALLOW;
}

export const ensureSweWorktree: SyncGate = (payload, env): GateResult => {
  if (env.TMB_DISABLE_ENSURE_SWE_WORKTREE === '1') return ALLOW;
  const taskId = sweSpawnTaskId(jqInput(commandSubstitution(payload)));
  if (taskId === '') return ALLOW;

  const db = dbPath(env);
  if (db === null || !haveSqlite(env)) return skip('no trajectory DB or sqlite3 — skipping (non-isolated fallback)');

  const row = sqliteRo(db, `SELECT branch_id, repo FROM tasks WHERE id=${taskId};`, env);
  if (row === '') return skip(`no tasks row for task_id=${taskId} — skipping`);
  const branch = cutField(row, 1);
  const repo = cutField(row, 2);
  if (branch === '') return skip(`task_id=${taskId} has empty branch_id — skipping`);
  if (recordedWorktree(db, taskId, branch, env) !== '') return ALLOW;

  const slug = branchSlug(branch);
  const repoRoot = prepareRepoRoot(db, repo, env);
  if (!isDir(`${repoRoot}/.git`)) return skip(`repo root '${repoRoot}' is not a git repo — skipping`);

  const wtRel = `.claude/worktrees/${slug}`;
  const wtAbs = `${repoRoot}/${wtRel}`;
  if (registered(repoRoot, slug, env)) return ALLOW;
  if (existsSync(wtAbs)) return skip(`'${wtAbs}' exists but is not a registered worktree — skipping`);

  if (gitOk(repoRoot, ['worktree', 'add', wtRel, branch], env)) {
    return skip(`created worktree ${wtAbs} for branch ${branch}`);
  }
  return skip(`'git worktree add ${wtRel} ${branch}' failed — skipping (non-isolated fallback)`);
};
