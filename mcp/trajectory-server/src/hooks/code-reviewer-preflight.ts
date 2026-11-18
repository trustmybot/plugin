/**
 * PreToolUse(Agent) gate (GH 1740), run by agent-spawn-dispatch after
 * code-reviewer-after-atomic-close: before a code-reviewer spawn for task_id=<N>,
 * four deterministic checks on the task's commit, in order. The first that
 * fails denies with the JSON reason {check, expected, actual}, so no reviewer
 * is spent on a commit a machine could have refused:
 *
 *   sha_mismatch       refs/heads/<branch_id> in the task repo is tasks.commit_sha
 *   no_passing_run     a verification_runs row for (task, commit) with exit 0, not timed out
 *   no_lint_record     the task's newest finished lint_runs row for the commit exists
 *                      and exited 0
 *   stale_lint_record  that run's fingerprint is the close-lints fingerprint of the commit,
 *                      its base_sha is merge-base(<pr_target tip>, <commit>) (for a
 *                      closed agile task still queued for review, an ancestor of
 *                      <commit>), and its
 *                      results hold a passing row for each lint of the set the
 *                      task's no_code_class selects from close-lints.json (GH 3160)
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
 * Only code-reviewer spawns naming task_id=<N> or batch_handoff_id=<N> are
 * judged; a missing anchor is the prompt-shape gate's. A grouped agile review
 * (batch_handoff_id, review_batch_handoff) gets batchPreflight's checks on the
 * feature-branch head and the lint run its row holds instead (no_batch_handoff,
 * sha_mismatch, no_lint_record, stale_lint_record, task_not_queued). No
 * resolvable DB or no tasks row allows, a DB read failure denies. Bypass:
 * TMB_SKIP_CODE_REVIEWER_PREFLIGHT=1.
 */
import { ALLOW, type GateResult, type Gate } from './gate.js';
import { taskLocation } from './lib/agent-context.js';
import { closeLintsPlan, taskNoCodeClass } from './lib/close-lints.js';
import { AGILE_PENDING_REVIEW_SQL, featureBranchTaskSql } from '../review-sql.js';
import { dbPath, denyDbUnavailable, gateRead, GATE_READ_ERROR, haveSqlite, realdir, repoPathAbs, sqlInt, sqlQuote } from './lib/db.js';
import { gitText, listed, revParse } from './lib/doc-checks.js';
import { gateResolveWorkflowMode, prTargetRef } from './lib/git-refs.js';
import { latestLintRun } from './lib/lint-runs.js';
import { structuredDenyResult, type DenyFix } from './lib/deny.js';
import { jqAlternatives } from './lib/jq.js';
import { normalizeRole } from './lib/role.js';

export const GATE_NAME = 'code-reviewer-preflight';
export const BYPASS_ENV = 'TMB_SKIP_CODE_REVIEWER_PREFLIGHT';

export type PreflightCheck = 'sha_mismatch' | 'no_passing_run' | 'no_lint_record' | 'stale_lint_record' | 'no_batch_handoff' | 'task_not_queued';

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
  /** Closed under agile and still queued for review at commitSha: a per-task review of it. */
  agileQueued: boolean;
  branch: string;
}

function readTask(db: string, taskId: string, env: NodeJS.ProcessEnv): TaskRow | null | typeof GATE_READ_ERROR {
  const row = gateRead(
    db,
    `SELECT 'row|' || COALESCE(t.commit_sha, '') || '|' || COALESCE(t.parent_branch_id, '') || '|' || t.status || '|' || t.branch_id
       FROM tasks t WHERE t.id = ${taskId};`,
    env,
  );
  if (row === GATE_READ_ERROR) return GATE_READ_ERROR;
  if (row === '') return null;
  const [, commitSha = '', parentBranch = '', status = '', ...branch] = row.split('\n')[0].split('|');
  // Only a closed task can be queued; an open one skips the agile read.
  const agileQueued = status === 'closed' ? gateRead(db, `SELECT ${AGILE_PENDING_REVIEW_SQL} FROM tasks t WHERE t.id = ${taskId};`, env) : '0';
  if (agileQueued === GATE_READ_ERROR) return GATE_READ_ERROR;
  return { commitSha, parentBranch, agileQueued: agileQueued.split('\n')[0] === '1', branch: branch.join('|') };
}

/**
 * Whether the lint run's base_sha still bounds the commit's diff. An open
 * task's base is merge-base(<PR target>, <commit>), so a moved target makes
 * the record stale. A queued agile task's commit is closed and frozen while
 * its feature branch moves on (feature-merge lands the commit on it), so its
 * lint run's own base only has to be an ancestor of the commit.
 */
