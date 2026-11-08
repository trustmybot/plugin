/**
 * PreToolUse(Agent) gate (GH 1740), run by agent-spawn-dispatch after
 * code-reviewer-after-atomic-close: before a code-reviewer spawn for task_id=<N>,
 * five deterministic checks on the task's commit, in order. The first that
 * fails denies with the JSON reason {check, expected, actual}, so no reviewer
 * is spent on a commit a machine could have refused:
 *
 *   sha_mismatch       refs/heads/<branch_id> in the task repo is tasks.commit_sha
 *   no_passing_run     a verification_runs row for (task, commit) with exit 0, not timed out
 *   base_conflict      `git merge-tree --write-tree <pr_target tip> <commit>` exits 0
 *   stale_doc_ref      no path the diff (merge-base..commit) deletes or renames, and no MCP
 *                      tool name it drops from mcp/<server>/src/tools/, appears in the
 *                      agents/, skills/, docs/ *.md, CLAUDE.md or README.md at the commit;
 *                      a removed path the commit's own .gitignore files ignore is untracked
 *                      build output, not removed (GH 2054)
 *   missing_changelog  with a changelog.d/, the diff adds a file under it
 *
 * The last two are the built-in close lints of lib/builtin-lints.ts (GH 2570).
 * Only code-reviewer spawns naming task_id=<N> are judged; a missing task_id is
 * the prompt-shape gate's. No resolvable DB or no tasks row allows, a DB read
 * failure denies. Bypass: TMB_SKIP_CODE_REVIEWER_PREFLIGHT=1.
 */
import { ALLOW, type GateResult, type Gate } from './gate.js';
import { taskLocation } from './lib/agent-context.js';
import { git, missingChangelog, missingChangelogExpected, nulFields, staleDocRefExpected, staleDocRefs } from './lib/builtin-lints.js';
import { dbPath, denyDbUnavailable, gateRead, GATE_READ_ERROR, haveSqlite, sqlInt, sqlQuote } from './lib/db.js';
import { resolveBaseRef, resolveRepoDefaultBranch } from './lib/git-refs.js';
import { structuredDenyResult, type DenyFix } from './lib/deny.js';
import { jqAlternatives } from './lib/jq.js';
import { normalizeRole } from './lib/role.js';

export const GATE_NAME = 'code-reviewer-preflight';
export const BYPASS_ENV = 'TMB_SKIP_CODE_REVIEWER_PREFLIGHT';

export type PreflightCheck = 'sha_mismatch' | 'no_passing_run' | 'base_conflict' | 'stale_doc_ref' | 'missing_changelog';

export interface PreflightFailure {
  check: PreflightCheck;
  expected: string | null;
  actual: string | null;
}

const MAX_LISTED = 10;

async function revParse(repo: string, rev: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const r = await git(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], env);
  const sha = r.stdout.trim();
  return r.code === 0 && sha !== '' ? sha : null;
}

function listed(items: readonly string[]): string {
  const shown = items.slice(0, MAX_LISTED).join('; ');
  return items.length > MAX_LISTED ? `${shown}; (+${items.length - MAX_LISTED} more)` : shown;
}

export function preflightFix(check: PreflightCheck, taskId: string): DenyFix {
  return { allowed: `task_reopen(agent='bro', task_id=${taskId}, reason='${check}: <what failed>'), then the same code-reviewer spawn once swe closes it again` };
}

function deny(failure: PreflightFailure, taskId: string): GateResult {
  return structuredDenyResult(failure, preflightFix(failure.check, taskId));
}

function dbUnavailable(env: NodeJS.ProcessEnv): GateResult {
  return { stdout: `${denyDbUnavailable(GATE_NAME, env)}\n`, code: 0 };
}

interface TaskRow {
  commitSha: string;
  parentBranch: string;
  branch: string;
}

function readTask(db: string, taskId: string, env: NodeJS.ProcessEnv): TaskRow | null | typeof GATE_READ_ERROR {
  const row = gateRead(
    db,
    `SELECT 'row|' || COALESCE(commit_sha, '') || '|' || COALESCE(parent_branch_id, '') || '|' || branch_id FROM tasks WHERE id = ${taskId};`,
    env,
  );
  if (row === GATE_READ_ERROR) return GATE_READ_ERROR;
  if (row === '') return null;
  const [, commitSha = '', parentBranch = '', ...branch] = row.split('\n')[0].split('|');
  return { commitSha, parentBranch, branch: branch.join('|') };
}

/** The ref of the task's PR target, as bro_atomic_close resolves it: repos.target_branch, parent_branch_id, the repo default. */
export async function prTargetRef(repo: string, targetBranch: string, parentBranch: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  for (const candidate of [targetBranch, parentBranch]) {
    if (candidate === '') continue;
    const ref = await resolveBaseRef(repo, candidate, env);
    if (ref) return ref;
  }
  return await resolveBaseRef(repo, await resolveRepoDefaultBranch(repo, env), env);
}

