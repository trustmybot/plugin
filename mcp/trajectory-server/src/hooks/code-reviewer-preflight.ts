/**
 * PreToolUse(Agent) gate (GH 1740), run by agent-spawn-dispatch after
 * code-reviewer-after-atomic-close: before a code-reviewer spawn for task_id=<N>,
 * four deterministic checks on the task's commit, in order. The first that
 * fails denies with the JSON reason {check, expected, actual}, so no reviewer
 * is spent on a commit a machine could have refused:
 *
 *   sha_mismatch       refs/heads/<branch_id> in the task repo is tasks.commit_sha
 *   no_passing_run     a verification_runs row for (task, commit) with exit 0, not timed out
 *   no_lint_record    the task's newest finished lint_runs row for the commit exists
 *                      and exited 0
 *   stale_lint_record  that run's fingerprint is the close-lints fingerprint of the commit,
 *                      its base_sha is merge-base(<pr_target tip>, <commit>), and its
 *                      results hold a passing row for each close-lints.json lint
 *
 * The changelog and stale-doc checks run earlier, at swe's close
 * (swe-verification-gate, GH 2866), and a failing one records no verification
 * run, so no_passing_run also holds them. sha_mismatch and stale_lint_record
 * stay here because the branch tip and the PR target can move after the close.
 * A conflict with the PR target does not deny: the merge resolves it, after
 * review.
 *
 * The last two are an allowlist over swe's close-lint record (GH 2570): a record
 * the preflight cannot prove current and clean denies, a malformed
 * close-lints.json included. The lints themselves run at swe's close, not here.
 * Only code-reviewer spawns naming task_id=<N> are judged; a missing task_id is
 * the prompt-shape gate's. No resolvable DB or no tasks row allows, a DB read
 * failure denies. Bypass: TMB_SKIP_CODE_REVIEWER_PREFLIGHT=1.
 */
import { ALLOW, type GateResult, type Gate } from './gate.js';
import { taskLocation } from './lib/agent-context.js';
import { closeLintsPlan } from './lib/close-lints.js';
import { dbPath, denyDbUnavailable, gateRead, GATE_READ_ERROR, haveSqlite, sqlInt, sqlQuote } from './lib/db.js';
import { gitText, listed, revParse } from './lib/doc-checks.js';
import { prTargetRef } from './lib/git-refs.js';
import { latestLintRun } from './lib/lint-runs.js';
import { structuredDenyResult, type DenyFix } from './lib/deny.js';
import { jqAlternatives } from './lib/jq.js';
import { normalizeRole } from './lib/role.js';

export const GATE_NAME = 'code-reviewer-preflight';
export const BYPASS_ENV = 'TMB_SKIP_CODE_REVIEWER_PREFLIGHT';

export type PreflightCheck = 'sha_mismatch' | 'no_passing_run' | 'no_lint_record' | 'stale_lint_record';

export interface PreflightFailure {
  check: PreflightCheck;
  expected: string | null;
  actual: string | null;
}

export function preflightFix(check: PreflightCheck, taskId: string): DenyFix {
  if (check === 'no_lint_record' || check === 'stale_lint_record') {
    return {
      allowed: `task_reopen(agent='bro', task_id=${taskId}, reason='${check}: <what failed>'), then swe reruns the close so the verification gate records a fresh lint run for the commit, then the same code-reviewer spawn`,
    };
  }
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
  const mergeBase = targetTip === null ? '' : (await gitText(repo, ['merge-base', targetTip, commit], env)).stdout.trim();

  const lintRun = latestLintRun(db, taskId, commit, env) ?? (recorded !== commit ? latestLintRun(db, taskId, recorded, env) : null);
  if (lintRun === null || lintRun.exit_code !== 0) {
    const failing = lintRun?.results.filter((r) => r.exit_code !== 0).map((r) => `${r.name} exit_code=${r.exit_code ?? 'null'}`) ?? [];
    return deny({
      check: 'no_lint_record',
      expected: `a finished lint_runs row for task ${taskId} at ${commit} with exit_code=0`,
      actual: lintRun === null
        ? `no lint_runs row for task ${taskId} at ${commit}`
        : `run ${lintRun.run_id}: exit_code=${lintRun.exit_code ?? 'null'}${failing.length > 0 ? `; failing: ${listed(failing)}` : ''}`,
    }, taskId);
  }

  const run = `run ${lintRun.run_id}`;
  const plan = await closeLintsPlan(repo, commit, env);
  if (typeof plan === 'string') {
    return deny({ check: 'stale_lint_record', expected: `the close-lints plan of ${commit} computes`, actual: `${run}: ${plan}` }, taskId);
  }
  if (lintRun.fingerprint !== plan.fingerprint) {
    return deny({
      check: 'stale_lint_record',
      expected: `the lint run's fingerprint is the close-lints fingerprint of ${commit}`,
      actual: `${run}: fingerprint recorded ${lintRun.fingerprint}, recomputed ${plan.fingerprint}`,
    }, taskId);
  }
  if (targetRef === null || targetTip === null) {
    return deny({
      check: 'stale_lint_record',
      expected: `the lint run's base_sha is merge-base(<PR target>, ${commit})`,
      actual: `${run}: no PR target ref resolves in ${repo}`,
    }, taskId);
  }
  if (mergeBase === '') {
    return deny({
      check: 'stale_lint_record',
      expected: `the lint run's base_sha is merge-base(${targetRef}, ${commit})`,
      actual: `${run}: ${commit} shares no history with ${targetRef} (${targetTip})`,
    }, taskId);
  }
  if (lintRun.base_sha !== mergeBase) {
    return deny({
      check: 'stale_lint_record',
      expected: `the lint run's base_sha is merge-base(${targetRef}, ${commit})`,
      actual: `${run}: base_sha recorded ${lintRun.base_sha || '(empty)'}, merge-base ${mergeBase}`,
    }, taskId);
  }
  const required = (plan.config?.lints ?? []).map((l) => l.name);
  const unproven = required.filter((name) => !lintRun.results.some((r) => r.name === name && r.exit_code === 0));
  if (unproven.length > 0) {
    return deny({
      check: 'stale_lint_record',
      expected: `the lint run holds a passing result for each of ${required.join(', ')}`,
      actual: `${run}: no passing result for ${listed(unproven)}`,
    }, taskId);
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