async function lintBaseFailure(
  db: string,
  task: TaskRow,
  repo: { name: string; root: string },
  commit: string,
  lintBase: string,
  run: string,
  env: NodeJS.ProcessEnv,
): Promise<PreflightFailure | typeof GATE_READ_ERROR | null> {
  if (task.agileQueued) {
    const ancestor = lintBase !== '' && (await gitText(repo.root, ['merge-base', '--is-ancestor', lintBase, commit], env)).code === 0;
    return ancestor ? null : {
      check: 'stale_lint_record',
      expected: `the lint run's base_sha is an ancestor of the queued agile commit ${commit}`,
      actual: `${run}: base_sha recorded ${lintBase || '(empty)'}`,
    };
  }
  const targetRow = gateRead(db, `SELECT COALESCE(target_branch, '') FROM repos WHERE name = '${sqlQuote(repo.name)}';`, env);
  if (targetRow === GATE_READ_ERROR) return GATE_READ_ERROR;
  const workflowMode = gateResolveWorkflowMode(db, repo.name, env);
  if (workflowMode === GATE_READ_ERROR) return GATE_READ_ERROR;
  const targetRef = await prTargetRef(repo.root, targetRow.split('\n')[0], task.parentBranch, workflowMode, env);
  const targetTip = targetRef === null ? null : await revParse(repo.root, targetRef, env);
  if (targetRef === null || targetTip === null) {
    return {
      check: 'stale_lint_record',
      expected: `the lint run's base_sha is merge-base(<PR target>, ${commit})`,
      actual: `${run}: no PR target ref resolves in ${repo.root}`,
    };
  }
  const mergeBase = (await gitText(repo.root, ['merge-base', targetTip, commit], env)).stdout.trim();
  if (mergeBase === '') {
    return {
      check: 'stale_lint_record',
      expected: `the lint run's base_sha is merge-base(${targetRef}, ${commit})`,
      actual: `${run}: ${commit} shares no history with ${targetRef} (${targetTip})`,
    };
  }
  if (lintBase !== mergeBase) {
    return {
      check: 'stale_lint_record',
      expected: `the lint run's base_sha is merge-base(${targetRef}, ${commit})`,
      actual: `${run}: base_sha recorded ${lintBase || '(empty)'}, merge-base ${mergeBase}`,
    };
  }
  return null;
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
  const noCodeClass = taskNoCodeClass(db, taskId, env);
  if (noCodeClass === GATE_READ_ERROR) return dbUnavailable(env);
  const plan = await closeLintsPlan(repo, commit, env, noCodeClass);
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
  const baseFailure = await lintBaseFailure(db, task, { name: location.repo, root: repo }, commit, lintRun.base_sha, run, env);
  if (baseFailure === GATE_READ_ERROR) return dbUnavailable(env);
  if (baseFailure !== null) return deny(baseFailure, taskId);
  const required = plan.lints.map((l) => l.name);
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
  const prompt = jqAlternatives(payload, [['tool_input', 'prompt']]);
  const handoffId = sqlInt(/batch_handoff_id\s*=\s*([0-9]+)/.exec(prompt)?.[1] ?? '');
  const taskId = sqlInt(/task_id\s*=\s*([0-9]+)/.exec(prompt)?.[1] ?? '');
  if (handoffId === '' && taskId === '') return ALLOW;
  const db = dbPath(env);
  if (db === null) return ALLOW;
  if (!haveSqlite(env)) return dbUnavailable(env);
  if (handoffId !== '') {
    const batch = await batchPreflight(db, handoffId, env);
    if (batch !== ALLOW || taskId === '') return batch;
  }
  return await preflight(db, taskId, env);
};

/** The fix for a denied grouped-review spawn: hand the group off again as it now stands. */
export function batchPreflightFix(check: PreflightCheck, handoffId: string): DenyFix {
  return {
    allowed: `review_batch_handoff(agent='bro', feature_branch=<branch>, task_ids=<the queued group>, session_id=<id>) again (${check} on batch_handoff_id=${handoffId}), then the code-reviewer spawn with the reviewer_spawn it returns`,
  };
}

function batchDeny(failure: PreflightFailure, handoffId: string): GateResult {
  return structuredDenyResult(failure, batchPreflightFix(failure.check, handoffId));
}

interface BatchHandoffRow {
  featureBranch: string;
  headSha: string;
  repo: string;
  repoPath: string;
  lintExitCode: string;
  lintFingerprint: string;
  taskIds: string;
  commitShas: string;
}

const BATCH_FIELDS = ['$.feature_branch', '$.head_sha', '$.repo', '$.lint.exit_code', '$.lint.fingerprint', '$.task_ids', '$.commit_shas'] as const;