async function preflight(db: string, taskId: string, env: NodeJS.ProcessEnv): Promise<GateResult> {
  const task = readTask(db, taskId, env);
  if (task === GATE_READ_ERROR) return dbUnavailable(env);
  if (task === null) return ALLOW;
  const location = taskLocation(db, taskId, env);
  if (location.code === 2) return dbUnavailable(env);

  const recorded = task.commitSha;
  if (location.code !== 0) {
    return deny({ check: 'sha_mismatch', expected: recorded || null, actual: `branch tip unresolvable: ${location.missing}` }, taskId);
  }
  const repo = location.repoRoot;
  const branch = task.branch;
  const tip = await revParse(repo, `refs/heads/${branch}`, env);
  const commit = recorded === '' ? null : await revParse(repo, recorded, env);
  if (commit === null || tip !== commit) {
    return deny({
      check: 'sha_mismatch',
      expected: recorded === '' ? null : commit ?? recorded,
      actual: tip ?? `refs/heads/${branch} does not resolve in ${repo}`,
    }, taskId);
  }

  const shaIn = `commit_sha IN ('${sqlQuote(recorded)}', '${sqlQuote(commit)}')`;
  const runs = gateRead(
    db,
    `SELECT COUNT(*) FROM verification_runs WHERE task_id = ${taskId} AND ${shaIn} AND exit_code = 0 AND timed_out = 0;`,
    env,
  );
  if (runs === GATE_READ_ERROR) return dbUnavailable(env);
  if (Number(runs) === 0) {
    const latest = gateRead(
      db,
      `SELECT 'run ' || id || ': exit_code=' || COALESCE(exit_code, 'null') || ', timed_out=' || timed_out
         FROM verification_runs WHERE task_id = ${taskId} AND ${shaIn} ORDER BY id DESC LIMIT 1;`,
      env,
    );
    return deny({
      check: 'no_passing_run',
      expected: `a verification_runs row for task ${taskId} at ${commit} with exit_code=0 and timed_out=0`,
      actual: latest === GATE_READ_ERROR || latest === '' ? `no verification_runs row for task ${taskId} at ${commit}` : latest,
    }, taskId);
  }

  const targetRow = gateRead(
    db,
    `SELECT COALESCE(target_branch, '') FROM repos WHERE name = '${sqlQuote(location.repo)}';`,
    env,
  );
  if (targetRow === GATE_READ_ERROR) return dbUnavailable(env);
  const targetRef = await prTargetRef(repo, targetRow.split('\n')[0], task.parentBranch, env);
  const targetTip = targetRef === null ? null : await revParse(repo, targetRef, env);
  if (targetRef === null || targetTip === null) {
    return deny({
      check: 'base_conflict',
      expected: `${commit} merges cleanly into the PR target`,
      actual: `no PR target ref resolves in ${repo}`,
    }, taskId);
  }
  const merge = await git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', targetTip, commit], env);
  if (merge.code !== 0) {
    const conflicted = [...new Set(nulFields(merge.stdout).slice(1).filter((p) => p !== ''))];
    return deny({
      check: 'base_conflict',
      expected: `${commit} merges cleanly into ${targetRef} (${targetTip})`,
      actual: merge.code !== 1 || conflicted.length === 0 ? `git merge-tree exited ${merge.code}: ${merge.stderr.trim()}` : `conflicts in ${listed(conflicted)}`,
    }, taskId);
  }

  const mergeBase = (await git(repo, ['merge-base', targetTip, commit], env)).stdout.trim();
  if (mergeBase === '') {
    return deny({
      check: 'base_conflict',
      expected: `${commit} shares history with ${targetRef} (${targetTip})`,
      actual: 'no merge-base',
    }, taskId);
  }
  const stale = await staleDocRefs(repo, mergeBase, commit, env);
  if (typeof stale === 'string' || stale.length > 0) {
    return deny({
      check: 'stale_doc_ref',
      expected: staleDocRefExpected(mergeBase, commit),
      actual: typeof stale === 'string' ? stale : listed(stale),
    }, taskId);
  }

  const changelog = await missingChangelog(repo, mergeBase, commit, env);
  if (changelog !== null) {
    return deny({ check: 'missing_changelog', expected: missingChangelogExpected(mergeBase, commit), actual: changelog }, taskId);
  }
  return ALLOW;
}

export const codeReviewerPreflight: Gate = async (payload, env) => {
  if (env[BYPASS_ENV] === '1') return ALLOW;
  if (jqAlternatives(payload, [['tool_name']]) !== 'Agent') return ALLOW;
  if (normalizeRole(jqAlternatives(payload, [['tool_input', 'subagent_type']])) !== 'code-reviewer') return ALLOW;
  const m = /task_id\s*=\s*([0-9]+)/.exec(jqAlternatives(payload, [['tool_input', 'prompt']]));
  const taskId = sqlInt(m?.[1] ?? '');
  if (taskId === '') return ALLOW;
  const db = dbPath(env);
  if (db === null) return ALLOW;
  if (!haveSqlite(env)) return dbUnavailable(env);
  return await preflight(db, taskId, env);
};