// Each field hex-encoded, so a '|' in a branch or path cannot shift the fields.
function readBatchHandoff(db: string, handoffId: string, env: NodeJS.ProcessEnv): BatchHandoffRow | null | typeof GATE_READ_ERROR {
  const fields = BATCH_FIELDS.map((path) => `hex(COALESCE(json_extract(a.content_json, '${path}'), ''))`);
  const repoPath = "hex(COALESCE((SELECT r.path FROM repos r WHERE r.name = json_extract(a.content_json, '$.repo')), ''))";
  const row = gateRead(
    db,
    `SELECT 'row|' || ${[...fields, repoPath].join(" || '|' || ")} FROM audit a
      WHERE a.id = ${handoffId} AND a.event_type = 'review_batch_handoff' AND a.from_node = 'bro' AND json_valid(a.content_json);`,
    env,
  );
  if (row === GATE_READ_ERROR) return GATE_READ_ERROR;
  if (row === '') return null;
  const [, ...hex] = row.split('\n')[0].split('|');
  const [featureBranch, headSha, repo, lintExitCode, lintFingerprint, taskIds, commitShas, rawPath] = hex.map((h) => Buffer.from(h, 'hex').toString('utf8'));
  const path = rawPath === '' || rawPath.startsWith('/') ? rawPath : realdir(repoPathAbs(db, rawPath));
  return { featureBranch, headSha, repo, repoPath: path.endsWith('/') ? path.slice(0, -1) : path, lintExitCode, lintFingerprint, taskIds, commitShas };
}

function jsonList(text: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stringAt(list: readonly unknown[], i: number): string {
  const v = list[i];
  return typeof v === 'string' ? v : '';
}

/**
 * A grouped agile review (batch_handoff_id=<N>): the bro review_batch_handoff
 * row exists (no_batch_handoff), the feature-branch tip is still its head_sha
 * (sha_mismatch), its close-lint run exited 0 (no_lint_record) under the
 * close-lints fingerprint of that head (stale_lint_record), and each task is
 * still closed and queued on the branch of the hand-off's repo at the commit
 * handed off (task_not_queued).
 */
async function batchPreflight(db: string, handoffId: string, env: NodeJS.ProcessEnv): Promise<GateResult> {
  const row = readBatchHandoff(db, handoffId, env);
  if (row === GATE_READ_ERROR) return dbUnavailable(env);
  if (row === null) {
    return batchDeny({ check: 'no_batch_handoff', expected: `a bro review_batch_handoff audit row with id ${handoffId}`, actual: 'no such row' }, handoffId);
  }
  const ref = `refs/heads/${row.featureBranch}`;
  const tip = row.repoPath === '' || row.featureBranch === '' ? null : await revParse(row.repoPath, ref, env);
  if (tip === null || tip !== row.headSha) {
    return batchDeny({
      check: 'sha_mismatch',
      expected: row.headSha || null,
      actual: tip ?? (row.repoPath === '' ? `repo ${JSON.stringify(row.repo)} has no repos row with a path` : `${ref} does not resolve in ${row.repoPath}`),
    }, handoffId);
  }
  if (row.lintExitCode !== '0') {
    return batchDeny({
      check: 'no_lint_record',
      expected: `review_batch_handoff ${handoffId} holds a close-lint run of ${tip} with exit_code=0`,
      actual: `lint.exit_code=${row.lintExitCode || 'null'}`,
    }, handoffId);
  }
  const plan = await closeLintsPlan(row.repoPath, tip, env, '');
  if (typeof plan === 'string') {
    return batchDeny({ check: 'stale_lint_record', expected: `the close-lints plan of ${tip} computes`, actual: plan }, handoffId);
  }
  if (row.lintFingerprint !== plan.fingerprint) {
    return batchDeny({
      check: 'stale_lint_record',
      expected: `the handed-off lint fingerprint is the close-lints fingerprint of ${tip}`,
      actual: `fingerprint recorded ${row.lintFingerprint || '(none)'}, recomputed ${plan.fingerprint}`,
    }, handoffId);
  }

  const commits = jsonList(row.commitShas);
  const pairs = jsonList(row.taskIds).map((id, i) => ({ id: sqlInt(String(id)), commit: stringAt(commits, i) }));
  if (pairs.length === 0 || pairs.some((p) => p.id === '' || p.commit === '')) {
    return batchDeny({ check: 'task_not_queued', expected: `review_batch_handoff ${handoffId} names its tasks and their commits`, actual: `task_ids ${row.taskIds}, commit_shas ${row.commitShas}` }, handoffId);
  }
  const queued = gateRead(
    db,
    `SELECT t.id FROM tasks t WHERE (${pairs.map((p) => `(t.id = ${p.id} AND t.commit_sha = '${sqlQuote(p.commit)}')`).join(' OR ')})
       AND t.status = 'closed' AND ${featureBranchTaskSql('t', `'${sqlQuote(row.featureBranch)}'`, row.repo === '' ? 'NULL' : `'${sqlQuote(row.repo)}'`)}
       AND ${AGILE_PENDING_REVIEW_SQL};`,
    env,
  );
  if (queued === GATE_READ_ERROR) return dbUnavailable(env);
  const still = new Set(queued.split('\n').filter((l) => l !== ''));
  const gone = pairs.filter((p) => !still.has(p.id)).map((p) => `${p.id}@${p.commit}`);
  if (gone.length > 0) {
    return batchDeny({
      check: 'task_not_queued',
      expected: `each task of review_batch_handoff ${handoffId} queued for review on ${row.featureBranch} at the commit handed off`,
      actual: `no longer queued: ${listed(gone)}`,
    }, handoffId);
  }
  return ALLOW;
}
