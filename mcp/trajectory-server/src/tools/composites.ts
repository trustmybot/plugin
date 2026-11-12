import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import { normalizeAgent, requireRoles } from '../middleware/agent-scope.js';
import {
  BRANCH_ID_RE,
  SPEC_BODY_MAX_BYTES,
  insertSpecShapeWaiver,
  promptBearingDerivedField,
  resolvePromptBearing,
  type PromptBearingResolution,
} from './tasks.js';
import { insertDiscussion } from './discussions.js';
import { insertAudit } from './audit.js';
import {
  claudeRunContext,
  closeOpenRunsForTask,
  markLegacyUnmeteredRuns,
  openSweRun,
  parseRunSessionId,
  RUN_SESSION_ID_SCHEMA,
  sweepRunsOfTerminalTasks,
  type RunContext,
} from './agent-runs.js';
import { outsideProject } from './containment.js';
import { closedTasksWithoutReview, liveTasksOfIssue, recordReviewBypassIfUnreviewed, sweepStaleTasks, taskHasPassingReview } from './lifecycle.js';
import {
  syncIssueCloseRemotes,
  resolveDefaultMilestone,
  milestoneDefaultFields,
  validateIssueLabels,
  defaultSyncLabels,
  inferIssueArea,
} from './issues.js';
import { defaultSpawnFn, type SpawnFn } from '../sync/issue_sync.js';
import { resolveMilestoneTargets } from './milestones.js';
import type { GraphHolder } from '../graph.js';
import { SUBPROCESS_TIMEOUT_MS, WORKTREE_TIMEOUT_MS } from '../utils/timeouts.js';
import { normalizeBase, resolveBaseRef, resolveCutBase, resolveRepoDefaultBranch, type CutBase } from '../utils/git-refs.js';
import { revParseCommit } from '../utils/git-objects.js';
import { serverLog } from '../logger.js';
import { ensureFresh, fetchTargetNow, freshnessBlock, type TargetFetchAttempt } from '../world-model/freshness.js';
import { readRepoTargetBranch, repoRowPath, repoTargetBase, resolveSoleRepo } from '../utils/repo-paths.js';
import { prepareWorktreeDeps } from '../utils/worktree-deps.js';
import { describeSetupFailure, runWorktreeSetup, type WorktreeSetupResult } from '../utils/worktree-setup.js';
import { parseBudget } from '../hooks/swe-verification-gate.js';
import {
  envGateFailedResult,
  envGateField,
  fetchBaseStage,
  runEnvGate,
  setupEnv,
  type BranchStageOutcome,
  type EnvGatePass,
  type EnvStageReport,
} from './env-gate.js';
import {
  FINDING_ORDER_SQL,
  activeFindingProbes,
  carryOpenFindings,
  clipOutputTail,
  gateCommands,
  latestVerificationRun,
  passingRunForCommit,
  verificationWaivedForCommit,
} from './verification-runs.js';
import {
  appendVerificationDefaults,
  readVerificationDefaults,
  verificationDefaultsMissingField,
  verificationDefaultsResult,
} from './verification-defaults.js';
import {
  checkVerificationPaths,
  checkVerificationProse,
  suggestVerification,
  verificationPathResult,
} from './verification-paths.js';
import type { TaskProvisionInput } from '../types.js';
import { parseStoredCheckpoint } from '../checkpoint.js';
import {
  parseSpawnNote,
  parseStoredReport,
  reportMissingIds,
  specCommitProblem,
  specCriteriaProblem,
  specCriterionIds,
  SPAWN_NOTE_MAX_CHARS,
} from '../success-criteria.js';
import { EFFORT_LEVELS, computeEffort, effortRank, isEffort, readWorkflowMode, type Effort } from './config.js';
import {
  applyReopenInTx,
  hasFailSinceLastPass,
  insertEffortRaised,
  RE_REVIEW_CHANGE,
  reReviewAdmission,
  restoreForReReviewInTx,
} from './reopen.js';
import { REWORK_FLOOR_EFFORT } from '../task-rework.js';
import { enrollEffortAb } from '../effort-ab.js';
import { assignReviewerEffort, reviewerSpawn } from '../reviewer-effort.js';
import { recordEffortInputs } from '../effort-inputs.js';
import { briefConcepts, briefLocations } from '../brief-locations.js';
import { checkoutLag } from './world_model.js';

const STDOUT_KEEP = 4096;
const STDERR_KEEP = 2048;

interface BudgetedRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/** `bash -c command` in cwd, async; past timeoutMs its whole process group is SIGKILLed. */
function runBudgeted(command: string, cwd: string, timeoutMs: number): Promise<BudgetedRun> {
  return new Promise((done) => {
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderr = Buffer.concat(errOut).toString('utf8');
      done({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: spawnError !== undefined && stderr === '' ? spawnError : stderr,
        exitCode,
        timedOut,
      });
    };
    const child = spawn('bash', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (outBytes < STDOUT_KEEP) out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errBytes < STDERR_KEEP) errOut.push(chunk);
      errBytes += chunk.length;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group already exited.
      }
      child.stdout.destroy();
      child.stderr.destroy();
    }, timeoutMs);
    child.on('error', (e) => finish(127, e.message));
    child.on('close', (code, signal) => finish(code ?? (signal !== null ? 128 + (osConstants.signals[signal] ?? 0) : 1)));
  });
}

/** The verification budget in seconds: TMB_VERIFICATION_TIMEOUT_S, else plugin_config.verification_timeout_s. */
function commandBudgetS(db: TrajectoryDB): number {
  let raw = process.env['TMB_VERIFICATION_TIMEOUT_S'] ?? '';
  if (raw === '') {
    const row = db.get<{ v: unknown }>(
      `SELECT json_extract(value_json, '$') AS v FROM plugin_config WHERE key = 'verification_timeout_s'`,
    );
    raw = row?.v == null ? '' : String(row.v);
  }
  return parseBudget(raw).timeoutS;
}

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

// Extract the unique directories implied by a task's typed `files[]` array. Each
// entry is a path; its dirname is the directory ('' = repo root). task_brief
// resolves these against the world model. (#300)
export function filesToDirs(files: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const path of files) {
    const slash = path.lastIndexOf('/');
    dirs.add(slash >= 0 ? path.slice(0, slash) : '');
  }
  return [...dirs];
}

// Parse the tasks.files JSON column into a string[] (empty on null/malformed).
export function parseTaskFiles(filesJson: string | null | undefined): string[] {
  if (!filesJson) return [];
  try {
    const parsed = JSON.parse(filesJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

// A files[] entry covers the path itself and everything beneath it (the
// CODEOWNERS / git-pathspec rule), never its siblings: `src/a/b.ts` covers
// only that file, `src/a/` or `src/a` the whole directory. Any tests/ entry
// also covers all of tests/. Same rule as src/hooks/lib/scope-fence.ts.
export function pathInFiles(path: string, files: readonly string[]): boolean {
  const entries = files.map((e) => e.replace(/\/+$/, '')).filter((e) => e.length > 0);
  if (entries.some((e) => e === 'tests' || e.startsWith('tests/'))) entries.push('tests');
  return entries.some((e) => path === e || path.startsWith(`${e}/`));
}

export function scopeSurface(path: string): string {
  const slash = path.indexOf('/');
  return slash > 0 ? path.slice(0, slash) : '<root>';
}

export function groupBySurface(paths: readonly string[]): Record<string, { count: number; paths: string[] }> {
  const groups: Record<string, { count: number; paths: string[] }> = {};
  for (const path of paths) {
    const surface = scopeSurface(path);
    const group = (groups[surface] ??= { count: 0, paths: [] });
    group.count += 1;
    group.paths.push(path);
  }
  return groups;
}

export interface ScopeCheck {
  outOfScope: string[];
  changed: string[];
  checked: boolean;
  reason?: string;
  mergeBase?: string;
  recordedBase?: string | null;
  baseMoved?: boolean;
}

function gitOut(repoPath: string, args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: SUBPROCESS_TIMEOUT_MS,
  })
    .toString()
    .trim();
}

// Close-time files[] scope gate: the task's own changes are the diff from
// its base to <commit>, returning the changed paths files[] does not cover.
// `mergeBase` = merge-base(commit, targetRef), so commits the PR target
// gained after the task branched never count. `recordedBaseRef` (the task's
// cut base) gives `recordedBase` = merge-base(commit, recordedBaseRef). The
// diff starts at recordedBase only when it strictly descends from mergeBase
// (a live stacked or local-ahead base); in every other case it starts at
// mergeBase, so a target merged into the task branch never counts (GH 3105).
// `baseMoved` is true when recordedBase is null, or differs
// from mergeBase without descending from it (the target merge-base is
// strictly newer, or the two diverged); a recordedBase strictly descending
// from mergeBase is a live stacked base, not a move. `checked:false` + a
// reason when git can't resolve the repo or commit (the caller fails CLOSED).
export function scopeCheckCommit(
  repoPath: string,
  targetRef: string,
  commitSha: string,
  files: readonly string[],
  recordedBaseRef: string | null = null,
): ScopeCheck {
  let mergeBase: string;
  try {
    mergeBase = gitOut(repoPath, ['merge-base', commitSha, targetRef]);
  } catch (e) {
    return scopeUnchecked(e);
  }

  let recordedBase: string | null = mergeBase;
  if (recordedBaseRef && recordedBaseRef !== targetRef) {
    try {
      recordedBase = gitOut(repoPath, ['merge-base', commitSha, recordedBaseRef]);
    } catch {
      recordedBase = null;
    }
  }

  const diffBase =
    recordedBase !== null && recordedBase !== mergeBase && isAncestor(repoPath, mergeBase, recordedBase) ? recordedBase : mergeBase;
  let diffOut: string;
  try {
    diffOut = gitOut(repoPath, ['diff', '--name-only', diffBase, commitSha]);
  } catch (e) {
    return scopeUnchecked(e);
  }

  const changed = diffOut
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const outOfScope = changed.filter((l) => !pathInFiles(l, files));

  const baseMoved = recordedBase === null || (recordedBase !== mergeBase && !isAncestor(repoPath, mergeBase, recordedBase));
  return { outOfScope, changed, checked: true, mergeBase, recordedBase, baseMoved };
}

function scopeUnchecked(e: unknown): ScopeCheck {
  return {
    outOfScope: [],
    changed: [],
    checked: false,
    reason: (e as Error).message.split('\n')[0] || 'git diff failed',
  };
}

// The guard briefLocations opens with: an indexed repo gets non-null locations and concepts.
function repoIndexed(db: TrajectoryDB, repo: string): boolean {
  if (!repo) return false;
  const row = db.get<{ n: number }>(
    `SELECT EXISTS (SELECT 1 FROM wm_files WHERE repo = ?) OR EXISTS (SELECT 1 FROM wm_symbols WHERE repo = ?) AS n`,
    [repo, repo],
  );
  return Number(row?.n ?? 0) !== 0;
}

// Resolve a task's repo to its on-disk path (repos.path; relative → resolved
// against the project root). Sole-repo fallback applies when the
// task has no explicit repo. Returns null when no repo can be resolved.
export function resolveRepoPath(db: TrajectoryDB, repoValue: string | null): string | null {
  const name = repoValue && repoValue.length > 0 ? repoValue : resolveSoleRepo(db)?.name ?? null;
  if (!name) return null;
  const reposRow = db.get<{ path: string }>(`SELECT path FROM repos WHERE name = ?`, [name]);
  if (!reposRow) return name;
  return repoRowPath(db, reposRow.path);
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function err(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}
function wrap(fn: Fn): Fn {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return err((e as Error).message);
    }
  };
}

// Slug → kebab-case, alphanumeric + hyphens, ≤63 chars. Reused by
// branch_id_propose. Strips diacritics and collapses repeated hyphens.
function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

// Intent text → conventional commit type prefix. Order-sensitive: the first
// matching class wins. Mirrors the table from the retired
// tmb_branch-id-proposal skill, line-by-line.
function intentToType(text: string): { prefix: string; confidence: number } {
  const lower = text.toLowerCase();
  const rules: Array<{ prefix: string; patterns: RegExp[] }> = [
    { prefix: 'fix',      patterns: [/\bfix\b/, /\bbug\b/, /\bbroken\b/, /\bcrash\b/, /\bregression\b/] },
    { prefix: 'feat',     patterns: [/\badd\b/, /\bnew\b/, /\bimplement\b/, /\bintroduce\b/] },
    { prefix: 'refactor', patterns: [/\brename\b/, /\bextract\b/, /\brestructure\b/, /\bclean[\s-]?up\b/, /\brefactor\b/] },
    { prefix: 'docs',     patterns: [/\bdocs?\b/, /\breadme\b/, /\bcomment(s|ing)?\b/] },
    { prefix: 'test',     patterns: [/\btest(s|ing)?\b/, /\bcoverage\b/] },
    { prefix: 'perf',     patterns: [/\bperf(ormance)?\b/, /\bspeed up\b/, /\boptimi[sz]e\b/, /\blatency\b/] },
    { prefix: 'build',    patterns: [/\bbuild script\b/, /\bdependency\b/, /\bdep(s|endency) bump\b/] },
    { prefix: 'ci',       patterns: [/\bci\b/, /\bpipeline\b/, /\bgithub action\b/] },
    { prefix: 'chore',    patterns: [/\bchore\b/, /\bhousekeeping\b/, /\bcleanup\b/] },
    { prefix: 'style',    patterns: [/\bformat(ting)?\b/, /\bwhitespace\b/, /\blint\b/] },
    { prefix: 'revert',   patterns: [/\brevert\b/, /\broll back\b/] },
  ];
  for (const r of rules) {
    if (r.patterns.some((p) => p.test(lower))) {
      return { prefix: r.prefix, confidence: 0.9 };
    }
  }
  return { prefix: 'chore', confidence: 0.3 };
}

// Shared write helper: inserts kind='note' + kind='intent' for a given issue.
// No-dup guard: if an intent row with the same verbatim already exists for this
// issue_id, the intent insert is skipped (second call is a no-op). The note is
// always written so the trajectory stays readable. Returns what was written.
function insertIntentAndNote(
  db: TrajectoryDB,
  issueId: number,
  intentVerbatim: string,
  noteLine: string,
  now: string,
): string[] {
  const existing = db.get<{ id: number }>(
    `SELECT id FROM discussions
      WHERE issue_id = ? AND kind = 'intent' AND body = ?
      LIMIT 1`,
    [issueId, `Human intent verbatim: "${intentVerbatim}"`],
  );
  insertDiscussion(db, { issue_id: issueId, author: 'bro', kind: 'note', body: noteLine, created_at: now });
  const written: string[] = ['note'];
  if (!existing) {
    insertDiscussion(db, {
      issue_id: issueId,
      author: 'bro',
      kind: 'intent',
      body: `Human intent verbatim: "${intentVerbatim}"`,
      created_at: now,
    });
    written.push('intent');
  }
  return written;
}

// Why close_issue_if_last_task left the issue open: live tasks hold it, or
// closed tasks (this one included) carry no passing review for their current
// commit and no recorded bypass/waiver — the manual issue_close rule.
type IssueLeftOpen =
  | { reason: 'issue_has_open_tasks'; tasks: Array<{ task_id: number; status: string }> }
  | { reason: 'tasks_without_review'; tasks: Array<{ task_id: number; commit_sha: string | null }>; review_pending: true };

// task_brief sections (GH 1743): a swe gets 'core' by default and loads the
// rest on demand; every other caller gets 'all'.
export const BRIEF_SECTIONS = ['core', 'verification', 'scope', 'history', 'all'] as const;
export type BriefSection = (typeof BRIEF_SECTIONS)[number];
const isBriefSection = (v: unknown): v is BriefSection => (BRIEF_SECTIONS as readonly unknown[]).includes(v);
export const BRIEF_RESPONSE_FORMATS = ['concise', 'detailed'] as const;
export type BriefResponseFormat = (typeof BRIEF_RESPONSE_FORMATS)[number];
const isBriefResponseFormat = (v: unknown): v is BriefResponseFormat =>
  (BRIEF_RESPONSE_FORMATS as readonly unknown[]).includes(v);
const BRIEF_RESPONSE_FORMAT_HINT =
  "Trimmed output: call task_brief again with response_format: 'detailed' for world-model summaries, full discussion rows and full check output tails.";
/** How much of each stored verification_run_commands.output_tail a concise brief carries. */
const BRIEF_OUTPUT_TAIL_CHARS = 1000;
const BRIEF_SECTION_HINTS = {
  core: 'locations {files, symbols, truncated}: the files and symbols spec_body names in backticks, with line ranges, file purpose and up to 3 callers/callees from the world model (caller_count is the full caller total, callers_truncated flags a cut list): read by range from it; concepts {items, truncated}: the L2 flows, subsystems and invariants whose steps anchor to files[] or locations, verified first, suspect/broken flagged: read before re-deriving a flow from code',
  verification: 'verification[] the close gate runs and verification_run, its latest recorded run with each command\'s output_tail: load before closing or after a gate failure',
  scope: "scope {files, extras, extras_accepted, base_moved} and scope_world_model, the world model of files[]' dirs: load to orient in unfamiliar directories",
  history: 'task_discussions, the decisions and notes behind the spec: load when the spec leaves a choice open',
};

// The close-time scope record bro_atomic_close writes into its
// bro_verification_pass row: the paths outside files[] bro accepted and
// whether the task's recorded base moved off the merge-base with the target.
export interface CloseScope {
  extras_accepted: string[];
  base_moved: boolean;
  recorded_base: string | null;
  merge_base: string | null;
}

// Shared close path for bro_atomic_close + task_recover: in the caller's
// transaction, advance a task to closed (writing bro_verification_pass,
// stamping tasks.workflow_mode from readWorkflowMode and closing the task's
// open agent_runs rows) and optionally close the parent issue
// under the issue_close rules. `bypassClosedBy` names a closer that is not
// bro_atomic_close: once this close's bro_verification_pass row is written,
// a task with no passing review for the commit gets one review_gate_bypassed
// row. Returns whether the issue was closed (so the caller can mirror the
// close to the remote after the transaction commits) and, when it was left
// open, why.
function closeTaskInTx(
  db: TrajectoryDB,
  task: { id: number; issue_id: number; branch_id: string; status: string; commit_sha: string | null },
  commitSha: string,
  verificationSummary: string,
  now: string,
  closeIssueIfLast: boolean,
  bypassClosedBy: string | null = null,
  scope: CloseScope | null = null,
): { issue_closed: boolean; issue_left_open: IssueLeftOpen | null; review_gate_bypassed: boolean } {
  // 1. bro_verification_pass audit row — the review anchor of this commit;
  // bro_atomic_close adds the close-time scope record task_brief reads.
  insertAudit(db, {
    issue_id: task.issue_id,
    branch_id: task.branch_id,
    from_node: 'bro',
    event_type: 'bro_verification_pass',
    summary: verificationSummary.slice(0, 200),
    content_json: JSON.stringify({ task_id: task.id, commit_sha: commitSha, ...(scope ? { scope } : {}) }),
    created_at: now,
  });

  // 2. review bypass for a non-atomic closer, judged against that anchor.
  let reviewGateBypassed = false;
  if (bypassClosedBy !== null) {
    reviewGateBypassed = recordReviewBypassIfUnreviewed(
      db,
      { ...task, commit_sha: commitSha },
      bypassClosedBy,
      'bro',
      now,
    );
  }

  // 3. flip task to closed, stamping the workflow mode it closed under.
  db.run(
    `UPDATE tasks
        SET status='closed', commit_sha=?, completed_at=COALESCE(completed_at, ?), updated_at=?, workflow_mode=?
      WHERE id=?`,
    [commitSha, now, now, readWorkflowMode(db), task.id],
  );

  // 4. close every open agent_runs row of the task (bro and swe).
  closeOpenRunsForTask(db, task.id, now, 'completed');

  // 5. optional issue close — the issue_close rules: never over a live task,
  // never over a closed task without a review.
  let issueClosed = false;
  let leftOpen: IssueLeftOpen | null = null;
  if (closeIssueIfLast) {
    const live = liveTasksOfIssue(db, task.issue_id);
    const unreviewed = live.length === 0 ? closedTasksWithoutReview(db, task.issue_id) : [];
    if (live.length > 0) {
      leftOpen = { reason: 'issue_has_open_tasks', tasks: live.map((t) => ({ task_id: t.id, status: t.status })) };
    } else if (unreviewed.length > 0) {
      leftOpen = {
        reason: 'tasks_without_review',
        tasks: unreviewed.map((t) => ({ task_id: t.id, commit_sha: t.commit_sha })),
        review_pending: true,
      };
    } else {
      db.run(
        `UPDATE issues SET status='closed', closed_at=COALESCE(closed_at,?), updated_at=? WHERE id=? AND status != 'closed'`,
        [now, now, task.issue_id],
      );
      issueClosed = true;
    }
  }

  return { issue_closed: issueClosed, issue_left_open: leftOpen, review_gate_bypassed: reviewGateBypassed };
}

interface ScopedTask {
  repo: string | null;
  parent_branch_id: string | null;
  files: string | null;
}

// The task's own changes (merge-base with origin/<pr_target> .. commit)
// against its typed files[], with the repo path it resolved. Unchecked, with
// a reason, when the repo or the PR target does not resolve.
function taskScopeCheck(db: TrajectoryDB, task: ScopedTask, commitSha: string): { scope: ScopeCheck; repoPath: string | null } {
  const repoPath = resolveRepoPath(db, task.repo);
  const targetCandidates = [readRepoTargetBranch(db, task.repo), task.parent_branch_id, repoPath ? resolveRepoDefaultBranch(repoPath) : null].filter(
    (b): b is string => typeof b === 'string' && b.length > 0,
  );
  let targetRef: string | null = null;
  if (repoPath) {
    for (const candidate of targetCandidates) {
      targetRef = resolveBaseRef(repoPath, candidate);
      if (targetRef) break;
    }
  }
  const recordedBaseRef = repoPath && task.parent_branch_id ? (resolveCutBase(repoPath, task.parent_branch_id)?.ref ?? task.parent_branch_id) : null;
  const scope: ScopeCheck =
    repoPath && targetRef
      ? scopeCheckCommit(repoPath, targetRef, commitSha, parseTaskFiles(task.files), recordedBaseRef)
      : {
          outOfScope: [],
          changed: [],
          checked: false,
          reason: repoPath
            ? `no PR target resolves (tried ${targetCandidates.map((b) => `'origin/${b}'`).join(', ')} and their local branches)`
            : `cannot resolve a path for repo '${task.repo ?? ''}'`,
        };
  return { scope, repoPath };
}

// The scope report review_handoff records for code-reviewer: each changed
// path outside files[] with the reason swe's completion report gave for it
// (null when it gave none). Nothing here is accepted; bro_atomic_close's
// scope gate still judges the extras.
export interface HandoffScope {
  extras: Array<{ path: string; reason: string | null }>;
  checked: boolean;
  base_moved: boolean;
  recorded_base: string | null;
  merge_base: string | null;
}

function handoffScope(scope: ScopeCheck, completionReport: string | null): HandoffScope {
  const reasons = new Map((parseStoredReport(completionReport)?.extras ?? []).map((e) => [e.path, e.reason]));
  return {
    extras: scope.outOfScope.map((path) => ({ path, reason: reasons.get(path) ?? null })),
    checked: scope.checked,
    base_moved: scope.baseMoved === true,
    recorded_base: scope.recordedBase ?? null,
    merge_base: scope.mergeBase ?? null,
  };
}

// The completion-report and verification gates a commit clears before it is
// handed to code-reviewer: an error message naming the fix, else null.
function handoffGateError(
  db: TrajectoryDB,
  task: { id: number; verification: string | null; spec_body: string | null; completion_report: string | null },
  commitSha: string,
): string | null {
  const unreported = reportMissingIds(task.completion_report, specCriterionIds(task.spec_body));
  if (unreported.length > 0) {
    return (
      `completion_report_missing: task ${task.id}'s spec carries Success Criteria ids the stored completion report ` +
      `${task.completion_report ? 'does not cover' : 'is missing for'}: ${unreported.join(', ')}. Resume the swe on ` +
      `task_id=${task.id} to call task_update_status(status='completed', commit_sha='${commitSha}', report={criteria: ` +
      `[{id, status}, ...]}) with one entry per id, then retry review_handoff.`
    );
  }

  // A task with verification[] (or a non-wontfix review finding, GH 1737)
  // hands off only on a passing recorded run of its current verification[]
  // plus finding probes for this commit, or a verification_gate_waived row
  // for it (GH 1672). The SubagentStop auto-complete and a later
  // task_update_spec both reach here without the swe gate having run that
  // verification[] on this commit.
  const verificationCommands = gateCommands(parseTaskFiles(task.verification), activeFindingProbes(db, task.id));
  if (
    verificationCommands.length > 0 &&
    passingRunForCommit(db, task.id, commitSha, verificationCommands) === null &&
    !verificationWaivedForCommit(db, task.id, commitSha)
  ) {
    return (
      `verification_run_missing: task ${task.id} has ${verificationCommands.length} gate command(s) (verification[] lines plus review finding probes) and no ` +
      `passing verification run of its current verification[] and findings recorded for commit ${commitSha} (a run made before ` +
      `verification[] was amended or a finding was recorded does not count), and no verification_gate_waived row for that commit. Get a run: ` +
      `resume the swe on task_id=${task.id} to call task_update_status(status='completed', commit_sha='${commitSha}') — ` +
      `swe-verification-gate runs verification[] in the task worktree and records the run — then retry review_handoff. ` +
      `Or waive: that call with waive_verification_gate_reason (at least 10 characters) records verification_gate_waived for the commit.`
    );
  }
  return null;
}

// cli.js integrate moves commit_sha onto a rebased SHA without re-recording
// scope, so a commit with no scope row inherits it from the commit integrate
// rebased, hop by hop, bounded like review-sql's legacy anchor chain.
const INTEGRATE_CHAIN_HOPS = 10;

function scopeRowFor<T>(db: TrajectoryDB, eventType: string, taskId: number, commitSha: string): Partial<T> | null {
  const row = db.get<{ content_json: string }>(
    `SELECT content_json FROM audit
      WHERE event_type = ? AND json_valid(content_json)
        AND json_extract(content_json, '$.task_id') = ? AND json_extract(content_json, '$.commit_sha') = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [eventType, taskId, commitSha],
  );
  return row ? ((JSON.parse(row.content_json) as { scope?: Partial<T> }).scope ?? null) : null;
}

function integratedFrom(db: TrajectoryDB, taskId: number, commitSha: string): string | null {
  const row = db.get<{ reviewed_sha: string }>(
    `SELECT json_extract(content_json, '$.reviewed_sha') AS reviewed_sha FROM audit
      WHERE event_type = 'task_integrated' AND from_node = 'hook:integrate' AND json_valid(content_json)
        AND json_extract(content_json, '$.task_id') = ? AND json_extract(content_json, '$.commit_sha') = ?
        AND json_type(content_json, '$.reviewed_sha') = 'text'
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [taskId, commitSha],
  );
  return row?.reviewed_sha ?? null;
}

// The scope record of the newest `eventType` audit row naming this task and
// its commit, else the nearest commit cli.js integrate rebased onto it.
function scopeRecordFor<T>(db: TrajectoryDB, eventType: string, taskId: number, commitSha: string | null): Partial<T> | null {
  const visited = new Set<string>();
  let sha = commitSha;
  for (let hops = 0; sha && !visited.has(sha) && hops <= INTEGRATE_CHAIN_HOPS; hops++) {
    const scope = scopeRowFor<T>(db, eventType, taskId, sha);
    if (scope) return scope;
    visited.add(sha);
    sha = integratedFrom(db, taskId, sha);
  }
  return null;
}

function outsideProjectResult(refusal: NonNullable<ReturnType<typeof outsideProject>>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(refusal) }], isError: true };
}

// The worktree a task's swe runs in: <repo>/.claude/worktrees/<slug>, slug =
// the branch_id after its type prefix (task_provision's layout).
export function taskWorktreePath(repoPath: string, branchId: string): string {
  return `${repoPath}/.claude/worktrees/${branchId.replace(/^[^/]+\//, '')}`;
}

// The worktree a task's swe works in: its recorded tasks.worktree_path (an
// adopted session worktree, GH 2032), else the task_provision slug path.
export function taskWorktreeDir(
  repoPath: string,
  task: { branch_id: string; worktree_path?: string | null },
): string {
  return task.worktree_path ? task.worktree_path : taskWorktreePath(repoPath, task.branch_id);
}

function git(repoPath: string, args: string[], timeout = SUBPROCESS_TIMEOUT_MS): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  }).toString().trim();
}

function refSha(repoPath: string, ref: string): string | null {
  try {
    return git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) || null;
  } catch {
    return null;
  }
}

function isAncestor(repoPath: string, ancestor: string, descendant: string): boolean {
  try {
    git(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

// Commits `ref` carries that `baseRef` lacks (ahead) and the reverse (behind).
function refDistance(repoPath: string, baseRef: string, ref: string): { ahead: number; behind: number } | null {
  try {
    const [behind, ahead] = git(repoPath, ['rev-list', '--left-right', '--count', `${baseRef}...${ref}`])
      .split(/\s+/)
      .map((n) => Number.parseInt(n, 10));
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
    return { ahead: ahead!, behind: behind! };
  } catch {
    return null;
  }
}

// The registered worktree that has `refs/heads/<branchId>` checked out, if any.
function worktreeOfBranch(repoPath: string, branchId: string): string | null {
  let list: string;
  try {
    list = git(repoPath, ['worktree', 'list', '--porcelain']);
  } catch {
    return null;
  }
  let current: string | null = null;
  for (const line of list.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branchId}` && current) return current;
  }
  return null;
}

// The tool-result field for a setup, absent when the repo has no setup file.
function setupField(setup: WorktreeSetupResult | undefined): { worktree_setup?: WorktreeSetupResult } {
  return setup && (setup.ran || setup.error !== undefined) ? { worktree_setup: setup } : {};
}

const PR_REVIEW_DIR_RE = /^pr-review-[0-9a-f]{7,40}-[A-Za-z0-9]{6}$/;

// <repo>/.claude/worktrees, checked both lexically and through realpath so a
// symlinked parent cannot redirect a checkout or a delete outside the repo.
function worktreesDirContained(repoPath: string, dir: string): boolean {
  if (resolve(dir) !== resolve(repoPath, '.claude', 'worktrees')) return false;
  try {
    return realpathSync(dir) === join(realpathSync(repoPath), '.claude', 'worktrees');
  } catch {
    return false;
  }
}

// True only for a per-call pr-review-<sha>-<suffix> entry directly inside
// <repo>/.claude/worktrees.
export function prReviewDirRemovable(repoPath: string, wtPath: string): boolean {
  return PR_REVIEW_DIR_RE.test(basename(wtPath)) && worktreesDirContained(repoPath, dirname(resolve(wtPath)));
}

function clearPrReviewWorktree(repoPath: string, wtPath: string): void {
  const quiet = { stdio: 'ignore' as const, timeout: WORKTREE_TIMEOUT_MS };
  try {
    execFileSync('git', ['-C', repoPath, 'worktree', 'remove', '--force', wtPath], quiet);
  } catch {
    // Best-effort: the path may not be a registered worktree.
  }
  try {
    execFileSync('git', ['-C', repoPath, 'worktree', 'prune'], quiet);
  } catch {
    // Best-effort.
  }
  if (!existsSync(wtPath) || !prReviewDirRemovable(repoPath, wtPath)) return;
  try {
    rmSync(wtPath, { recursive: true, force: true });
    execFileSync('git', ['-C', repoPath, 'worktree', 'prune'], quiet);
  } catch {
    // Best-effort.
  }
}

// Session-worktree adoption (GH 2032): task_provision, task_reopen and
// task_retry take adopt_worktree, and the worktree-adopt-guard hook admits it
// only from that linked worktree's session.
export const ADOPT_WORKTREE_ENABLED = true;

const ADOPT_HOLDING_STATUSES = ['pending', 'running', 'needs_validation'] as const;

export type AdoptTaskWorktreeError =
  | 'adopt_worktree_unavailable'
  | 'adopt_worktree_task_not_found'
  | 'adopt_worktree_repo_mismatch'
  | 'adopt_worktree_main_checkout'
  | 'adopt_worktree_dirty'
  | 'worktree_in_use';

export type AdoptTaskWorktreeResult =
  | {
      ok: true;
      task_id: number;
      branch_id: string;
      worktree_path: string;
      git_setup: 'switched' | 'error';
      diagnostic?: string;
    }
  | { ok: false; error: AdoptTaskWorktreeError; message: string; task_id?: number };

function absoluteGitPath(dir: string, flag: '--git-dir' | '--git-common-dir'): string | null {
  try {
    return realpathSync(git(dir, ['rev-parse', '--path-format=absolute', flag]));
  } catch {
    return null;
  }
}

function isRegisteredWorktree(repoPath: string, worktreePath: string): boolean {
  try {
    return git(repoPath, ['worktree', 'list', '--porcelain'])
      .split('\n')
      .some((l) => l.startsWith('worktree ') && l.slice('worktree '.length) === worktreePath);
  } catch {
    return false;
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// The live task whose effective worktree (taskWorktreeDir: its recorded path,
// else its slug path) is `realWorktree`, compared by realpath.
function worktreeHolder(
  db: TrajectoryDB,
  taskId: number,
  repoPath: string,
  realWorktree: string,
): { id: number; status: string } | null {
  const live = db.all<{ id: number; status: string; branch_id: string; worktree_path: string | null; repo: string | null }>(
    'SELECT id, status, branch_id, worktree_path, repo FROM tasks WHERE id <> ? AND status IN (SELECT value FROM json_each(?)) ORDER BY id',
    [taskId, JSON.stringify(ADOPT_HOLDING_STATUSES)],
  );
  for (const t of live) {
    const ownRepo = resolveRepoPath(db, t.repo);
    const dir = taskWorktreeDir(ownRepo?.startsWith('/') ? ownRepo : repoPath, t);
    if (canonicalPath(dir) === realWorktree) return { id: t.id, status: t.status };
  }
  return null;
}

// Records the linked worktree at `worktreePath` as the task's worktree, then
// checks the task branch out in it. Each refused check writes nothing; a
// failed `git switch` keeps the record and reports git_setup 'error' with the
// diagnostic, as task_provision does for a failed worktree add.
export function adoptTaskWorktree(
  db: TrajectoryDB,
  input: { taskId: number; repoPath: string; worktreePath: string },
  options: { enabled?: boolean } = {},
): AdoptTaskWorktreeResult {
  if (!(options.enabled ?? ADOPT_WORKTREE_ENABLED)) {
    return {
      ok: false,
      error: 'adopt_worktree_unavailable',
      message:
        'Adopting a session worktree is turned off (GH 2032, ADOPT_WORKTREE_ENABLED). ' +
        'Provision the task with task_provision, which creates <repo>/.claude/worktrees/<slug>.',
    };
  }
  const { taskId, repoPath, worktreePath } = input;
  const task = db.get<{ id: number; branch_id: string }>('SELECT id, branch_id FROM tasks WHERE id = ?', [taskId]);
  if (!task) {
    return {
      ok: false,
      error: 'adopt_worktree_task_not_found',
      message: `No task with id=${taskId}; provision the task first.`,
    };
  }
  const check = adoptWorktreeCheck(db, { taskId: task.id, repoPath, worktreePath });
  if (!check.ok) return check;
  const { realWorktree } = check;
  const refused = db.transaction(() => recordAdoptedWorktree(db, task.id, repoPath, realWorktree));
  if (refused) return refused;

  const diagnostic = switchAdoptedWorktree(realWorktree, task.branch_id);
  return {
    ok: true,
    task_id: task.id,
    branch_id: task.branch_id,
    worktree_path: realWorktree,
    git_setup: diagnostic === undefined ? 'switched' : 'error',
    ...(diagnostic !== undefined ? { diagnostic } : {}),
  };
}

type AdoptRefusal = Extract<AdoptTaskWorktreeResult, { ok: false }>;

// The four adoption checks, read-only: `worktreePath` is the top of a linked
// worktree of the repo at `repoPath` (not its main checkout), its tracked
// files are clean, and no live task other than `taskId` holds it. Returns the
// worktree's realpath, or the refusal.
export function adoptWorktreeCheck(
  db: TrajectoryDB,
  input: { taskId: number | null; repoPath: string; worktreePath: string },
): { ok: true; realWorktree: string } | AdoptRefusal {
  const { taskId, repoPath, worktreePath } = input;
  let realWorktree: string | null;
  try {
    realWorktree = realpathSync(worktreePath);
  } catch {
    realWorktree = null;
  }
  const repoCommonDir = repoPath ? absoluteGitPath(repoPath, '--git-common-dir') : null;
  const wtCommonDir = realWorktree ? absoluteGitPath(realWorktree, '--git-common-dir') : null;
  if (!realWorktree || !repoCommonDir || wtCommonDir !== repoCommonDir) {
    return {
      ok: false,
      error: 'adopt_worktree_repo_mismatch',
      message:
        `'${worktreePath}' is not a worktree of the repo at '${repoPath}' (a different --git-common-dir, or not a git ` +
        `worktree at all). Run the session from a linked worktree of that repo, or provision the task with task_provision.`,
    };
  }
  if (absoluteGitPath(realWorktree, '--git-dir') === repoCommonDir) {
    return {
      ok: false,
      error: 'adopt_worktree_main_checkout',
      message:
        `'${realWorktree}' is the repo's main checkout, not a linked worktree. A main-checkout session provisions the ` +
        `task with task_provision, which creates <repo>/.claude/worktrees/<slug>.`,
    };
  }
  if (!isRegisteredWorktree(repoPath, realWorktree)) {
    return {
      ok: false,
      error: 'adopt_worktree_repo_mismatch',
      message:
        `'${realWorktree}' is not the top of a registered linked worktree of '${repoPath}' (git worktree list). ` +
        `Pass the worktree's root directory.`,
    };
  }
  let dirty: string;
  try {
    dirty = git(realWorktree, ['status', '--porcelain', '--untracked-files=no']);
  } catch (e) {
    dirty = (e as Error).message;
  }
  if (dirty !== '') {
    return {
      ok: false,
      error: 'adopt_worktree_dirty',
      message: `'${realWorktree}' has uncommitted changes to tracked files; commit or stash them, then adopt it again.`,
    };
  }

  const holder = worktreeHolder(db, taskId ?? -1, repoPath, realWorktree);
  if (holder) return worktreeInUse(realWorktree, holder);
  return { ok: true, realWorktree };
}

function worktreeInUse(realWorktree: string, holder: { id: number; status: string }): AdoptRefusal {
  return {
    ok: false,
    error: 'worktree_in_use',
    task_id: holder.id,
    message:
      `'${realWorktree}' is already task ${holder.id}'s worktree (status '${holder.status}'). Finish or close task ` +
      `${holder.id} first, or run this task from another worktree.`,
  };
}

// Records `realWorktree` as task `taskId`'s worktree unless another live task
// holds it; runs inside the transaction that writes the task.
function recordAdoptedWorktree(db: TrajectoryDB, taskId: number, repoPath: string, realWorktree: string): AdoptRefusal | null {
  const holder = worktreeHolder(db, taskId, repoPath, realWorktree);
  if (holder) return worktreeInUse(realWorktree, holder);
  db.run('UPDATE tasks SET worktree_path = ?, worktree_adopted = 1, updated_at = ? WHERE id = ?', [
    realWorktree,
    nowISO(),
    taskId,
  ]);
  return null;
}

// Checks `branchId` out in the adopted worktree; the git error text on failure.
function switchAdoptedWorktree(realWorktree: string, branchId: string): string | undefined {
  try {
    git(realWorktree, ['switch', branchId], WORKTREE_TIMEOUT_MS);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

// Thrown inside a task-writing transaction to roll it back on a late refusal.
class AdoptRefusedError extends Error {
  constructor(readonly refusal: AdoptRefusal) {
    super(refusal.message);
  }
}

// db.transaction(fn), or the refusal an AdoptRefusedError rolled it back with.
function adoptingTransaction<T>(db: TrajectoryDB, fn: () => T): T | AdoptRefusal {
  try {
    return db.transaction(fn);
  } catch (e) {
    if (e instanceof AdoptRefusedError) return e.refusal;
    throw e;
  }
}

function isAdoptRefusal(value: unknown): value is AdoptRefusal {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}

function adoptRefusalResult(refusal: AdoptRefusal): CallToolResult {
  const { error, message, task_id } = refusal;
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error, message, ...(task_id !== undefined ? { task_id } : {}) }) }],
  };
}

// The adopt_worktree argument: undefined when omitted, else an absolute path.
function parseAdoptWorktree(value: unknown, tool: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw new Error(`${tool}: adopt_worktree must be an absolute path to the session's linked worktree.`);
  }
  return value;
}

const ADOPT_WORKTREE_SCHEMA = {
  type: 'string',
  description:
    "Absolute path of the session's linked git worktree, its top level, to adopt as the task's worktree: the task " +
    'branch is checked out there and recorded as the task worktree instead of <repo>/.claude/worktrees/<slug>. ' +
    'Refused, writing nothing, for another repo, the main checkout, tracked changes, or a worktree another live task holds.',
} as const;

type TaskBranchOutcome =
  | { kind: 'ready'; created: boolean; cutBase: CutBase | null }
  | { kind: 'base_unresolved' }
  | { kind: 'diverged'; ref: string; baseRef: string }
  | { kind: 'git_failed'; what: string; error: unknown };

function baseIsBranch(base: string, branchId: string): boolean {
  return [branchId, `origin/${branchId}`, `refs/heads/${branchId}`, `refs/remotes/origin/${branchId}`].includes(base);
}

// The task branch policy task_provision, task_retry and task_reopen share: a
// missing ref is cut from resolveCutBase(base) (created); an existing local or
// origin ref at or behind the base tip is fast-forwarded to it (reused); a
// diverged ref is refused unless reuseExisting keeps it as-is (reused).
function ensureTaskBranch(repoPath: string, branchId: string, base: string, reuseExisting = false): TaskBranchOutcome {
  const localRef = `refs/heads/${branchId}`;
  const originRef = `refs/remotes/origin/${branchId}`;
  const localSha = refSha(repoPath, localRef);
  const originSha = refSha(repoPath, originRef);
  const branchExists = localSha !== null || originSha !== null;

  const cutBase = resolveCutBase(repoPath, base);
  const baseRef = cutBase?.ref ?? null;
  if (!baseRef && !(branchExists && reuseExisting)) return { kind: 'base_unresolved' };

  if (!branchExists) {
    try {
      git(repoPath, ['branch', branchId, baseRef!]);
    } catch (error) {
      return { kind: 'git_failed', what: `failed to create branch '${branchId}' from '${baseRef}'`, error };
    }
    return { kind: 'ready', created: true, cutBase };
  }

  const diverged = baseRef
    ? [localSha ? localRef : null, originSha ? originRef : null]
        .filter((r): r is string => r !== null)
        .find((r) => !isAncestor(repoPath, r, baseRef))
    : undefined;
  if (diverged && !reuseExisting) return { kind: 'diverged', ref: diverged, baseRef: baseRef! };
  try {
    if (diverged || !baseRef) {
      if (!localSha) git(repoPath, ['branch', branchId, originRef]);
    } else if (!localSha) {
      git(repoPath, ['branch', branchId, baseRef]);
    } else if (localSha !== refSha(repoPath, baseRef)) {
      const checkedOutAt = worktreeOfBranch(repoPath, branchId);
      if (checkedOutAt) git(checkedOutAt, ['merge', '--ff-only', '--quiet', baseRef]);
      else git(repoPath, ['branch', '-f', branchId, baseRef]);
    }
  } catch (error) {
    return { kind: 'git_failed', what: `failed to fast-forward existing branch '${branchId}' to '${baseRef ?? base}'`, error };
  }
  return { kind: 'ready', created: false, cutBase };
}

// The base a retry or rework branch is cut from: the task's parent branch when
// it resolves, else the repo's target branch, else its default branch.
function reworkBase(db: TrajectoryDB, repoPath: string, repoValue: string | null, parentBranch: string | null): string {
  if (parentBranch && resolveCutBase(repoPath, parentBranch)) return parentBranch;
  return readRepoTargetBranch(db, repoValue) ?? resolveRepoDefaultBranch(repoPath);
}

// The ref a reworked task's verification defaults are read at: the cut ref of
// its rework base, the same ref task_retry reads them at.
function reworkDefaultsRef(db: TrajectoryDB, repoPath: string | null, task: { repo: string | null; parent_branch_id: string | null }): string | null {
  if (!repoPath) return null;
  return resolveCutBase(repoPath, normalizeBase(repoPath, reworkBase(db, repoPath, task.repo, task.parent_branch_id)))?.ref ?? null;
}

function existingBranchRef(repoPath: string, branchId: string): string | null {
  for (const ref of [`refs/heads/${branchId}`, `refs/remotes/origin/${branchId}`]) {
    if (refSha(repoPath, ref)) return ref;
  }
  return null;
}

// The ref a reopened or amended task's verification[] test paths are checked
// at: the task branch tip, else the base a missing branch is recut from.
function taskTipRef(
  db: TrajectoryDB,
  repoPath: string,
  task: { branch_id: string; repo: string | null; parent_branch_id: string | null },
): string | null {
  return (
    existingBranchRef(repoPath, task.branch_id) ??
    resolveCutBase(repoPath, reworkBase(db, repoPath, task.repo, task.parent_branch_id))?.ref ??
    null
  );
}

function suggestionRepo(db: TrajectoryDB, repo: string | null): string | null {
  return repo && repo.length > 0 ? repo : resolveSoleRepo(db)?.name ?? null;
}

function isGitRepo(repoPath: string): boolean {
  try {
    git(repoPath, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

function branchDivergedPayload(
  tool: string,
  branchId: string,
  ref: string,
  baseRef: string,
  distance: { ahead: number; behind: number } | null,
  openPrs: OpenChangeRequest[],
  remedy: string,
): Record<string, unknown> {
  const prNote = openPrs.length > 0 ? ` Open PR/MR: ${openPrs.map((p) => p.url || `#${p.number}`).join(', ')}.` : '';
  return {
    error: 'branch_exists_diverged',
    branch_id: branchId,
    ref,
    base: baseRef,
    ahead: distance?.ahead ?? null,
    behind: distance?.behind ?? null,
    open_prs: openPrs,
    message:
      `${tool}: branch '${branchId}' already exists and '${ref}' has diverged from '${baseRef}' ` +
      `(${distance ? `${distance.ahead} ahead, ${distance.behind} behind` : 'distance unknown'}).${prNote} ` +
      `${remedy} No task row was created.`,
  };
}

// The ungated (adopted worktree) path's refusal for a failed branch stage.
function branchRefusalResult(tool: string, refusal: { detail: string; payload?: Record<string, unknown> }, nothingWritten: string): CallToolResult {
  if (refusal.payload) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(refusal.payload) }] };
  return err(`${tool}: ${refusal.detail} ${nothingWritten}`);
}

// The environment gate's branch stage over ensureTaskBranch's outcome; a
// diverged branch keeps its branch_exists_diverged payload.
function taskBranchStage(
  branch: TaskBranchOutcome,
  base: string,
  repoLabel: string,
  divergedPayload?: (ref: string, baseRef: string) => Record<string, unknown>,
): BranchStageOutcome {
  switch (branch.kind) {
    case 'ready':
      return { ok: true, created: branch.created, baseRef: branch.cutBase?.ref ?? null };
    case 'base_unresolved':
      return { ok: false, detail: `base does not resolve as 'origin/${base}' or local '${base}' in repo '${repoLabel}'.` };
    case 'git_failed':
      return { ok: false, detail: `${branch.what} in repo '${repoLabel}' (${(branch.error as Error).message.split('\n')[0] || 'git failed'}).` };
    case 'diverged':
      return {
        ok: false,
        detail: `'${branch.ref}' has diverged from '${branch.baseRef}'.`,
        ...(divergedPayload ? { payload: divergedPayload(branch.ref, branch.baseRef) } : {}),
      };
  }
}

// task_reopen's branch stage: an existing local branch is kept as-is, an
// origin-only one is checked out locally, and a missing one is cut from the
// rework base. baseRef is the rework base's cut ref either way.
function reopenBranchStage(repoPath: string, branchId: string, base: string, repoLabel: string): BranchStageOutcome {
  const baseRef = resolveCutBase(repoPath, base)?.ref ?? null;
  if (refSha(repoPath, `refs/heads/${branchId}`)) return { ok: true, created: false, baseRef };
  const originRef = `refs/remotes/origin/${branchId}`;
  if (refSha(repoPath, originRef)) {
    try {
      git(repoPath, ['branch', branchId, originRef]);
    } catch (e) {
      return { ok: false, detail: `failed to create branch '${branchId}' from '${originRef}' (${(e as Error).message.split('\n')[0] || 'git failed'}).` };
    }
    return { ok: true, created: true, baseRef };
  }
  return taskBranchStage(ensureTaskBranch(repoPath, branchId, base), base, repoLabel);
}

// Runs a gated tool's DB transaction; a throw removes what the gate created.
function gatedTransaction<T>(db: TrajectoryDB, gate: EnvGatePass | null, fn: () => T): T | AdoptRefusal {
  try {
    const result = adoptingTransaction(db, fn);
    if (isAdoptRefusal(result)) gate?.rollback();
    return result;
  } catch (e) {
    gate?.rollback();
    throw e;
  }
}

// Refuses a branch_id the issue already has a task on, before any git call, so
// idx_tasks_issue_branch never surfaces as a raw UNIQUE error after a ref moved.
function branchIdUsedOnIssueResult(
  db: TrajectoryDB,
  tool: 'task_provision' | 'task_retry',
  issueId: number,
  branchId: string,
): CallToolResult | null {
  const existing = db.get<{ id: number; status: string; commit_sha: string | null }>(
    `SELECT id, status, commit_sha FROM tasks WHERE issue_id = ? AND branch_id = ? LIMIT 1`,
    [issueId, branchId],
  );
  if (!existing) return null;
  const nextStep =
    tool === 'task_provision'
      ? `Call task_reopen(task_id=${existing.id}) to continue the same work, or, for a separately gated task, ` +
        `pick a new name with branch_id_propose, or call task_provision with base='${branchId}' to stack on it.`
      : `Pick a fresh new_branch_id from branch_id_propose.`;
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: 'branch_id_used_on_issue',
          issue_id: issueId,
          branch_id: branchId,
          task_id: existing.id,
          status: existing.status,
          commit_sha: existing.commit_sha ?? null,
          message:
            `${tool}: issue ${issueId} already has task ${existing.id} (status '${existing.status}') on branch ` +
            `'${branchId}'. ${nextStep} No task row or branch was changed.`,
        }),
      },
    ],
  };
}

type OpenChangeRequest = { backend: 'gh' | 'glab'; number: number; url: string };

// Open PRs/MRs whose head is `branchId`, read under the issue-sync gate
// (plugin_config.issue_sync / TMB_DISABLE_REMOTE_SYNC). Read-only; any remote
// failure yields no entry.
function openChangeRequestsForBranch(
  db: TrajectoryDB,
  repoName: string | null,
  repoPath: string,
  branchId: string,
  spawnFn: SpawnFn | undefined,
): OpenChangeRequest[] {
  if (!repoName) return [];
  const { gated, targets } = resolveMilestoneTargets(db, repoName, spawnFn);
  if (!gated) return [];
  const spawn = spawnFn ?? defaultSpawnFn;
  const found: OpenChangeRequest[] = [];
  for (const target of targets) {
    const args =
      target.backend === 'gh'
        ? ['pr', 'list', '--head', branchId, '--state', 'open', '--json', 'number,url', '--repo', target.slug]
        : ['mr', 'list', '--source-branch', branchId, '--output', 'json', '-R', target.slug];
    try {
      const res = spawn(target.backend, args, { cwd: repoPath, timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' });
      if (res.status !== 0) continue;
      const rows = JSON.parse(res.stdout || '[]') as Array<Record<string, unknown>>;
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const number = Number(row['number'] ?? row['iid']);
        const url = String(row['url'] ?? row['web_url'] ?? '');
        if (Number.isFinite(number)) found.push({ backend: target.backend, number, url });
      }
    } catch {
      continue;
    }
  }
  return found;
}

function validateFenceAdditions(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of strings.`);
  for (const el of value) {
    if (typeof el !== 'string' || el.trim().length === 0) {
      throw new Error(`${field} entries must each be a non-empty string.`);
    }
  }
  return value as string[];
}

function appendUnique(existing: readonly string[], additions: readonly string[]): string[] {
  const out = [...existing];
  for (const a of additions) if (!out.includes(a)) out.push(a);
  return out;
}

const WONTFIX_REASON_MIN_CHARS = 10;

interface WontfixEntry {
  finding_id: string;
  reason: string;
}

/**
 * task_reopen's wontfix[]: each entry names an open review finding of the task
 * once, with a reason of at least WONTFIX_REASON_MIN_CHARS characters. Any bad
 * entry refuses the whole list.
 */
function parseWontfix(db: TrajectoryDB, taskId: number, value: unknown): WontfixEntry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('wontfix must be an array of {finding_id, reason}.');
  const seen = new Set<string>();
  return value.map((item, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`wontfix[${i}] must be an object {finding_id, reason}.`);
    }
    const { finding_id: findingId, reason } = item as Record<string, unknown>;
    if (typeof findingId !== 'string' || findingId.trim() === '') {
      throw new Error(`wontfix[${i}].finding_id must be a non-empty string.`);
    }
    if (typeof reason !== 'string' || reason.trim().length < WONTFIX_REASON_MIN_CHARS) {
      throw new Error(`wontfix[${i}].reason must be at least ${WONTFIX_REASON_MIN_CHARS} characters: why the Human accepts finding ${findingId}.`);
    }
    if (seen.has(findingId)) throw new Error(`wontfix names finding ${findingId} more than once.`);
    seen.add(findingId);
    const finding = db.get<{ task_id: number; status: string }>(
      'SELECT task_id, status FROM review_findings WHERE id = ?',
      [findingId],
    );
    if (!finding || finding.task_id !== taskId) {
      throw new Error(`wontfix[${i}]: finding ${findingId} is not a review finding of task ${taskId}.`);
    }
    if (finding.status !== 'open') {
      throw new Error(`wontfix[${i}]: finding ${findingId} is '${finding.status}'; only an open finding can be marked wontfix.`);
    }
    return { finding_id: findingId, reason: reason.trim() };
  });
}

const REOPENABLE_STATUSES = new Set(['pending', 'completed', 'closed', 'failed', 'escalated', 'running']);
const SPEC_AMENDABLE_STATUSES = new Set(['pending', 'running', 'needs_validation', 'completed']);
// A running task also hands off, through reReviewAdmission, to re-review a FAILed commit.
const HANDOFF_STATUSES = new Set(['completed', 'needs_validation']);
const verificationPathsDoc = (ref: string) =>
  `verification[] test files must exist at ${ref} or be in files[] (else verification_path_missing); adds suggested_verification.`;

export function compositeTools(
  db: TrajectoryDB,
  dbPath: string,
  graphHolder: GraphHolder | null = null,
  runContext: RunContext = claudeRunContext(db, dbPath),
): { definitions: Tool[]; handlers: Record<string, Fn> } {
  const definitions: Tool[] = [
    {
      name: 'branch_id_propose',
      description:
        'Derives a branch_id from intent + objective by heuristic, returning { branch_id, confidence }; writes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          intent: {
            type: 'string',
            description: 'Free-text user intent — verb-led ("fix the auth crash", "add export feature").',
          },
          objective: {
            type: 'string',
            description: 'Optional shorter slug seed; if omitted, intent is used.',
          },
        },
        required: ['agent', 'intent'],
      },
    },
    {
      name: 'task_retry',
      description:
        "Retry a failed task in one transaction: appends the rationale, creates a new task inheriting issue_id, parent_branch_id and repo, " +
        "its branch and worktree cut by task_provision's environment gate. Copies the failed task's open review findings onto it as F<new_task_id>-<n>. " +
        `${verificationPathsDoc('the base')} ` +
        'Returns {task_id, branch_id, effort, carried_findings: [{from, id}], git_setup, base_ref, base_sha, wm_commit, env_gate, worktree_path, worktree_adopted?, diagnostic?}.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          failed_task_id: { type: 'string' },
          new_branch_id: {
            type: 'string',
            description:
              "Branch_id for the retry (must be different from the failed task's branch_id; same conventional format).",
          },
          corrected_spec_body: { type: 'string', description: `The new spec_body — ≤${SPEC_BODY_MAX_BYTES} chars (override via TMB_SPEC_BODY_MAX_BYTES).` },
          retry_rationale: {
            type: 'string',
            description: "≤200 chars — the root cause and corrected approach. Persisted as discussion(kind='decision').",
          },
          repo: {
            type: 'string',
            description:
              'Optional repo override — replaces the repo inherited from the failed task. ' +
              'Must not contain ".." or start with "/". Omit to inherit.',
          },
          title: { type: 'string' },
          description: { type: 'string' },
          effort: {
            type: 'string',
            enum: [...EFFORT_LEVELS],
            description: "Optional effort for the retry task (e.g. 'high'); omit to run the retry at high (rework).",
          },
          adopt_worktree: ADOPT_WORKTREE_SCHEMA,
          session_id: RUN_SESSION_ID_SCHEMA,
        },
        required: [
          'agent',
          'failed_task_id',
          'new_branch_id',
          'corrected_spec_body',
          'retry_rationale',
          'description',
        ],
      },
    },
    {
      name: 'intent_start',
      description:
        'Atomically runs issue_create + discussion_append(intent) + discussion_append(note) + audit_append(branch_id_proposed). ' +
        'Creates no git branch. Returns {issue_id, branch_id}.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          objective: { type: 'string', description: 'Short one-liner issue objective.' },
          intent_verbatim: { type: 'string', description: 'Human intent verbatim — stored as kind=intent discussion.' },
          branch_id: { type: 'string', description: 'Confirmed branch_id (from branch_id_propose + Human confirm).' },
          repo: { type: 'string', description: 'Optional repo name (matches a repos row) this issue belongs to. Defaults to the sole/managed repo when exactly one repos row exists. Mirrors issue_create.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Optional. When supplied, must include at least one priority label AND at least one classification label, drawn from the project\'s configured taxonomy (plugin_config issue_priority_labels / issue_classification_labels) or the generic default (priority: Priority: Urgent|High|Medium|Low; classification: Bug, Feature, Improvement, Docs, Test, Chore), plus exactly one area label when the project configures issue_area_labels (inferred from issue_area_paths when omitted). Extra labels are allowed. When omitted, defaults to the first classification + first priority label of the taxonomy. Persisted on the issue row.' },
        },
        required: ['agent', 'objective', 'intent_verbatim', 'branch_id'],
      },
    },
    {
      name: 'bro_verification_fail_record',
      description:
        'Atomically writes the audit_append + discussion_append bro records when a verification check fails.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          task_id: { type: 'string', description: 'Task ID under verification.' },
          which_check: {
            type: 'string',
            description: 'Which V1/V2/V3 check failed (e.g. "V2 — tests", "V3 — success criteria").',
          },
          details: {
            type: 'string',
            description: '≤500 chars — root cause and specifics of the failure.',
          },
        },
        required: ['agent', 'task_id', 'which_check', 'details'],
      },
    },
    {
      name: 'pr_monitor_worktree',
      description:
        'Runs command in <repo_path>/.claude/worktrees/pr-review-<sha>-<suffix> (node_modules linked; frozen install per changed installed lockfile root) after .config/tmb/worktree-setup.json (failed step: named error, no command) under budget (TMB_VERIFICATION_TIMEOUT_S ?? verification_timeout_s ?? 900, max 1800 s; over: passed:false, timed_out:true) and removes it. Outside project: outside_project.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          commit_sha: { type: 'string', description: '7–40 hex SHA to check out.' },
          repo_path: {
            type: 'string',
            description: 'Absolute path to a git repo under the project root.',
          },
          command: {
            type: 'string',
            description: 'Shell command to run inside the worktree. Must be non-empty.',
          },
        },
        required: ['agent', 'commit_sha', 'repo_path', 'command'],
      },
    },
    {
      name: 'worktree_commits_fetch',
      description:
        "Fetches each task's worktree HEAD into the main checkout under branch_id, returning { task_id, branch_id, commit_sha }[] for the code-reviewer spawn.",
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          task_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Task IDs whose commits need to be reaped from worktrees.',
          },
          repo_path: {
            type: 'string',
            description: 'Absolute path to the main git checkout (where worktrees/ lives).',
          },
        },
        required: ['agent', 'task_ids', 'repo_path'],
      },
    },
    {
      name: 'review_handoff',
      description:
        "Hands a completed or needs_validation task's current commit to code-reviewer, status unchanged; a running task's FAILed commit after a re_review analysis, as completed. " +
        "Writes review_handoff (the review anchor with the scope report: extras with swe's reasons, base_moved, merge_base), reviewer_effort_assigned and spawn_note. " +
        'Returns review_pending=true, reviewer_effort and, with session_id, reviewer_spawn, the whole Agent call. ' +
        'Refuses without a completion report covering every SC<n>: id (completion_report_missing), or, for a task with verification[] or a non-wontfix finding, without a passing verification run of those commands plus one `[probe <id>]` per finding for the commit or a verification_gate_waived row (verification_run_missing).',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          task_id: { type: 'string' },
          spawn_note: {
            type: 'string',
            description: `Optional context for code-reviewer beyond task_brief, at most ${SPAWN_NOTE_MAX_CHARS} chars; task_brief returns it. Overwrites any earlier note.`,
          },
          session_id: {
            ...RUN_SESSION_ID_SCHEMA,
            description:
              "Optional: your host session id. With it the result carries reviewer_spawn {prompt, effort, subagent_type} to pass as is; without it, reviewer_spawn_unavailable: 'session_id'.",
          },
        },
        required: ['agent', 'task_id'],
      },
    },
    {
      name: 'bro_atomic_close',
      description:
        "Bro's task close after code-reviewer passed: writes bro_verification_pass, closes the task and, when asked, the issue, in one transaction. " +
        "Refuses with review_pass_missing until a passing verdict follows the task's review_handoff for its commit_sha, which must name the task's current commit. " +
        'An issue left open reports issue_left_open {reason: issue_has_open_tasks | tasks_without_review, tasks}; it closes on merge or via issue_close. ' +
        'The scope gate refuses changed paths outside files[] (grouped by surface) unless waive_scope_gate, the result carrying base_moved (with recorded_base, merge_base). ' +
        'PostToolUse hooks fire on bro_atomic_close, not task_update_status.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          task_id: { type: 'string' },
          commit_sha: { type: 'string' },
          verification_summary: {
            type: 'string',
            description: "Free-text — lands in the bro_verification_pass audit row.",
          },
          close_issue_if_last_task: {
            type: 'boolean',
            description:
              'When true and no task of the issue is live (pending/running/needs_validation/completed) or closed without a passing review, ' +
              'also close the issue in the same transaction; otherwise the issue stays open and issue_left_open says why.',
          },
          waive_scope_gate: {
            type: 'boolean',
            description:
              "When true, accept the task's changed paths outside its typed files[] (the close-time scope gate " +
              'diffs merge-base(commit, origin/<pr_target>)..commit against files[]) and close; requires ' +
              'scope_waiver_reason. The scope_gate_waived audit row records accepted_paths, reason, base_moved, ' +
              'recorded_base, merge_base. Also closes when the repo/commit cannot be resolved. Default false ' +
              '(gate enforced, fail-closed).',
          },
          scope_waiver_reason: {
            type: 'string',
            description: 'Required with waive_scope_gate (at least 10 characters): why bro accepts the extra paths.',
          },
        },
        required: ['agent', 'task_id', 'commit_sha', 'verification_summary'],
      },
    },
    {
      name: 'task_recover',
      description:
        'Recover a swe task stuck pending/completed after its executor died: with commit_sha it closes the task (review_gate_bypassed when no code-reviewer verdict passes), else it returns a re-dispatch directive; other statuses are a no-op. ' +
        'Every call also sweeps: running tasks with no open swe run and updated_at older than TMB_STALE_RUNNING_HOURS (default 6) fail (task_stale_swept, runs closed swept_stale); pending ones over 7 days old are reported; runs open on terminal tasks close; closed swe/code-reviewer runs with no tokens or usage_source get usage_source=unmeasured. ' +
        'Returns {tasks_swept, runs_swept, runs_marked_unmeasured, reported} plus the recovery result.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          task_id: { type: 'string', description: 'Optional. Omit to run only the stale sweep.' },
          commit_sha: {
            type: 'string',
            description: 'Optional 7..40-char hex SHA of the recovered work. Required to advance to closed.',
          },
          verification_summary: {
            type: 'string',
            description: "Free-text — lands in the bro_verification_pass audit row on recovery.",
          },
          close_issue_if_last_task: {
            type: 'boolean',
            description:
              'When true, also close the issue in the same transaction under the issue_close rules (no live task, ' +
              'no closed task without a passing review or recorded bypass); otherwise issue_left_open says why.',
          },
        },
        required: ['agent'],
      },
    },
    {
      name: 'task_provision',
      description:
        'Sets up one task for swe. First syncs the world model to origin/<target>. Before the DB commit an environment gate runs fetch, branch, worktree, setup and reindex; a failed stage returns env_gate_failed and writes nothing. ' +
        "A new branch is cut from local <base> when it is a fast-forward ahead of origin/<base>, else from origin/<base> (git_setup 'created'); an existing ref at or behind the base tip is fast-forwarded ('reused'); a diverged one is refused with branch_exists_diverged (ref, ahead/behind, open PRs) unless reuse_existing. " +
        "Writes a kind='decision' discussion and the task in one transaction. " +
        `${verificationPathsDoc('the base')} ` +
        'Returns {task_id, branch_id, repo, slug, effort, effort_reason, effort_inputs, worktree_path, git_setup, worktree_reused, worktree_adopted?, base_ref, base_sha, wm_commit, env_gate, base_diverged?, diagnostic?}.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          issue_id: { type: 'number', description: 'Issue the decision + task belong to.' },
          branch_id: { type: 'string', description: 'Git-convention branch_id (feat/foo); doubles as the working branch + worktree slug source.' },
          decision_body: {
            type: 'string',
            description: "Bro's chosen approach (what, why, trade-offs) — stored as a kind='decision' discussion to satisfy the decision gate.",
          },
          base: {
            type: 'string',
            description: "Optional start-point for the branch ref; 'dev' and 'origin/dev' are both accepted. Defaults to the repo's target_branch, else its default branch (origin/HEAD).",
          },
          reuse_existing: {
            type: 'boolean',
            description: 'Keep an existing branch_id that has diverged from base as-is instead of refusing with branch_exists_diverged.',
          },
          adopt_worktree: ADOPT_WORKTREE_SCHEMA,
          session_id: RUN_SESSION_ID_SCHEMA,
          waive_registry_gate: {
            type: 'boolean',
            description:
              "Bypass the world-model-cold gate (needs a deep_scan_completed audit). Only when /scan can't run.",
          },
          waive_registry_gate_reason: {
            type: 'string',
            description:
              'Required when waive_registry_gate is true (min 10 chars): why the gate is unnecessary.',
          },
          waive_spec_shape: {
            type: 'boolean',
            description:
              'Record a spec_shape_gate_waived row for the task, which opens the require-task-spec spawn gate (Writer:/Populated: lines) for it.',
          },
          waive_spec_shape_reason: {
            type: 'string',
            description:
              'Required when waive_spec_shape is true (min 10 chars): why the spec needs no Writer:/Populated: lines.',
          },
          task: {
            type: 'object',
            description: 'The single task spec.',
            properties: {
              title: { type: 'string' },
              description: { type: 'string', description: 'Required, non-empty.' },
              spec_body: {
                type: 'string',
                description: `Required, non-empty. Full markdown body SWE reads; max ${SPEC_BODY_MAX_BYTES} chars. Must contain a ## Success Criteria H2 whose top-level bullets each start with a unique id: \`- SC1: ...\`.`,
              },
              files: {
                type: 'array',
                items: { type: 'string' },
                description: "The task's expected scope at directory granularity; writes outside it are noted to the swe and judged at bro_atomic_close.",
              },
              verification: {
                type: 'array',
                items: { type: 'string' },
                description: 'Authoritative shell commands the swe-verification-gate hook runs before SWE may complete.',
              },
              repo: {
                type: 'string',
                description: "Registered repo name (from repos_list); defaults to the issue's repo, else the sole repo.",
              },
              prompt_bearing: {
                type: 'number',
                description: 'Set to 1 when this task intentionally edits prompt-surface files. Default: 1 when files[] holds a prompt-surface path, else 0.',
              },
              effort: {
                type: 'string',
                enum: [...EFFORT_LEVELS],
                description: 'Reasoning effort swe runs this task at; every swe spawn must pass the same effort. Omitted → computed: default from plugin_config.swe_default_effort (medium when unset); high for prompt-bearing tasks, files[] touching plugin_config.high_effort_paths, and rework.',
              },
            },
            required: ['description', 'spec_body', 'files', 'verification'],
          },
        },
        required: ['agent', 'issue_id', 'branch_id', 'decision_body', 'task'],
      },
    },
    {
      name: 'task_reopen',
      description:
        "Rework a task: moves a pending, completed, closed, failed, escalated or running task to running, appends files_add / verification_add, clears the completion_report, overwrites spawn_note (NULL when none is passed), writes a kind='decision' discussion + task_reopened audit row, after task_provision's environment gate. Refused when the task's issue is closed. " +
        `${verificationPathsDoc('the branch tip')} ` +
        'Returns {task_id, from_status, status, files, verification, effort, wontfixed, worktree_path, worktree_recreated, worktree_adopted?, branch_created, base_sha, wm_commit, env_gate, diagnostic?}; spawn swe on the task next.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          task_id: { type: 'number', description: 'Task to reopen.' },
          reason: { type: 'string', description: 'Why the task is reopened (e.g. the review finding); stored on the decision discussion and the audit row.' },
          files_add: {
            type: 'array',
            items: { type: 'string' },
            description: 'Paths appended to the task files[] fence (duplicates ignored).',
          },
          verification_add: {
            type: 'array',
            items: { type: 'string' },
            description: 'Commands appended to the task verification[] list (duplicates ignored).',
          },
          effort: {
            type: 'string',
            enum: [...EFFORT_LEVELS],
            description: "Optional new effort for the rework (e.g. 'high'); omit to run the rework at high.",
          },
          spawn_note: {
            type: 'string',
            description: `Optional context for the rework swe beyond what task_brief carries, at most ${SPAWN_NOTE_MAX_CHARS} chars; task_brief returns it as spawn_note.`,
          },
          adopt_worktree: ADOPT_WORKTREE_SCHEMA,
          wontfix: {
            type: 'array',
            description: `Open findings of this task the Human accepts: each set to wontfix (no longer probed), with a review_finding_wontfix audit row. Reason ≥${WONTFIX_REASON_MIN_CHARS} chars; any bad entry refuses the call.`,
            items: {
              type: 'object',
              properties: { finding_id: { type: 'string' }, reason: { type: 'string' } },
              required: ['finding_id', 'reason'],
              additionalProperties: false,
            },
          },
          session_id: RUN_SESSION_ID_SCHEMA,
        },
        required: ['agent', 'task_id', 'reason'],
      },
    },
    {
      name: 'task_update_spec',
      description:
        "Amend a pending, running, needs_validation or completed task: replaces files[], verification[] and/or spec_body (at least one), writes a kind='decision' discussion + task_spec_amended audit row (old→new summary); the scope and verification gates read the new values next run. " +
        `${verificationPathsDoc('the branch tip')} ` +
        'Returns {task_id, changed, files, verification}.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          task_id: { type: 'number', description: 'Task to amend.' },
          reason: { type: 'string', description: 'Why the spec changes; stored on the decision discussion and the audit row.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Replacement files[] fence (non-empty).' },
          verification: { type: 'array', items: { type: 'string' }, description: 'Replacement verification[] commands (non-empty).' },
          spec_body: {
            type: 'string',
            description: `Replacement spec_body; max ${SPEC_BODY_MAX_BYTES} chars, must contain a ## Success Criteria H2 whose top-level bullets each start with a unique SC<n>: id.`,
          },
        },
        required: ['agent', 'task_id', 'reason'],
      },
    },
    {
      name: 'task_brief',
      description:
        "swe's only context read for one task: task row, spec_body, task_discussions (this task's decision/intent rows, the issue's newest issue-level decision and intent, its last few other rows), the world model of the dirs files[] touches, " +
        "scope {files, extras, extras_accepted, base_moved} from the review handoff and close of the current commit, verification_run (the gate's latest run, each command with output_tail), open_findings (open blocking findings whose probes the gate re-runs), completion_report, spawn_note, " +
        'checkpoint (swe\'s handback to resume from) and last_stop (cause budget or hook_block of the newest stopped swe run); each null when absent. ' +
        "`section`: 'core' (task row, spec_body, files, open_findings, completion_report, spawn_note, checkpoint, last_stop, locations, concepts, freshness, a `sections` map), 'verification' (verification[], verification_run), 'scope' (scope, scope_world_model), 'history' (task_discussions) or 'all'. " +
        'locations resolves the paths and identifiers spec_body names in backticks in the symbol index, with line ranges, callers and callees (caller_count the full total, callers_hint when cut); a name outside those paths and files[] resolves only to exported non-test symbols; unresolved_paths lists paths the index lacks; at most 6000 chars, null without a world model. ' +
        'A swe call opens its swe agent_runs row when none is open. response_format_hint flags a concise trim.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          task_id: { type: 'number', description: 'Task id to assemble the brief for.' },
          section: {
            type: 'string',
            enum: [...BRIEF_SECTIONS],
            description: "Part of the brief to return. Default 'core' for swe, 'all' for every other caller.",
          },
          response_format: {
            type: 'string',
            enum: [...BRIEF_RESPONSE_FORMATS],
            description: "'concise' (default) trims world-model summaries, other discussion rows and output_tail (last 1000 chars); 'detailed' returns them in full.",
          },
        },
        required: ['agent', 'task_id'],
      },
    },
  ];

  // A spawn brings the repo's world model to the base tip the worktree is cut
  // from before it returns, waiting for another holder of the repo's lock
  // (GH 2584). A failure leaves the index as it was.
  const spawnReindex = async (repo: string | null, repoPath: string, baseRef: string | null | undefined): Promise<void> => {
    const graph = graphHolder?.ensureGraph() ?? null;
    const target = baseRef ? revParseCommit(repoPath, baseRef) : null;
    if (!graph || !repo || !target) return;
    try {
      await ensureFresh(db, graph, repo, { dbPath, trigger: 'spawn', target, targetRef: baseRef, wait: true });
    } catch (e) {
      serverLog({ event: 'wm_spawn_reindex_error', repo, error: (e as Error).message });
    }
  };

  // task_provision plans against origin/<target branch> as just fetched
  // (GH 2958): a fetch that ignores the read window, then the index brought to
  // that tip, waiting for another holder of the repo's lock. A failed fetch
  // leaves the provision on the current index.
  const provisionReindex = async (repo: string, agent: string): Promise<TargetFetchAttempt> => {
    const fetched = await fetchTargetNow(db, repo, { agent });
    const graph = graphHolder?.ensureGraph() ?? null;
    if (graph) {
      try {
        await ensureFresh(db, graph, repo, { dbPath, trigger: fetched.result === 'moved' ? 'fetch' : 'spawn', wait: true });
      } catch (e) {
        serverLog({ event: 'wm_provision_reindex_error', repo, error: (e as Error).message });
      }
    }
    return fetched;
  };

  const handlers: Record<string, Fn> = {
    task_provision: requireRoles(
      'task_provision',
      ['bro'],
      wrap(async (args) => {
        const agent = (args['agent'] as string | undefined) ?? 'bro';
        const issueId = args['issue_id'];
        const branchId = args['branch_id'] as string;
        const decisionBody = args['decision_body'] as string;
        const task = args['task'] as TaskProvisionInput | undefined;
        parseRunSessionId(args['session_id']);
        const adoptPath = parseAdoptWorktree(args['adopt_worktree'], 'task_provision');

        if (typeof issueId !== 'number' || !Number.isFinite(issueId)) {
          return err('issue_id must be a number');
        }
        if (issueId === -1) {
          return err('system_issue_reserved: issue -1 is the system issue and carries audit rows only; provision the task under a real issue.');
        }
        if (!branchId || typeof branchId !== 'string') {
          return err('branch_id must be a non-empty string');
        }
        if (!BRANCH_ID_RE.test(branchId)) {
          return err(`branch_id "${branchId}" does not match the conventional format <type>/<slug>.`);
        }
        if (!decisionBody || decisionBody.trim().length === 0) {
          return err('decision_body must be a non-empty string');
        }
        if (!task || typeof task !== 'object') {
          return err('task must be an object');
        }
        if (!task.description || task.description.trim().length === 0) {
          return err('task.description must be a non-empty string');
        }
        if (!task.spec_body || typeof task.spec_body !== 'string') {
          return err('task.spec_body must be a non-empty string');
        }
        if (task.spec_body.length > SPEC_BODY_MAX_BYTES) {
          return err(
            `task.spec_body exceeds ${SPEC_BODY_MAX_BYTES} char limit (actual: ${task.spec_body.length}). ` +
              `Cite existing code/conventions rather than restating them. Override via TMB_SPEC_BODY_MAX_BYTES.`,
          );
        }
        const criteriaProblem = specCriteriaProblem(task.spec_body);
        if (criteriaProblem) return err(criteriaProblem);
        const commitProblem = specCommitProblem(task.spec_body);
        if (commitProblem) return err(commitProblem);
        const validateStrArray = (value: unknown, field: 'files' | 'verification'): string[] => {
          if (!Array.isArray(value) || value.length === 0) {
            throw new Error(`task.${field} must be a non-empty array of strings.`);
          }
          for (const el of value) {
            if (typeof el !== 'string' || el.trim().length === 0) {
              throw new Error(`task.${field} entries must each be a non-empty string.`);
            }
          }
          return value as string[];
        };
        const files = validateStrArray(task.files, 'files');
        const givenVerification = validateStrArray(task.verification, 'verification');

        let repoValue: string | null = null;
        const hasTaskRepo = task.repo !== undefined && task.repo !== null && task.repo !== '';
        if (hasTaskRepo && typeof task.repo !== 'string') return err('task.repo must be a string');
        const namedRepo = hasTaskRepo
          ? (task.repo as string)
          : db.get<{ repo: string | null }>(`SELECT repo FROM issues WHERE id = ?`, [issueId])?.repo || null;
        if (namedRepo) {
          if (namedRepo.includes('..')) return err(`Invalid repo "${namedRepo}": must not contain "..".`);
          if (namedRepo.startsWith('/')) return err(`Invalid repo "${namedRepo}": must not start with "/".`);
          repoValue = namedRepo;
        } else {
          repoValue = resolveSoleRepo(db)?.name ?? null;
        }

        const promptBearingResolution = resolvePromptBearing(task.prompt_bearing, files);
        const promptBearing = promptBearingResolution.prompt_bearing;

        if (task.effort !== undefined && task.effort !== null && !isEffort(task.effort)) {
          return err(
            `typed_field_violation: task.effort must be one of ${EFFORT_LEVELS.join(', ')}, got ${JSON.stringify(task.effort)}.`,
          );
        }
        const computedEffort = computeEffort(db, {
          effort: task.effort,
          prompt_bearing: promptBearing,
          files,
        });
        const { effort } = computedEffort;

        const slug = branchId.replace(/^[^/]+\//, '');

        const specShapeWaived = args['waive_spec_shape'] === true;
        const specShapeWaiverReason = (args['waive_spec_shape_reason'] ?? '') as string;
        if (specShapeWaived && (typeof specShapeWaiverReason !== 'string' || specShapeWaiverReason.trim().length < 10)) {
          return err('waive_spec_shape_reason must be a string ≥10 chars.');
        }

        // --- World-model-cold registry gate (MCP-level enforcement) ---
        // /scan must have run at least once before bro can provision a task, so
        // planning reasons from a populated world model rather than an empty
        // `directories` table. Mirrors the task_create_batch contract (any
        // deep_scan_completed audit row clears it; waivable). Placed before any
        // git side effect so a gated call persists nothing.
        const registryGateWaived = args['waive_registry_gate'] === true;
        const registryGateWaiverReason = (args['waive_registry_gate_reason'] ?? '') as string;

        if (registryGateWaived) {
          if (
            typeof registryGateWaiverReason !== 'string' ||
            registryGateWaiverReason.trim().length < 10
          ) {
            return err('waive_registry_gate_reason must be a string ≥10 chars.');
          }
        } else {
          const scanRow = db.get<{ c: number }>(
            `SELECT COUNT(*) as c FROM audit WHERE event_type = 'deep_scan_completed'`,
          );
          if ((scanRow?.c ?? 0) === 0) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: 'registry_cold_violation',
                    message:
                      `task_provision: world-model-cold gate — no deep_scan_completed audit row exists. ` +
                      `Run /scan (or call scan_run directly) to discover repos and populate the world model. ` +
                      `For exceptional cases, pass waive_registry_gate=true with waive_registry_gate_reason="<why>".`,
                  }),
                },
              ],
            };
          }
        }

        const usedOnIssue = branchIdUsedOnIssueResult(db, 'task_provision', issueId, branchId);
        if (usedOnIssue) return usedOnIssue;

        // --- GIT SETUP BEFORE THE COMMIT (atomic guarantee) ---
        // Resolve the repo path + base ref and create the branch ref BEFORE
        // writing the task row. A git failure here returns an error and
        // persists NOTHING, so the same (issue_id, branch_id) retries cleanly
        // — no orphan task row left occupying the UNIQUE constraint. The
        // environment gate builds the worktree before the commit too; only an
        // adopted worktree is switched after it.
        let repoPath: string | null = null;
        if (repoValue) {
          const reposRow = db.get<{ path: string }>(
            `SELECT path FROM repos WHERE name = ?`,
            [repoValue],
          );
          if (reposRow) {
            repoPath = repoRowPath(db, reposRow.path);
          } else {
            // #1027: tasks.repo is a FK to repos(name) ON DELETE RESTRICT.
            // Reject an unregistered repo here, before any git branch/worktree
            // side effect, so we never leave an orphan branch behind a task row
            // whose INSERT would then FK-fail.
            return err(
              `task_provision: repo '${repoValue}' is not registered (no repos row). ` +
                `Run /scan or pass a registered task.repo — tasks.repo is a foreign key to repos(name). ` +
                `No task row or branch was created.`,
            );
          }
        }
        if (!repoPath) {
          return err(
            `task_provision: cannot resolve a repo path for git setup (task.repo='${repoValue ?? ''}'); ` +
              `pass task.repo or register a single repo. No task row was created — retry once the repo resolves.`,
          );
        }
        for (const path of [repoPath, adoptPath ?? taskWorktreePath(repoPath, branchId)]) {
          const refusal = outsideProject('task_provision', runContext.projectRoot, path);
          if (refusal) return outsideProjectResult(refusal);
        }
        let adoptedWorktree: string | null = null;
        if (adoptPath !== undefined) {
          const check = adoptWorktreeCheck(db, { taskId: null, repoPath, worktreePath: adoptPath });
          if (!check.ok) return adoptRefusalResult(check);
          adoptedWorktree = check.realWorktree;
        }

        const targetFetch = repoValue ? await provisionReindex(repoValue, agent) : null;
        const base = repoTargetBase(db, repoPath, repoValue, args['base'] as string | undefined);
        if (baseIsBranch(base, branchId)) {
          return err(
            `task_provision: base '${base}' is the task's own branch_id '${branchId}', so the base-branch guard ` +
              `would block every commit on it. Pass a different base, e.g. the PR target. ` +
              `No branch, worktree or task row was created.`,
          );
        }

        // Branch policy (ensureTaskBranch): a new ref is created from the base
        // ('created'); an existing ref at or behind the base tip is reused; a
        // diverged ref is refused unless reuse_existing keeps it as-is. Cut from
        // local <base> when it is a fast-forward ahead of origin/<base>, else
        // origin/<base> (a diverged base is reported as base_diverged); error
        // when neither resolves — before anything is created.
        // The environment gate (runEnvGate) fetches origin/<base> first, so
        // the verification defaults below are read at the fetched tip. An
        // adopted worktree keeps the ungated path.
        const reuseExisting = args['reuse_existing'] === true;
        const nothingWritten = 'No task row was created — retry with the same branch_id once the cause is fixed.';
        let fetched: EnvStageReport | null = null;
        if (adoptedWorktree === null) {
          const fetch = fetchBaseStage(repoPath, base);
          if (!fetch.ok) return envGateFailedResult('task_provision', fetch, nothingWritten);
          fetched = fetch.report;
        }
        const pathRef =
          resolveCutBase(repoPath, base)?.ref ?? (reuseExisting ? existingBranchRef(repoPath, branchId) : null);
        const defaults = readVerificationDefaults(repoPath, pathRef);
        if ('error' in defaults) return verificationDefaultsResult('task_provision', pathRef, defaults.error);
        const { verification, added: verificationDefaultsAdded } = appendVerificationDefaults(givenVerification, defaults.commands);
        const pathRefusal = pathRef
          ? checkVerificationPaths({ repoPath, ref: pathRef, verification, files })
          : checkVerificationProse(verification, pathRef);
        if (pathRefusal) return verificationPathResult('task_provision', pathRefusal);
        const cut: { base?: CutBase | null } = {};
        const branchStage = (): BranchStageOutcome => {
          const branch = ensureTaskBranch(repoPath, branchId, base, reuseExisting);
          if (branch.kind === 'ready') cut.base = branch.cutBase;
          return taskBranchStage(branch, base, repoValue ?? '', (ref, baseRef) =>
            branchDivergedPayload(
              'task_provision',
              branchId,
              ref,
              baseRef,
              refDistance(repoPath, baseRef, ref),
              openChangeRequestsForBranch(db, repoValue, repoPath, branchId, args['_spawnFn'] as SpawnFn | undefined),
              'Pick a fresh branch_id (branch_id_propose), or pass reuse_existing: true to keep the existing branch as-is.',
            ),
          );
        };
        let gate: EnvGatePass | null = null;
        let branchCreated: boolean;
        if (fetched) {
          const passed = await runEnvGate({
            db,
            dbPath,
            graph: graphHolder?.ensureGraph() ?? null,
            repo: repoValue,
            repoPath,
            branchId,
            worktreePath: taskWorktreePath(repoPath, branchId),
            fetched,
            ensureBranch: branchStage,
          });
          if (!passed.ok) return envGateFailedResult('task_provision', passed, nothingWritten);
          gate = passed;
          branchCreated = passed.branchCreated;
        } else {
          const stage = branchStage();
          if (!stage.ok) return branchRefusalResult('task_provision', stage, nothingWritten);
          branchCreated = stage.created;
        }
        const cutBase = cut.base ?? null;
        const resolvedBaseRef = cutBase?.ref ?? null;

        // --- DB TRANSACTION (atomic) ---
        // The branch ref now exists. Write the decision (satisfies the decision
        // gate) + create the single task via the same INSERT path
        // task_create_batch uses, with the planning_complete audit. The
        // registry gate is enforced above; the intent/scope/branch/spec gates
        // are waived internally: this composite IS bro's atomic planning, so
        // those preconditions are subsumed here.
        // Any DB error rolls back the whole transaction.
        const now = nowISO();
        const gitRepoPath = repoPath;
        const result = gatedTransaction(db, gate, () => {
          db.run(
            `INSERT INTO tasks
               (issue_id, branch_id, parent_branch_id, title, description,
                status, spec_body, repo, prompt_bearing, files, verification, effort, base_sha, wm_commit, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              issueId,
              branchId,
              base,
              task.title ?? '',
              task.description,
              task.spec_body,
              repoValue,
              promptBearing,
              JSON.stringify(files),
              JSON.stringify(verification),
              effort,
              gate?.base_sha ?? null,
              gate?.wm_commit ?? null,
              now,
              now,
            ],
          );
          const row = db.get<{ id: number; branch_id: string; repo: string | null }>(
            'SELECT id, branch_id, repo FROM tasks WHERE rowid = last_insert_rowid()',
          );
          if (!row) throw new Error('task_provision: task insert succeeded but row lookup failed');
          if (adoptedWorktree !== null) {
            const refused = recordAdoptedWorktree(db, row.id, gitRepoPath, adoptedWorktree);
            if (refused) throw new AdoptRefusedError(refused);
          }
          const assigned = enrollEffortAb(db, computedEffort, {
            id: row.id, issue_id: issueId, branch_id: branchId, from_node: agent, created_at: now,
          });
          const effortInputs = recordEffortInputs(db, { id: row.id, from_node: agent });

          insertDiscussion(db, {
            issue_id: issueId,
            author: agent,
            kind: 'decision',
            body: gate?.decisionNote ? `${decisionBody}\n\n${gate.decisionNote}` : decisionBody,
            created_at: now,
            task_id: row.id,
          });

          insertAudit(db, {
            issue_id: issueId,
            branch_id: branchId,
            from_node: agent,
            event_type: 'planning_complete',
            summary: `Planning complete for issue ${issueId}: 1 task created on ${branchId}.`,
            content_json: JSON.stringify({ issue_id: issueId, task_count: 1, task_branch_ids: [branchId] }),
            created_at: now,
          });

          if (registryGateWaived) {
            insertAudit(db, {
              issue_id: issueId,
              branch_id: branchId,
              from_node: agent,
              event_type: 'registry_gate_waived',
              summary: registryGateWaiverReason.slice(0, 200),
              content_json: JSON.stringify({ waive_registry_gate_reason: registryGateWaiverReason, tasks_created: 1 }),
              created_at: now,
            });
          }

          if (targetFetch?.result === 'failed') {
            insertAudit(db, {
              issue_id: issueId,
              branch_id: branchId,
              from_node: agent,
              event_type: 'wm_provision_fetch_failed',
              summary: `task_provision could not fetch origin/${targetFetch.branch ?? '?'} of ${repoValue}; planned on the current world-model index.`,
              content_json: JSON.stringify({ repo: repoValue, branch: targetFetch.branch, error: targetFetch.error }),
              created_at: now,
            });
          }

          if (specShapeWaived) {
            insertSpecShapeWaiver(db, { issue_id: issueId, branch_id: branchId, task_id: row.id }, specShapeWaiverReason, 'task_provision', now);
          }

          return { task_id: row.id, effort: assigned.effort, effort_reason: assigned.reason, effort_inputs: effortInputs };
        });
        if (isAdoptRefusal(result)) return adoptRefusalResult(result);

        // An adopted worktree is switched to the branch after the commit,
        // fail-soft into git_setup:'error' + a diagnostic.
        let gitSetup: 'created' | 'reused' | 'error' = branchCreated ? 'created' : 'reused';
        let diagnostic: string | undefined;
        const worktreePath = adoptedWorktree ?? taskWorktreePath(repoPath, branchId);
        if (adoptedWorktree !== null) {
          diagnostic = switchAdoptedWorktree(adoptedWorktree, branchId);
          if (diagnostic !== undefined) gitSetup = 'error';
          await spawnReindex(repoValue, repoPath, resolvedBaseRef);
        }

        return ok({
          task_id: result.task_id,
          branch_id: branchId,
          repo: repoValue,
          slug,
          effort: result.effort,
          effort_reason: result.effort_reason,
          effort_inputs: result.effort_inputs,
          ...promptBearingDerivedField(promptBearingResolution),
          worktree_path: worktreePath,
          git_setup: gitSetup,
          worktree_reused: gate?.worktreeReused ?? false,
          ...setupField(gate?.setup),
          ...(adoptedWorktree !== null ? { worktree_adopted: true } : {}),
          ...(resolvedBaseRef ? { base_ref: resolvedBaseRef } : {}),
          ...(gate ? { base_sha: gate.base_sha, wm_commit: gate.wm_commit, ...envGateField(gate.stages) } : {}),
          ...(cutBase?.diverged
            ? {
                base_diverged: {
                  ...cutBase.diverged,
                  message:
                    `Local '${base}' and 'origin/${base}' have diverged (local ${cutBase.diverged.ahead} ahead, ` +
                    `${cutBase.diverged.behind} behind); the branch was cut from 'origin/${base}'.`,
                },
              }
            : {}),
          ...(diagnostic ? { diagnostic } : {}),
          verification_defaults_added: verificationDefaultsAdded,
          ...verificationDefaultsMissingField(repoPath, pathRef, defaults),
          ...suggestVerification(db, repoValue, repoPath, files, verification),
        });
      }),
    ),

    task_reopen: requireRoles(
      'task_reopen',
      ['bro'],
      wrap(async (args) => {
        const agent = (args['agent'] as string | undefined) ?? 'bro';
        const taskId = Number(args['task_id']);
        const reason = args['reason'];
        if (!Number.isInteger(taskId)) return err('task_id must be a number');
        if (typeof reason !== 'string' || reason.trim().length === 0) {
          return err('reason must be a non-empty string');
        }
        parseRunSessionId(args['session_id']);
        const filesAdd = validateFenceAdditions(args['files_add'], 'files_add');
        const verificationAdd = validateFenceAdditions(args['verification_add'], 'verification_add');
        const effortArg = args['effort'];
        if (effortArg !== undefined && !isEffort(effortArg)) {
          return err(`typed_field_violation: effort must be one of ${EFFORT_LEVELS.join(', ')}, got ${JSON.stringify(effortArg)}.`);
        }
        const spawnNote = parseSpawnNote(args['spawn_note'], 'task_reopen');
        const adoptPath = parseAdoptWorktree(args['adopt_worktree'], 'task_reopen');

        const task = db.get<{
          id: number;
          issue_id: number;
          branch_id: string;
          parent_branch_id: string | null;
          status: string;
          files: string | null;
          verification: string | null;
          repo: string | null;
          effort: Effort;
          prompt_bearing: number;
          worktree_path: string | null;
          issue_status: string;
        }>(
          `SELECT t.id, t.issue_id, t.branch_id, t.parent_branch_id, t.status, t.files, t.verification, t.repo, t.effort,
                  t.prompt_bearing, t.worktree_path, i.status AS issue_status
             FROM tasks t JOIN issues i ON i.id = t.issue_id WHERE t.id = ?`,
          [taskId],
        );
        if (!task) return err(`task_reopen: task ${taskId} not found`);
        if (!REOPENABLE_STATUSES.has(task.status)) {
          return err(
            `task_reopen: task ${taskId} is '${task.status}'; task_reopen moves pending, completed, closed, failed, escalated or running tasks. ` +
              `Amend a live task's spec with task_update_spec.`,
          );
        }
        if (task.issue_status === 'closed') {
          return err(`task_reopen: issue ${task.issue_id} is closed; track the rework under an open issue.`);
        }
        if (isEffort(effortArg) && effortRank(effortArg) < effortRank(REWORK_FLOOR_EFFORT) && hasFailSinceLastPass(db, taskId)) {
          return err(
            `effort_below_rework_floor: task ${taskId} has a review FAIL since its last passing review, so its rework runs at effort "${REWORK_FLOOR_EFFORT}"; ` +
              `call task_reopen(task_id=${taskId}, reason, effort='${REWORK_FLOOR_EFFORT}') or omit effort. Task ${taskId} is unchanged ('${task.status}'); no row was written.`,
          );
        }
        const wontfix = parseWontfix(db, taskId, args['wontfix']);

        const repoPath = resolveRepoPath(db, task.repo);
        if (repoPath) {
          for (const path of [repoPath, adoptPath ?? taskWorktreeDir(repoPath, task)]) {
            const refusal = outsideProject('task_reopen', runContext.projectRoot, path);
            if (refusal) return outsideProjectResult(refusal);
          }
        }
        let adoptedWorktree: string | null = null;
        if (adoptPath !== undefined) {
          const check = adoptWorktreeCheck(db, { taskId: task.id, repoPath: repoPath ?? '', worktreePath: adoptPath });
          if (!check.ok) return adoptRefusalResult(check);
          adoptedWorktree = check.realWorktree;
        }

        // The environment gate runs for a git repo without adopt_worktree; its
        // fetch comes first so the defaults below are read at the fetched tip.
        const gatedRepo = repoPath !== null && adoptedWorktree === null && isGitRepo(repoPath) ? repoPath : null;
        const nothingWritten = `Task ${taskId} is unchanged ('${task.status}'); no row was written.`;
        const gatedBase = gatedRepo ? normalizeBase(gatedRepo, reworkBase(db, gatedRepo, task.repo, task.parent_branch_id)) : null;
        let fetched: EnvStageReport | null = null;
        if (gatedRepo && gatedBase) {
          const fetch = fetchBaseStage(gatedRepo, gatedBase);
          if (!fetch.ok) return envGateFailedResult('task_reopen', fetch, nothingWritten);
          fetched = fetch.report;
        }
        const defaultsRef = reworkDefaultsRef(db, repoPath, task);
        const defaults = readVerificationDefaults(repoPath, defaultsRef);
        if ('error' in defaults) return verificationDefaultsResult('task_reopen', defaultsRef, defaults.error);
        const files = appendUnique(parseTaskFiles(task.files), filesAdd);
        const { verification, added: verificationDefaultsAdded } = appendVerificationDefaults(
          appendUnique(parseTaskFiles(task.verification), verificationAdd),
          defaults.commands,
        );
        const pathRefusal = checkVerificationPaths({
          repoPath,
          ref: repoPath ? taskTipRef(db, repoPath, task) : null,
          verification,
          files,
        });
        if (pathRefusal) return verificationPathResult('task_reopen', pathRefusal);
        const promptBearingResolution = resolvePromptBearing(task.prompt_bearing, files);
        const { effort } = computeEffort(db, {
          effort: effortArg,
          prompt_bearing: promptBearingResolution.prompt_bearing,
          files,
          rework: true,
          current: task.effort,
        });
        let gate: EnvGatePass | null = null;
        if (gatedRepo && gatedBase && fetched) {
          const repoName = suggestionRepo(db, task.repo);
          const passed = await runEnvGate({
            db,
            dbPath,
            graph: graphHolder?.ensureGraph() ?? null,
            repo: repoName,
            repoPath: gatedRepo,
            branchId: task.branch_id,
            worktreePath: taskWorktreeDir(gatedRepo, task),
            fetched,
            ensureBranch: () => reopenBranchStage(gatedRepo, task.branch_id, gatedBase, repoName ?? ''),
          });
          if (!passed.ok) return envGateFailedResult('task_reopen', passed, nothingWritten);
          gate = passed;
        }
        const now = nowISO();
        const refused = gatedTransaction(db, gate, () => {
          if (adoptedWorktree !== null && repoPath) {
            const late = recordAdoptedWorktree(db, task.id, repoPath, adoptedWorktree);
            if (late) throw new AdoptRefusedError(late);
          }
          applyReopenInTx(db, {
            task,
            agent,
            reason,
            effort,
            spawnNote,
            now,
            fence: { files, verification },
            envGate: gate,
            decisionLines: [
              filesAdd.length > 0 ? `files[] += ${filesAdd.join(', ')}` : null,
              verificationAdd.length > 0 ? `verification[] += ${verificationAdd.join(' ; ')}` : null,
              verificationDefaultsAdded.length > 0 ? `verification[] += repo defaults ${verificationDefaultsAdded.join(' ; ')}` : null,
            ].filter((l): l is string => l !== null),
            auditContent: { files_add: filesAdd, verification_add: verificationAdd },
          });
          if (promptBearingResolution.derived) {
            db.run(`UPDATE tasks SET prompt_bearing = 1 WHERE id = ?`, [taskId]);
          }
          for (const w of wontfix) {
            db.run(
              `UPDATE review_findings SET status = 'wontfix', resolved_at = ? WHERE id = ? AND task_id = ? AND status = 'open'`,
              [now, w.finding_id, taskId],
            );
            insertAudit(db, {
              issue_id: task.issue_id,
              branch_id: task.branch_id,
              from_node: agent,
              event_type: 'review_finding_wontfix',
              summary: `Finding ${w.finding_id} of task ${taskId} marked wontfix: ${w.reason}`.slice(0, 200),
              content_json: JSON.stringify({ task_id: taskId, finding_id: w.finding_id, reason: w.reason }),
              created_at: now,
            });
          }
        });
        if (isAdoptRefusal(refused)) return adoptRefusalResult(refused);

        let worktreePath: string | null = null;
        let worktreeRecreated = false;
        let branchCreated = false;
        let diagnostic: string | undefined;
        if (gate && gatedRepo) {
          worktreePath = taskWorktreeDir(gatedRepo, task);
          worktreeRecreated = !gate.worktreeReused;
          branchCreated = gate.branchCreated;
        } else if (repoPath && adoptedWorktree !== null) {
          worktreePath = adoptedWorktree;
          try {
            if (!refSha(repoPath, `refs/heads/${task.branch_id}`)) {
              if (refSha(repoPath, `refs/remotes/origin/${task.branch_id}`)) {
                git(repoPath, ['branch', task.branch_id, `refs/remotes/origin/${task.branch_id}`]);
              } else {
                const base = reworkBase(db, repoPath, task.repo, task.parent_branch_id);
                const branch = ensureTaskBranch(repoPath, task.branch_id, base);
                if (branch.kind === 'base_unresolved') {
                  throw new Error(`branch '${task.branch_id}' is missing and base '${base}' resolves neither as 'origin/${base}' nor locally`);
                }
                if (branch.kind === 'git_failed') throw new Error(`${branch.what}: ${(branch.error as Error).message.split('\n')[0]}`);
                branchCreated = branch.kind === 'ready' && branch.created;
              }
            }
            diagnostic = switchAdoptedWorktree(adoptedWorktree, task.branch_id);
          } catch (e) {
            diagnostic = (e as Error).message;
          }
          await spawnReindex(task.repo, repoPath, resolveCutBase(repoPath, reworkBase(db, repoPath, task.repo, task.parent_branch_id))?.ref);
        } else if (repoPath) {
          worktreePath = taskWorktreeDir(repoPath, task);
          diagnostic = `repo path '${repoPath}' is not a git repository; worktree not checked`;
        } else {
          diagnostic = `cannot resolve a repo path for task.repo='${task.repo ?? ''}'; worktree not checked`;
        }

        return ok({
          task_id: taskId,
          from_status: task.status,
          status: 'running',
          files,
          verification,
          effort,
          ...promptBearingDerivedField(promptBearingResolution),
          wontfixed: wontfix.map((w) => w.finding_id),
          worktree_path: worktreePath,
          worktree_recreated: worktreeRecreated,
          ...setupField(gate?.setup),
          ...(adoptedWorktree !== null ? { worktree_adopted: true } : {}),
          branch_created: branchCreated,
          ...(gate ? { base_sha: gate.base_sha, wm_commit: gate.wm_commit, ...envGateField(gate.stages) } : {}),
          ...(diagnostic ? { diagnostic } : {}),
          verification_defaults_added: verificationDefaultsAdded,
          ...suggestVerification(db, suggestionRepo(db, task.repo), repoPath, files, verification),
        });
      }),
    ),

    task_update_spec: requireRoles(
      'task_update_spec',
      ['bro'],
      wrap(async (args) => {
        const agent = (args['agent'] as string | undefined) ?? 'bro';
        const taskId = Number(args['task_id']);
        const reason = args['reason'];
        if (!Number.isInteger(taskId)) return err('task_id must be a number');
        if (typeof reason !== 'string' || reason.trim().length === 0) {
          return err('reason must be a non-empty string');
        }
        const replacement = (field: 'files' | 'verification'): string[] | undefined => {
          if (args[field] === undefined) return undefined;
          const value = validateFenceAdditions(args[field], field);
          if (value.length === 0) throw new Error(`${field} must be a non-empty array of strings.`);
          return value;
        };
        const newFiles = replacement('files');
        const newVerification = replacement('verification');
        const newSpec = args['spec_body'];
        if (newSpec !== undefined) {
          if (typeof newSpec !== 'string' || newSpec.trim().length === 0) {
            return err('spec_body must be a non-empty string');
          }
          if (newSpec.length > SPEC_BODY_MAX_BYTES) {
            return err(`spec_body exceeds ${SPEC_BODY_MAX_BYTES} char limit (actual: ${newSpec.length}).`);
          }
          const criteriaProblem = specCriteriaProblem(newSpec);
          if (criteriaProblem) return err(criteriaProblem);
          const commitProblem = specCommitProblem(newSpec);
          if (commitProblem) return err(commitProblem);
        }
        if (newFiles === undefined && newVerification === undefined && newSpec === undefined) {
          return err('task_update_spec: pass at least one of files, verification, spec_body');
        }

        const task = db.get<{
          id: number;
          issue_id: number;
          branch_id: string;
          status: string;
          files: string | null;
          verification: string | null;
          spec_body: string | null;
          repo: string | null;
          parent_branch_id: string | null;
          prompt_bearing: number;
        }>(
          `SELECT id, issue_id, branch_id, status, files, verification, spec_body, repo, parent_branch_id, prompt_bearing FROM tasks WHERE id = ?`,
          [taskId],
        );
        if (!task) return err(`task_update_spec: task ${taskId} not found`);
        if (!SPEC_AMENDABLE_STATUSES.has(task.status)) {
          return err(
            `task_update_spec: task ${taskId} is '${task.status}'; only pending, running, needs_validation or completed tasks ` +
              `are amended. Reopen a closed, failed or escalated task with task_reopen (files_add / verification_add).`,
          );
        }

        const repoPath = resolveRepoPath(db, task.repo);
        const defaultsRef = reworkDefaultsRef(db, repoPath, task);
        const defaults = readVerificationDefaults(repoPath, defaultsRef);
        if ('error' in defaults) return verificationDefaultsResult('task_update_spec', defaultsRef, defaults.error);
        const oldFiles = parseTaskFiles(task.files);
        const oldVerification = parseTaskFiles(task.verification);
        const files = newFiles ?? oldFiles;
        const promptBearingResolution: PromptBearingResolution =
          newFiles !== undefined
            ? resolvePromptBearing(task.prompt_bearing, newFiles)
            : { prompt_bearing: task.prompt_bearing === 1 ? 1 : 0, derived: false };
        const { verification, added: verificationDefaultsAdded } = appendVerificationDefaults(
          newVerification ?? oldVerification,
          defaults.commands,
        );
        const verificationChanged = newVerification !== undefined || verificationDefaultsAdded.length > 0;
        const diffSummary = (oldList: string[], newList: string[]) => ({
          added: newList.filter((x) => !oldList.includes(x)),
          removed: oldList.filter((x) => !newList.includes(x)),
        });
        const changes: Record<string, unknown> = {};
        if (newFiles !== undefined) changes['files'] = diffSummary(oldFiles, newFiles);
        if (verificationChanged) changes['verification'] = diffSummary(oldVerification, verification);
        if (newSpec !== undefined) {
          changes['spec_body'] = { old_length: (task.spec_body ?? '').length, new_length: (newSpec as string).length };
        }
        const changed = Object.keys(changes);
        const summaryParts = changed.map((field) => {
          const c = changes[field] as { added?: string[]; removed?: string[]; old_length?: number; new_length?: number };
          return field === 'spec_body'
            ? `spec_body ${c.old_length}→${c.new_length} chars`
            : `${field} +${c.added!.length}/-${c.removed!.length}`;
        });

        if (newFiles !== undefined || verificationChanged) {
          const pathRefusal = checkVerificationPaths({
            repoPath,
            ref: repoPath ? taskTipRef(db, repoPath, task) : null,
            verification,
            files,
          });
          if (pathRefusal) return verificationPathResult('task_update_spec', pathRefusal);
        }
        const now = nowISO();
        db.transaction(() => {
          db.run(
            `UPDATE tasks SET files = ?, verification = ?, spec_body = ?, updated_at = ? WHERE id = ?`,
            [JSON.stringify(files), JSON.stringify(verification), newSpec ?? task.spec_body, now, taskId],
          );
          if (promptBearingResolution.derived) {
            db.run(`UPDATE tasks SET prompt_bearing = 1 WHERE id = ?`, [taskId]);
          }
          insertDiscussion(db, {
            issue_id: task.issue_id,
            author: agent,
            kind: 'decision',
            body: `Task ${taskId} spec amended (${summaryParts.join('; ')}): ${reason}`,
            created_at: now,
            task_id: task.id,
          });
          insertAudit(db, {
            issue_id: task.issue_id,
            branch_id: task.branch_id,
            from_node: agent,
            event_type: 'task_spec_amended',
            summary: `Task ${taskId} spec amended: ${summaryParts.join('; ')}`.slice(0, 200),
            content_json: JSON.stringify({ task_id: taskId, status: task.status, reason, changes }),
            created_at: now,
          });
        });

        return ok({
          task_id: taskId,
          changed,
          files,
          verification,
          ...promptBearingDerivedField(promptBearingResolution),
          verification_defaults_added: verificationDefaultsAdded,
          ...suggestVerification(db, suggestionRepo(db, task.repo), repoPath, files, verification),
        });
      }),
    ),

    task_brief: requireRoles(
      'task_brief',
      ['bro', 'swe', 'code-reviewer', 'consultant'],
      wrap(async (args) => {
        const taskId = args['task_id'];
        if (taskId === undefined || taskId === null) return err('task_id is required');
        const caller = normalizeAgent(args['agent'] as string | undefined);
        const isSwe = caller === 'swe';
        const section = args['section'] ?? (isSwe ? 'core' : 'all');
        if (!isBriefSection(section)) {
          return err(`unknown section ${JSON.stringify(section)}; valid values: ${BRIEF_SECTIONS.join(', ')}`);
        }
        const responseFormat = args['response_format'] ?? 'concise';
        if (!isBriefResponseFormat(responseFormat)) {
          return err(
            `unknown response_format ${JSON.stringify(responseFormat)}; valid values: ${BRIEF_RESPONSE_FORMATS.join(', ')}`,
          );
        }
        const concise = responseFormat === 'concise';
        const leanReviewerCore = concise && caller === 'code-reviewer';
        let trimmed = false;
        const want = (s: BriefSection): boolean => section === 'all' || section === s;

        const task = db.get<{
          id: number;
          issue_id: number;
          branch_id: string;
          title: string;
          status: string;
          spec_body: string;
          files: string | null;
          verification: string | null;
          commit_sha: string | null;
          repo: string | null;
          effort: Effort;
          completion_report: string | null;
          spawn_note: string | null;
          checkpoint: string | null;
          worktree_path: string | null;
          objective: string;
        }>(
          `SELECT t.id, t.issue_id, t.branch_id, t.title, t.status, t.spec_body, t.files, t.verification, t.commit_sha, t.repo,
                  t.effort, t.completion_report, t.spawn_note, t.checkpoint, t.worktree_path, i.objective
             FROM tasks t JOIN issues i ON i.id = t.issue_id
            WHERE t.id = ? LIMIT 1`,
          [taskId],
        );
        if (!task) return err(`No task with id=${taskId}`);

        const repoPath = resolveRepoPath(db, task.repo);
        const worktreePath = repoPath?.startsWith('/') ? taskWorktreeDir(repoPath, task) : null;

        if (isSwe) {
          openSweRun(db, task, nowISO(), runContext, worktreePath);
          const sentinel = db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM audit WHERE event_type = 'swe_brief_fetched' AND json_extract(content_json, '$.task_id') = ?`,
            [task.id],
          );
          if (!sentinel || sentinel.n === 0) {
            insertAudit(db, {
              issue_id: task.issue_id,
              branch_id: task.branch_id,
              from_node: 'swe',
              writer: 'swe',
              event_type: 'swe_brief_fetched',
              summary: `SWE fetched task_brief for task_id=${task.id}`,
              content_json: JSON.stringify({ task_id: task.id, agent_type: 'swe' }),
              created_at: nowISO(),
              repo: task.repo,
            });
          }
        }

        // Resolve repo: task.repo, else the single-repo fallback (path-keyed
        // resolution — empty in multi-repo projects, which scope by task.repo).
        let repo = task.repo ?? '';
        if (!repo) {
          repo = resolveSoleRepo(db)?.name ?? '';
        }

        const coreSection = (): Record<string, unknown> => {
          const open_findings = db.all<{
            id: string;
            criterion_id: string | null;
            probe_cmd: string;
            expected: string;
            observed: string;
            severity: string;
            class: string | null;
          }>(
            `SELECT id, criterion_id, probe_cmd, expected, observed, severity, class FROM review_findings
              WHERE task_id = ? AND status = 'open' AND severity = 'blocking' ORDER BY ${FINDING_ORDER_SQL}`,
            [task.id],
          ).map((f) => ({ ...f }));
          const stop = db.get<{ stop_cause: string | null; stop_detail: string | null; completed_at: string | null }>(
            `SELECT stop_cause, stop_detail, completed_at FROM agent_runs
              WHERE task_id = ? AND agent_type = 'swe' AND completed_at IS NOT NULL
              ORDER BY id DESC LIMIT 1`,
            [task.id],
          );
          const last_stop =
            stop && stop.stop_cause !== null
              ? { cause: stop.stop_cause, detail: stop.stop_detail, at: stop.completed_at }
              : null;
          const taskFiles = parseTaskFiles(task.files);
          let worldModel: Record<string, unknown> = {};
          if (leanReviewerCore) {
            trimmed ||= repoIndexed(db, repo);
          } else {
            const locations = briefLocations(db, repo, task.spec_body ?? '', taskFiles);
            worldModel = { locations, concepts: briefConcepts(db, repo, taskFiles, locations) };
          }
          return {
            task_id: task.id,
            issue_id: task.issue_id,
            branch_id: task.branch_id,
            title: task.title,
            objective: task.objective,
            status: task.status,
            commit_sha: task.commit_sha,
            repo,
            worktree_path: worktreePath,
            effort: task.effort,
            spec_body: task.spec_body,
            files: taskFiles,
            open_findings,
            completion_report: parseStoredReport(task.completion_report),
            spawn_note: task.spawn_note,
            checkpoint: parseStoredCheckpoint(task.checkpoint),
            last_stop,
            ...worldModel,
          };
        };

        const scopeSection = (): Record<string, unknown> => {
          // The dirs the task's typed files[] touch, resolved in the world model.
          const dirs = filesToDirs(parseTaskFiles(task.files));
          let scope_world_model: Array<{
            dir: string;
            summary: string | null;
            children: Array<{ path: string; summary: string | null }>;
          }> = [];
          let world_model_warning: string | undefined;
          const graph = graphHolder?.ensureGraph() ?? null;
          if (!graph) {
            world_model_warning = 'world-model-unavailable';
          } else {
            const nodes = graph.allDirectoriesForRepo(repo);
            if (nodes.length === 0) {
              world_model_warning = 'world-model-empty';
            } else {
              const byPath = new Map(nodes.map((n) => [n.path, n]));
              const childrenByParent = new Map<string, typeof nodes>();
              for (const n of nodes) {
                const key = n.parent_path ?? '';
                if (key === n.path) continue;
                if (!childrenByParent.has(key)) childrenByParent.set(key, []);
                childrenByParent.get(key)!.push(n);
              }
              scope_world_model = dirs.map((d) => ({
                dir: d,
                summary: byPath.get(d)?.summary ?? null,
                children: (childrenByParent.get(d) ?? []).map((c) => ({
                  path: c.path,
                  summary: c.summary,
                })),
              }));
            }
          }

          // The scope report review_handoff recorded for the current commit
          // (extras with swe's reasons, base moved) — code-reviewer reads it
          // instead of recomputing the diff — and, once closed, the extras
          // bro_atomic_close accepted for that commit.
          const handoff = scopeRecordFor<HandoffScope>(db, 'review_handoff', task.id, task.commit_sha);
          const closeScope = task.status === 'closed' ? scopeRecordFor<CloseScope>(db, 'bro_verification_pass', task.id, task.commit_sha) : null;
          const movedFrom = handoff ?? closeScope;
          const scope = {
            files: parseTaskFiles(task.files),
            extras: Array.isArray(handoff?.extras) ? handoff.extras : [],
            extras_accepted: Array.isArray(closeScope?.extras_accepted) ? closeScope.extras_accepted : [],
            base_moved: movedFrom ? movedFrom.base_moved === true : null,
          };
          if (concise) {
            trimmed ||= scope_world_model.some(
              (d) => d.summary !== null || d.children.some((c) => c.summary !== null),
            );
          }
          return {
            scope,
            scope_world_model: concise
              ? scope_world_model.map((d) => ({ dir: d.dir, children: d.children.map((c) => ({ path: c.path })) }))
              : scope_world_model,
            ...checkoutLag(db, repo),
            ...(world_model_warning ? { world_model_warning } : {}),
          };
        };

        const historySection = (): Record<string, unknown> => {
          // GH 1741: the brief carries this task's decision/intent rows in full,
          // the newest issue-level decision (task_id IS NULL), and the last few
          // other-kind rows truncated; a row another row supersedes is skipped.
          // GH 1760: plus the newest issue-level intent (intent_start's verbatim
          // Human words), truncated like a note but outside OTHER_ROW_CAP.
          // Everything else stays reachable through discussion_search.
          type BriefDiscussion = { id: number; author: string; kind: string; body: string; created_at: string };
          const NOTE_CAP = 500;
          const OTHER_ROW_CAP = 8;
          const historyHint = `discussion_search(issue_id=${task.issue_id}) returns the full history`;
          const taskRows = db.all<BriefDiscussion>(
            `SELECT d.id, d.author, d.kind, d.body, d.created_at FROM discussions d
              WHERE d.issue_id = ? AND d.task_id = ? AND d.kind IN ('decision', 'intent')
                AND NOT EXISTS (SELECT 1 FROM discussions s WHERE s.supersedes = d.id)`,
            [task.issue_id, task.id],
          );
          const issueDecision = db.get<BriefDiscussion>(
            `SELECT d.id, d.author, d.kind, d.body, d.created_at FROM discussions d
              WHERE d.issue_id = ? AND d.task_id IS NULL AND d.kind = 'decision'
                AND NOT EXISTS (SELECT 1 FROM discussions s WHERE s.supersedes = d.id)
              ORDER BY d.created_at DESC, d.id DESC LIMIT 1`,
            [task.issue_id],
          );
          const issueIntent = db.get<BriefDiscussion>(
            `SELECT d.id, d.author, d.kind, d.body, d.created_at FROM discussions d
              WHERE d.issue_id = ? AND d.task_id IS NULL AND d.kind = 'intent'
                AND NOT EXISTS (SELECT 1 FROM discussions s WHERE s.supersedes = d.id)
              ORDER BY d.created_at DESC, d.id DESC LIMIT 1`,
            [task.issue_id],
          );
          const otherRows = db.all<BriefDiscussion>(
            `SELECT d.id, d.author, d.kind, d.body, d.created_at FROM discussions d
              WHERE d.issue_id = ? AND d.kind NOT IN ('decision', 'intent')
                AND NOT EXISTS (SELECT 1 FROM discussions s WHERE s.supersedes = d.id)
              ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
            [task.issue_id, OTHER_ROW_CAP],
          );
          const merged = new Map<number, BriefDiscussion>();
          for (const d of [...taskRows, issueDecision, issueIntent, ...otherRows]) {
            if (d && !merged.has(d.id)) merged.set(d.id, d);
          }
          const task_discussions = [...merged.values()]
            .sort((a, b) => (a.created_at === b.created_at ? a.id - b.id : a.created_at < b.created_at ? -1 : 1))
            .map((d) => {
              const capped = d.id === issueIntent?.id || (d.kind !== 'decision' && d.kind !== 'intent');
              if (!capped || d.body.length <= NOTE_CAP) return d;
              return {
                ...d,
                body: d.body.slice(0, NOTE_CAP) + `\n… [truncated; ${historyHint}]`,
                truncated: true,
              };
            });
          const issueRowCount =
            db.get<{ n: number }>('SELECT COUNT(*) AS n FROM discussions WHERE issue_id = ?', [task.issue_id])?.n ?? 0;
          const omittedCount = issueRowCount - task_discussions.length;
          const task_discussions_omitted =
            omittedCount > 0
              ? { count: omittedCount, hint: `older, other-task and superseded rows are omitted; ${historyHint}` }
              : undefined;
          const keptInConcise = new Set([...taskRows, issueDecision, issueIntent].map((d) => d?.id));
          trimmed ||= concise && task_discussions.some((d) => !keptInConcise.has(d.id));
          return {
            task_discussions: concise
              ? task_discussions.map((d) =>
                  keptInConcise.has(d.id) ? d : { id: d.id, kind: d.kind, author: d.author },
                )
              : task_discussions,
            ...(task_discussions_omitted ? { task_discussions_omitted } : {}),
          };
        };

        const verificationSection = () => {
          const stored = latestVerificationRun(db, task.id, { withOutputTail: true });
          if (!concise || !stored) return { verification: parseTaskFiles(task.verification), verification_run: stored };
          trimmed ||= stored.commands.some((c) => (c.output_tail?.length ?? 0) > BRIEF_OUTPUT_TAIL_CHARS);
          const commands = stored.commands.map((c) => ({
            ...c,
            output_tail: clipOutputTail(c.output_tail ?? null, BRIEF_OUTPUT_TAIL_CHARS),
          }));
          return { verification: parseTaskFiles(task.verification), verification_run: { ...stored, commands } };
        };

        const brief = {
          ...(want('core') ? coreSection() : {}),
          ...(section === 'core' ? { sections: BRIEF_SECTION_HINTS } : {}),
          ...(want('verification') ? verificationSection() : {}),
          ...(want('scope') ? scopeSection() : {}),
          ...(want('history') ? historySection() : {}),
          ...(want('core') ? { freshness: freshnessBlock(db, repo || null) } : {}),
        };
        return ok(trimmed ? { ...brief, response_format_hint: BRIEF_RESPONSE_FORMAT_HINT } : brief);
      }),
    ),

    branch_id_propose: requireRoles(
      'branch_id_propose',
      ['bro'],
      wrap(async (args) => {
        const intent = args['intent'];
        if (typeof intent !== 'string' || intent.trim().length === 0) {
          return err('intent must be a non-empty string');
        }
        const objective = (args['objective'] as string | undefined) ?? intent;

        const { prefix, confidence } = intentToType(intent);
        const slug = slugify(objective) || slugify(intent) || 'task';
        const branchId = `${prefix}/${slug}`;

        if (!BRANCH_ID_RE.test(branchId)) {
          return err(
            `Derived branch_id "${branchId}" does not match the conventional regex. ` +
              `Pick a clearer objective and re-call.`,
          );
        }

        return ok({ branch_id: branchId, confidence });
      }),
    ),

    task_retry: requireRoles(
      'task_retry',
      ['bro'],
      wrap(async (args) => {
        const agent = (args['agent'] as string | undefined) ?? 'bro';
        const failedTaskId = args['failed_task_id'] as string;
        const newBranchId = args['new_branch_id'] as string;
        const spec = args['corrected_spec_body'] as string;
        const rationale = args['retry_rationale'] as string;
        const description = args['description'] as string;
        const title = (args['title'] as string | undefined) ?? '';
        const repoOverride = (args['repo'] as string | undefined) ?? null;
        parseRunSessionId(args['session_id']);
        const adoptPath = parseAdoptWorktree(args['adopt_worktree'], 'task_retry');
        const effortArg = args['effort'];

        if (effortArg !== undefined && !isEffort(effortArg)) {
          return err(`typed_field_violation: effort must be one of ${EFFORT_LEVELS.join(', ')}, got ${JSON.stringify(effortArg)}.`);
        }
        if (!BRANCH_ID_RE.test(newBranchId)) {
          return err(`Invalid new_branch_id "${newBranchId}" — does not match conventional format.`);
        }
        if (!spec || spec.length > SPEC_BODY_MAX_BYTES) {
          return err(`corrected_spec_body must be 1..${SPEC_BODY_MAX_BYTES} chars (override via TMB_SPEC_BODY_MAX_BYTES).`);
        }
        if (!rationale || rationale.length > 200) {
          return err('retry_rationale must be 1..200 chars.');
        }
        if (repoOverride !== null) {
          if (repoOverride.includes('..')) {
            return err(`Invalid repo "${repoOverride}": must not contain "..".`);
          }
          if (repoOverride.startsWith('/')) {
            return err(`Invalid repo "${repoOverride}": must not start with "/".`);
          }
        }

        const failed = db.get<{
          id: number;
          issue_id: number;
          branch_id: string;
          parent_branch_id: string | null;
          repo: string | null;
          status: string;
          files: string;
          verification: string;
          prompt_bearing: number;
          effort: Effort;
        }>(
          `SELECT id, issue_id, branch_id, parent_branch_id, repo, status,
                  files, verification, prompt_bearing, effort
             FROM tasks WHERE id = ? LIMIT 1`,
          [failedTaskId],
        );
        if (!failed) return err(`No task with id=${failedTaskId}`);
        if (failed.status !== 'failed' && failed.status !== 'escalated') {
          return err(
            `Task ${failedTaskId} status is "${failed.status}", expected "failed" or "escalated". ` +
              `task_retry only operates on terminally-failed tasks.`,
          );
        }
        if (failed.branch_id === newBranchId) {
          return err('new_branch_id must differ from the failed task\'s branch_id.');
        }
        const usedOnIssue = branchIdUsedOnIssueResult(db, 'task_retry', failed.issue_id, newBranchId);
        if (usedOnIssue) return usedOnIssue;

        const promptBearingResolution = resolvePromptBearing(failed.prompt_bearing, parseTaskFiles(failed.files));
        const { effort } = computeEffort(db, {
          effort: effortArg,
          prompt_bearing: promptBearingResolution.prompt_bearing,
          files: parseTaskFiles(failed.files),
          rework: true,
          current: failed.effort,
        });

        // The environment gate before the transaction (a failed stage persists
        // no row, as in task_provision); an adopted worktree is switched after
        // it, fail-soft into diagnostic.
        const repoValue = repoOverride ?? failed.repo;
        const resolvedPath = resolveRepoPath(db, repoValue);
        const repoPath = resolvedPath && isGitRepo(resolvedPath) ? resolvedPath : null;
        let branchSetup: { gitSetup: 'created' | 'reused'; baseRef: string | null } | null = null;
        if (repoPath) {
          for (const path of [repoPath, adoptPath ?? taskWorktreePath(repoPath, newBranchId)]) {
            const refusal = outsideProject('task_retry', runContext.projectRoot, path);
            if (refusal) return outsideProjectResult(refusal);
          }
        }
        let adoptedWorktree: string | null = null;
        if (adoptPath !== undefined) {
          const check = adoptWorktreeCheck(db, { taskId: null, repoPath: repoPath ?? '', worktreePath: adoptPath });
          if (!check.ok) return adoptRefusalResult(check);
          adoptedWorktree = check.realWorktree;
        }
        const retryFiles = parseTaskFiles(failed.files);
        const retryBase = repoPath ? normalizeBase(repoPath, reworkBase(db, repoPath, repoValue, failed.parent_branch_id)) : null;
        // The environment gate's fetch comes first so the defaults below are
        // read at the fetched tip; an adopted worktree keeps the ungated path.
        const nothingWritten = 'No task row was created.';
        let fetched: EnvStageReport | null = null;
        if (repoPath && retryBase && adoptedWorktree === null) {
          const fetch = fetchBaseStage(repoPath, retryBase);
          if (!fetch.ok) return envGateFailedResult('task_retry', fetch, nothingWritten);
          fetched = fetch.report;
        }
        const pathRef = repoPath && retryBase ? resolveCutBase(repoPath, retryBase)?.ref ?? null : null;
        const defaults = readVerificationDefaults(repoPath, pathRef);
        if ('error' in defaults) return verificationDefaultsResult('task_retry', pathRef, defaults.error);
        const { verification: retryVerification, added: verificationDefaultsAdded } = appendVerificationDefaults(
          parseTaskFiles(failed.verification),
          defaults.commands,
        );
        const storedVerification = verificationDefaultsAdded.length > 0 ? JSON.stringify(retryVerification) : failed.verification;
        const pathRefusal =
          !repoPath || pathRef
            ? checkVerificationPaths({ repoPath, ref: pathRef, verification: retryVerification, files: retryFiles })
            : checkVerificationProse(retryVerification, pathRef);
        if (pathRefusal) return verificationPathResult('task_retry', pathRefusal);
        const suggested = () => ({
          verification_defaults_added: verificationDefaultsAdded,
          ...verificationDefaultsMissingField(repoPath, pathRef, defaults),
          ...suggestVerification(db, suggestionRepo(db, repoValue), repoPath, retryFiles, retryVerification),
        });
        let gate: EnvGatePass | null = null;
        if (repoPath && retryBase) {
          const base = retryBase;
          const branchStage = (): BranchStageOutcome =>
            taskBranchStage(ensureTaskBranch(repoPath, newBranchId, base), base, repoValue ?? '', (ref, baseRef) =>
              branchDivergedPayload(
                'task_retry',
                newBranchId,
                ref,
                baseRef,
                refDistance(repoPath, baseRef, ref),
                openChangeRequestsForBranch(db, repoValue, repoPath, newBranchId, args['_spawnFn'] as SpawnFn | undefined),
                'Pick a fresh new_branch_id (branch_id_propose).',
              ),
            );
          if (fetched) {
            const passed = await runEnvGate({
              db,
              dbPath,
              graph: graphHolder?.ensureGraph() ?? null,
              repo: suggestionRepo(db, repoValue),
              repoPath,
              branchId: newBranchId,
              worktreePath: taskWorktreePath(repoPath, newBranchId),
              fetched,
              ensureBranch: branchStage,
            });
            if (!passed.ok) return envGateFailedResult('task_retry', passed, nothingWritten);
            gate = passed;
            branchSetup = { gitSetup: passed.branchCreated ? 'created' : 'reused', baseRef: passed.base_ref };
          } else {
            const stage = branchStage();
            if (!stage.ok) return branchRefusalResult('task_retry', stage, nothingWritten);
            branchSetup = { gitSetup: stage.created ? 'created' : 'reused', baseRef: stage.baseRef };
          }
        }

        const now = nowISO();
        const result = gatedTransaction(db, gate, () => {
          db.run(
            `INSERT INTO tasks
               (issue_id, branch_id, parent_branch_id, title, description,
                status, spec_body, repo, prompt_bearing, files, verification, effort, base_sha, wm_commit, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              failed.issue_id,
              newBranchId,
              failed.parent_branch_id ?? failed.branch_id,
              title,
              description,
              spec,
              repoOverride ?? failed.repo,
              promptBearingResolution.prompt_bearing,
              failed.files,
              storedVerification,
              effort,
              gate?.base_sha ?? null,
              gate?.wm_commit ?? null,
              now,
              now,
            ],
          );

          const newTask = db.get<{ id: number; branch_id: string; repo: string | null }>(
            'SELECT id, branch_id, repo FROM tasks WHERE rowid = last_insert_rowid()',
          );
          if (!newTask) throw new Error('insert succeeded but row lookup failed');

          insertDiscussion(db, {
            issue_id: failed.issue_id,
            author: 'bro',
            kind: 'decision',
            body: [`Retry rationale (failed task ${failedTaskId}): ${rationale}`, gate?.decisionNote].filter(Boolean).join('\n\n'),
            created_at: now,
            task_id: newTask.id,
          });

          insertAudit(db, {
            issue_id: failed.issue_id,
            branch_id: newBranchId,
            from_node: agent,
            event_type: 'task_retry_attempted',
            summary: `Retry of failed task ${failedTaskId}: ${rationale.slice(0, 120)}`,
            content_json: JSON.stringify({
              failed_task_id: failed.id,
              new_task_id: newTask.id,
              new_branch_id: newBranchId,
            }),
            created_at: now,
          });

          if (effortRank(effort) > effortRank(failed.effort)) {
            insertEffortRaised(db, { issue_id: failed.issue_id, branch_id: newBranchId, task_id: newTask.id }, failed.effort, effort, agent, now, failed.id);
          }

          const carried = carryOpenFindings(db, failed.id, newTask.id, now);
          if (carried.length > 0) {
            insertAudit(db, {
              issue_id: failed.issue_id,
              branch_id: newBranchId,
              from_node: agent,
              event_type: 'review_findings_carried',
              summary: `Carried ${carried.length} open review finding(s) from task ${failed.id} to task ${newTask.id}`,
              content_json: JSON.stringify({ from_task_id: failed.id, to_task_id: newTask.id, findings: carried }),
              created_at: now,
            });
          }

          if (adoptedWorktree !== null && repoPath) {
            const refused = recordAdoptedWorktree(db, newTask.id, repoPath, adoptedWorktree);
            if (refused) throw new AdoptRefusedError(refused);
          }

          return { ...newTask, carried };
        });
        if (isAdoptRefusal(result)) return adoptRefusalResult(result);

        if (!repoPath || !branchSetup) {
          return ok({
            task_id: result.id,
            branch_id: result.branch_id,
            effort,
            ...promptBearingDerivedField(promptBearingResolution),
            carried_findings: result.carried,
            worktree_path: null,
            diagnostic: `cannot resolve a git repo path for repo='${repoValue ?? ''}'; no branch or worktree was created`,
            ...suggested(),
          });
        }
        const worktreePath = adoptedWorktree ?? taskWorktreePath(repoPath, newBranchId);
        let diagnostic: string | undefined;
        if (adoptedWorktree !== null) {
          diagnostic = switchAdoptedWorktree(adoptedWorktree, newBranchId);
          await spawnReindex(repoValue, repoPath, branchSetup.baseRef);
        }
        return ok({
          task_id: result.id,
          branch_id: result.branch_id,
          effort,
          ...promptBearingDerivedField(promptBearingResolution),
          carried_findings: result.carried,
          git_setup: branchSetup.gitSetup,
          base_ref: branchSetup.baseRef,
          worktree_path: worktreePath,
          ...setupField(gate?.setup),
          ...(adoptedWorktree !== null ? { worktree_adopted: true } : {}),
          ...(gate ? { base_sha: gate.base_sha, wm_commit: gate.wm_commit, ...envGateField(gate.stages) } : {}),
          ...(diagnostic ? { diagnostic } : {}),
          ...suggested(),
        });
      }),
    ),

    intent_start: requireRoles(
      'intent_start',
      ['bro'],
      wrap(async (args) => {
        const objective = args['objective'] as string;
        const intentVerbatim = args['intent_verbatim'] as string;
        const branchId = args['branch_id'] as string;

        if (!objective || objective.trim().length === 0) {
          return err('objective must be a non-empty string');
        }
        if (!intentVerbatim || intentVerbatim.trim().length === 0) {
          return err('intent_verbatim must be a non-empty string');
        }
        if (!branchId || branchId.trim().length === 0) {
          return err('branch_id must be a non-empty string');
        }
        if (!BRANCH_ID_RE.test(branchId)) {
          return err(`branch_id "${branchId}" does not match the conventional format.`);
        }

        // repo (#15): explicit arg, else the sole registered repo. An explicit
        // repo must match a repos row, mirroring issue_create's repo handling.
        const explicitRepoRaw = args['repo'];
        const explicitRepo =
          typeof explicitRepoRaw === 'string' && explicitRepoRaw.length > 0 ? explicitRepoRaw : null;
        if (explicitRepo !== null) {
          const repoRow = db.get<{ name: string }>(`SELECT name FROM repos WHERE name = ?`, [explicitRepo]);
          if (!repoRow) {
            return err(`intent_start: repo "${explicitRepo}" has no matching repos row — run /scan or pass a valid repo.`);
          }
        }

        const suppliedLabels = args['labels'] as string[] | undefined;
        const inference = inferIssueArea(
          db,
          suppliedLabels ?? defaultSyncLabels(db),
          [objective],
          undefined,
          'intent_start',
        );
        if ('error' in inference) return err(inference.error);
        const { labels, areaInferred } = inference;
        const labelError = validateIssueLabels(db, labels);
        if (labelError !== null) return err(labelError);

        const now = nowISO();
        // Resolve the issue's repo (explicit arg, else the sole registered repo)
        // so the milestone default + FK insert bind to the right repo (#15).
        const issueRepo = explicitRepo ?? resolveSoleRepo(db)?.name ?? null;
        const result = db.transaction(() => {
          const milestoneResolution = resolveDefaultMilestone(db, null, issueRepo);
          const milestone = milestoneResolution.milestone;
          db.run(
            `INSERT INTO issues (objective, description, status, created_at, updated_at, milestone, repo, labels)
             VALUES (?, '', 'open', ?, ?, ?, ?, ?)`,
            [objective, now, now, milestone, issueRepo, JSON.stringify(labels)],
          );
          const row = db.get<{ id: number }>(
            `SELECT id FROM issues WHERE rowid = last_insert_rowid()`,
          );
          if (!row) throw new Error('intent_start: failed to retrieve inserted issue');
          const issueId = row.id;

          insertIntentAndNote(
            db,
            issueId,
            intentVerbatim,
            `Beginning planning on ${branchId}.`,
            now,
          );

          insertAudit(db, {
            issue_id: issueId,
            branch_id: branchId,
            from_node: 'bro',
            event_type: 'branch_id_proposed',
            summary: `branch_id proposed: ${branchId} for "${objective.slice(0, 80)}"`,
            content_json: JSON.stringify({ branch_id: branchId, objective }),
            created_at: now,
          });

          return {
            issue_id: issueId,
            branch_id: branchId,
            ...milestoneDefaultFields(milestoneResolution),
            area_inferred: areaInferred,
          };
        });

        return ok(result);
      }),
    ),

    bro_verification_fail_record: requireRoles(
      'bro_verification_fail_record',
      ['bro'],
      wrap(async (args) => {
        const taskId = args['task_id'] as string;
        const whichCheck = args['which_check'] as string;
        const details = args['details'] as string;

        if (!taskId) return err('task_id is required');
        if (!whichCheck || whichCheck.trim().length === 0) {
          return err('which_check must be a non-empty string');
        }
        if (!details || details.trim().length === 0) {
          return err('details must be a non-empty string');
        }
        if (details.length > 500) {
          return err('details must be ≤500 chars');
        }

        const task = db.get<{ id: number; issue_id: number; branch_id: string }>(
          'SELECT id, issue_id, branch_id FROM tasks WHERE id = ? LIMIT 1',
          [taskId],
        );
        if (!task) return err(`No task with id=${taskId}`);

        const summary = `${whichCheck} — ${details.slice(0, 160)}`;
        const now = nowISO();

        db.transaction(() => {
          insertAudit(db, {
            issue_id: task.issue_id,
            branch_id: task.branch_id,
            from_node: 'bro',
            event_type: 'bro_verification_fail',
            summary,
            content_json: JSON.stringify({ task_id: task.id, which_check: whichCheck, details }),
            created_at: now,
          });
          insertDiscussion(db, {
            issue_id: task.issue_id,
            author: 'bro',
            kind: 'note',
            body: `Verification fail: ${summary}`,
            created_at: now,
          });
        });

        return ok({ task_id: task.id, which_check: whichCheck, written: ['audit', 'note'] });
      }),
    ),

    pr_monitor_worktree: requireRoles(
      'pr_monitor_worktree',
      ['code-reviewer'],
      wrap(async (args) => {
        const commitSha = ((args['commit_sha'] as string) ?? '').toLowerCase();
        const repoPath = args['repo_path'] as string;
        const command = args['command'] as string;

        if (!commitSha || !/^[0-9a-f]{7,40}$/.test(commitSha)) {
          return err('commit_sha must be a 7..40-char hex SHA');
        }
        if (!repoPath || !repoPath.startsWith('/')) {
          return err('repo_path must be an absolute path');
        }
        if (!command || command.trim().length === 0) {
          return err('command must be a non-empty string');
        }

        const repoRefusal = outsideProject('pr_monitor_worktree', runContext.projectRoot, repoPath);
        if (repoRefusal) return outsideProjectResult(repoRefusal);
        const wtParent = `${repoPath}/.claude/worktrees`;
        let wtPath: string;
        let stdout = '';
        let stderr = '';
        let exitCode = 0;
        let timedOut = false;

        try {
          mkdirSync(wtParent, { recursive: true });
          if (!worktreesDirContained(repoPath, wtParent)) throw new Error(`${wtParent} resolves outside ${repoPath}`);
          wtPath = mkdtempSync(`${wtParent}/pr-review-${commitSha}-`);
        } catch (e) {
          return err(`worktree add failed: ${(e as Error).message}`);
        }
        try {
          execFileSync('git', ['-C', repoPath, 'worktree', 'add', wtPath, commitSha], {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: WORKTREE_TIMEOUT_MS,
          });
        } catch (e) {
          clearPrReviewWorktree(repoPath, wtPath);
          return err(`worktree add failed: ${(e as Error).message}`);
        }

        let setupFailure: WorktreeSetupResult | null = null;
        try {
          const env = setupEnv(wtPath);
          const deps = await prepareWorktreeDeps(repoPath, wtPath, { env });
          const setup: WorktreeSetupResult =
            deps.install_error !== undefined
              ? { ran: false, commands: [], error: deps.install_error }
              : await runWorktreeSetup(wtPath, { env });
          if (setup.error !== undefined) {
            setupFailure = setup;
          } else {
            ({ stdout, stderr, exitCode, timedOut } = await runBudgeted(command, wtPath, commandBudgetS(db) * 1000));
          }
        } catch (e: unknown) {
          stderr = (e as Error).message ?? '';
          exitCode = 1;
        } finally {
          try {
            execFileSync('git', ['-C', repoPath, 'worktree', 'remove', '--force', wtPath], {
              stdio: 'ignore',
              timeout: WORKTREE_TIMEOUT_MS,
            });
          } catch {
            // best-effort cleanup; don't override the command result
          }
        }

        if (setupFailure !== null) {
          const error = `worktree setup failed, command not run: ${describeSetupFailure(setupFailure)}`;
          return { content: [{ type: 'text', text: JSON.stringify({ error, passed: false }) }], isError: true };
        }
        const passed = exitCode === 0;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                worktree: wtPath,
                exit_code: exitCode,
                passed,
                timed_out: timedOut,
                stdout: stdout.slice(0, 4096),
                stderr: stderr.slice(0, 2048),
              }),
            },
          ],
          isError: !passed,
        };
      }),
    ),

    worktree_commits_fetch: requireRoles(
      'worktree_commits_fetch',
      ['bro'],
      wrap(async (args) => {
        const taskIds = args['task_ids'] as string[];
        const repoPath = args['repo_path'] as string;

        if (!Array.isArray(taskIds) || taskIds.length === 0) {
          return err('task_ids must be a non-empty array');
        }
        if (!repoPath || !repoPath.startsWith('/')) {
          return err('repo_path must be an absolute path');
        }

        const results: Array<{ task_id: number | string; branch_id: string; slug: string; commit_sha: string | null; reaped: boolean; error?: string }> = [];

        for (const tid of taskIds) {
          const task = db.get<{ id: number; branch_id: string; commit_sha: string | null; worktree_path: string | null }>(
            'SELECT id, branch_id, commit_sha, worktree_path FROM tasks WHERE id = ? LIMIT 1',
            [tid],
          );
          if (!task) {
            results.push({ task_id: tid, branch_id: '', slug: '', commit_sha: null, reaped: false, error: `No task with id=${tid}` });
            continue;
          }
          const slug = task.branch_id.replace(/^[^/]+\//, '');

          // (a) No-op when the branch ref already resolves in the MAIN checkout
          // to the task's commit_sha. SWE commits land on the branch ref, which
          // — because a linked worktree shares the main repo's object store and
          // ref namespace — is already visible here. No fetch needed. (#156)
          if (task.commit_sha) {
            try {
              const refSha = execFileSync(
                'git',
                ['-C', repoPath, 'rev-parse', '--verify', `refs/heads/${task.branch_id}`],
                { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
              )
                .toString()
                .trim();
              if (refSha.toLowerCase().startsWith(task.commit_sha.toLowerCase())) {
                results.push({ task_id: task.id, branch_id: task.branch_id, slug, commit_sha: task.commit_sha, reaped: true });
                continue;
              }
            } catch {
              // Branch ref absent / unresolvable in the main checkout — fall
              // through to the worktree-rooted reap below.
            }
          }

          // (b) Resolve the worktree path UNDER THE REPO ROOT (not the workspace
          // root) — that is where ensure-swe-worktree creates it. A worktree's
          // `.git` is a file (a gitdir pointer), not a fetchable remote, so do
          // NOT fetch from it: the worktree shares the main repo's object store,
          // so the commit is already present here. When commit_sha is known,
          // point the branch ref at it directly (update-ref); otherwise read the
          // worktree's detached HEAD and set the ref to that. (#156)
          const wtPath = taskWorktreeDir(repoPath, task);
          try {
            let targetSha = task.commit_sha ?? '';
            if (!targetSha) {
              targetSha = execFileSync(
                'git',
                ['-C', wtPath, 'rev-parse', 'HEAD'],
                { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
              )
                .toString()
                .trim();
            }
            execFileSync(
              'git',
              ['-C', repoPath, 'update-ref', `refs/heads/${task.branch_id}`, targetSha],
              { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
            );
            results.push({ task_id: task.id, branch_id: task.branch_id, slug, commit_sha: task.commit_sha ?? targetSha, reaped: true });
          } catch (e) {
            results.push({ task_id: task.id, branch_id: task.branch_id, slug, commit_sha: task.commit_sha, reaped: false, error: (e as Error).message });
          }
        }

        const anyFailed = results.some((r) => !r.reaped);
        const allReaped = results.length > 0 && !anyFailed;
        return {
          content: [{ type: 'text', text: JSON.stringify({ reaped: results, all_reaped: allReaped }) }],
          isError: anyFailed,
        };
      }),
    ),

    review_handoff: requireRoles(
      'review_handoff',
      ['bro'],
      wrap((args) => Promise.resolve().then(() => {
        const taskId = args['task_id'] as string;
        if (!taskId) return err('Missing required arg: task_id');
        const spawnNote = parseSpawnNote(args['spawn_note'], 'review_handoff');
        const sessionId = parseRunSessionId(args['session_id']);

        const task = db.get<{
          id: number;
          issue_id: number;
          branch_id: string;
          parent_branch_id: string | null;
          status: string;
          commit_sha: string | null;
          repo: string | null;
          files: string | null;
          verification: string | null;
          spec_body: string | null;
          completion_report: string | null;
          prompt_bearing: number;
          worktree_path: string | null;
        }>(
          `SELECT id, issue_id, branch_id, parent_branch_id, status, commit_sha, repo, files, verification, spec_body, completion_report, prompt_bearing, worktree_path
             FROM tasks WHERE id = ? LIMIT 1`,
          [taskId],
        );
        if (!task) return err(`No task with id=${taskId}`);
        const reReview = task.status === 'running' ? reReviewAdmission(db, task) : null;
        if (reReview !== null && 'refusal' in reReview) {
          return err(
            `re_review_refused: task ${taskId} is running and its commit cannot be re-reviewed: ${reReview.refusal}. ` +
              `A running task is handed off again only when its latest verdict is a FAIL on its current commit, no swe run is live, ` +
              `a passing verification run is recorded for the commit and its latest task_rework_analysis, dated after that FAIL, names ${RE_REVIEW_CHANGE}.`,
          );
        }
        if (reReview === null && !HANDOFF_STATUSES.has(task.status)) {
          return err(
            `Task ${taskId} status is "${task.status}", expected "completed" or "needs_validation". ` +
              `review_handoff runs after SWE flips status to completed.`,
          );
        }
        const handedOff = reReview === null ? task : { ...task, completion_report: reReview.completionReport };
        const commitSha = task.commit_sha;
        if (!commitSha) {
          return err(
            `commit_sha_missing: task ${task.id} records no commit_sha. Resume the swe on task_id=${task.id} to call ` +
              `task_update_status(status='completed', commit_sha=<sha>), then retry review_handoff.`,
          );
        }
        const gateError = handoffGateError(db, handedOff, commitSha);
        if (gateError !== null) return err(gateError);

        const { scope, repoPath } = taskScopeCheck(db, task, commitSha);
        const recorded = handoffScope(scope, handedOff.completion_report);
        const reReviewOf = reReview === null ? {} : { re_review_of: reReview.failValidationId };
        const now = nowISO();
        const result = db.transaction(() => {
          if (reReview !== null) restoreForReReviewInTx(db, task.id, reReview, now);
          insertAudit(db, {
            issue_id: task.issue_id,
            branch_id: task.branch_id,
            from_node: 'bro',
            event_type: 'review_handoff',
            summary: `Task ${task.id} commit ${commitSha.slice(0, 12)} handed to code-reviewer.`,
            content_json: JSON.stringify({ task_id: task.id, commit_sha: commitSha, scope: recorded, ...reReviewOf }),
            created_at: now,
          });
          const reviewerEffort = assignReviewerEffort(db, task, commitSha, scope, now);
          db.run('UPDATE tasks SET spawn_note = ? WHERE id = ?', [spawnNote, task.id]);
          return {
            task_id: task.id,
            commit_sha: commitSha,
            review_pending: true,
            ...reReviewOf,
            reviewer_effort: reviewerEffort.effort,
            ...reviewerSpawn(db, task, repoPath ? taskWorktreeDir(repoPath, task) : task.worktree_path, commitSha, reviewerEffort, sessionId),
            scope: recorded,
          };
        });
        return ok(result);
      })),
    ),

    bro_atomic_close: requireRoles(
      'bro_atomic_close',
      ['bro'],
      wrap(async (args) => {
        const taskId = args['task_id'] as string;
        if (!taskId) return err('Missing required arg: task_id');

        const commitArg = ((args['commit_sha'] as string | undefined) ?? '').toLowerCase();
        if (!commitArg || !/^[0-9a-f]{7,40}$/.test(commitArg)) {
          return err('commit_sha must be a 7..40-char hex SHA.');
        }

        const verificationSummary = args['verification_summary'];
        if (verificationSummary === undefined || verificationSummary === null) {
          return err('Missing required arg: verification_summary');
        }
        if (typeof verificationSummary !== 'string') {
          return err('verification_summary must be a string');
        }
        if (args['spawn_note'] !== undefined) {
          return err('spawn_note moved to review_handoff, which hands the commit to code-reviewer before this close; call bro_atomic_close without it.');
        }

        const closeIssueIfLast = args['close_issue_if_last_task'] === true;
        const waiveScopeGate = args['waive_scope_gate'] === true;

        const task = db.get<{
          id: number;
          issue_id: number;
          branch_id: string;
          parent_branch_id: string | null;
          status: string;
          commit_sha: string | null;
          repo: string | null;
          files: string | null;
        }>(
          `SELECT id, issue_id, branch_id, parent_branch_id, status, commit_sha, repo, files
             FROM tasks WHERE id = ? LIMIT 1`,
          [taskId],
        );
        if (!task) return err(`No task with id=${taskId}`);
        if (task.status !== 'completed' && task.status !== 'needs_validation') {
          return err(
            `Task ${taskId} status is "${task.status}", expected "completed" or "needs_validation". ` +
              `bro_atomic_close runs after SWE flips status to completed and code-reviewer passes the commit.`,
          );
        }
        // The pass is judged on tasks.commit_sha, so the close keeps that
        // exact spelling: a short or differently cased commit_sha would
        // detach the task from its review anchor.
        const commitSha = task.commit_sha;
        if (!commitSha || !(commitSha.toLowerCase().startsWith(commitArg) || commitArg.startsWith(commitSha.toLowerCase()))) {
          return err(
            `commit_sha_mismatch: task ${task.id}'s current commit is ${commitSha ?? '(none)'}, not ${commitArg}. ` +
              `Close the commit code-reviewer passed; new work goes through swe, review_handoff and a fresh review first.`,
          );
        }
        if (!taskHasPassingReview(db, task.id)) {
          return err(
            `review_pass_missing: task ${task.id} has no passing code-reviewer verdict recorded after its review_handoff for commit ${commitSha}. ` +
              `Call review_handoff(task_id=${task.id}, session_id=...), spawn the reviewer_spawn it returns, and retry bro_atomic_close once the verdict is a pass; ` +
              `on a fail, task_reopen(task_id=${task.id}) for rework.`,
          );
        }

        // --- Close-time files[] scope gate ---
        // Extras refuse the close, grouped by surface, unless bro accepts them
        // with waive_scope_gate + scope_waiver_reason; the acceptance lands in
        // scope_gate_waived. Fail-CLOSED when the repo/commit can't be
        // resolved. task_recover's shared close path is intentionally NOT gated.
        const now = nowISO();
        const scopeWaiverReason = typeof args['scope_waiver_reason'] === 'string' ? args['scope_waiver_reason'].trim() : '';
        if (waiveScopeGate && scopeWaiverReason.length < 10) {
          return err('bro_atomic_close: waive_scope_gate=true requires scope_waiver_reason (at least 10 characters) naming why the extra paths are accepted.');
        }

        const { scope } = taskScopeCheck(db, task, commitSha);
        const baseMoved = scope.baseMoved === true;
        const scopeRecord = {
          extras_accepted: waiveScopeGate ? scope.outOfScope : [],
          base_moved: baseMoved,
          recorded_base: scope.recordedBase ?? null,
          merge_base: scope.mergeBase ?? null,
        };

        if (!waiveScopeGate) {
          if (!scope.checked) {
            return err(
              `bro_atomic_close scope gate: cannot resolve ${task.repo ?? '<repo>'}@${commitSha} to verify ` +
                `files[] scope (${scope.reason ?? 'unknown'}). Pass waive_scope_gate=true with scope_waiver_reason if this close ` +
                `is intentional outside a git checkout.`,
            );
          }
          if (scope.outOfScope.length > 0) {
            const groups = groupBySurface(scope.outOfScope);
            const listing = Object.entries(groups)
              .map(([surface, g]) => `${surface} (${g.count}): ${g.paths.join(', ')}`)
              .join('; ');
            const moved = baseMoved
              ? ` The task's recorded base (${scope.recordedBase ?? 'unresolved'}) differs from the merge-base ${scope.mergeBase}: some paths may come from the moved base.`
              : '';
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error:
                      `bro_atomic_close scope gate: ${scope.outOfScope.length} committed path(s) outside the task's files[]: ${listing}.${moved} ` +
                      `Revert them, or accept them with waive_scope_gate=true and scope_waiver_reason.`,
                    extras_by_surface: groups,
                    base_moved: baseMoved,
                    recorded_base: scopeRecord.recorded_base,
                    merge_base: scopeRecord.merge_base,
                  }),
                },
              ],
            };
          }
        }

        const result = db.transaction(() => {
          // The waiver audit lands INSIDE the close transaction (mirror
          // task_create_batch) so a failed close can't leave a phantom waiver
          // audit with no corresponding close.
          if (waiveScopeGate) {
            insertAudit(db, {
              issue_id: task.issue_id,
              branch_id: task.branch_id,
              from_node: 'bro',
              event_type: 'scope_gate_waived',
              summary: scopeWaiverReason.slice(0, 200),
              content_json: JSON.stringify({
                skill: 'bro_atomic_close',
                task_id: task.id,
                commit_sha: commitSha,
                accepted_paths: scope.outOfScope,
                reason: scopeWaiverReason,
                base_moved: baseMoved,
                recorded_base: scopeRecord.recorded_base,
                merge_base: scopeRecord.merge_base,
              }),
              created_at: now,
            });
          }
          const closed = closeTaskInTx(db, task, commitSha, verificationSummary, now, closeIssueIfLast, null, scopeRecord);
          return {
            task_id: task.id,
            issue_closed: closed.issue_closed,
            base_moved: baseMoved,
            ...(baseMoved ? { recorded_base: scopeRecord.recorded_base, merge_base: scopeRecord.merge_base } : {}),
            ...(waiveScopeGate ? { extras_accepted: scope.outOfScope } : {}),
            ...(closed.issue_left_open ? { issue_left_open: closed.issue_left_open } : {}),
          };
        });

        // Mirror the close to the linked remote(s) — same path issue_close
        // uses — so closing the last task via the composite doesn't leave the
        // GitHub/GitLab issue open (#277). Runs after the local transaction
        // commits because the sync spawns gh/glab (async, can't sit inside the
        // synchronous db.transaction).
        const remote = result.issue_closed
          ? await syncIssueCloseRemotes(db, dbPath, task.issue_id, args['_spawnFn'] as SpawnFn | undefined)
          : undefined;

        return ok(remote ? { ...result, remote } : result);
      }),
    ),

    task_recover: requireRoles(
      'task_recover',
      ['bro'],
      wrap(async (args) => {
        const taskArg = args['task_id'];
        const taskId = taskArg === undefined || taskArg === null || taskArg === '' ? null : String(taskArg);

        const commitArg = args['commit_sha'];
        let commitSha: string | null = null;
        if (commitArg !== undefined && commitArg !== null && commitArg !== '') {
          if (typeof commitArg !== 'string') return err('commit_sha must be a string');
          const lowered = commitArg.toLowerCase();
          if (!/^[0-9a-f]{7,40}$/.test(lowered)) {
            return err('commit_sha must be a 7..40-char hex SHA.');
          }
          commitSha = lowered;
        }

        const verificationSummary =
          typeof args['verification_summary'] === 'string'
            ? (args['verification_summary'] as string)
            : `task_recover: stuck-pending recovery for task ${taskId}`;

        const closeIssueIfLast = args['close_issue_if_last_task'] === true;

        const task = taskId === null
          ? null
          : db.get<{
              id: number;
              issue_id: number;
              branch_id: string;
              status: string;
              commit_sha: string | null;
            }>('SELECT id, issue_id, branch_id, status, commit_sha FROM tasks WHERE id = ? LIMIT 1', [taskId]);
        if (taskId !== null && !task) return err(`No task with id=${taskId}`);

        const sweep = sweepStaleTasks(db, nowISO());
        const sweepResult = {
          tasks_swept: sweep.tasks_swept,
          runs_swept: sweep.runs_swept + sweepRunsOfTerminalTasks(db, nowISO()),
          runs_marked_unmeasured: markLegacyUnmeteredRuns(db),
          reported: sweep.reported,
        };

        if (!task) return ok(sweepResult);

        const current = db.get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [task.id])!;

        // Idempotent: already-closed (or any non-recoverable status) → no-op
        // naming the status. Never throws on an already-recovered task.
        if (current.status !== 'pending' && current.status !== 'completed') {
          return ok({
            recovered: false,
            action: 'noop',
            task_id: task.id,
            status: current.status,
            reason: `task is "${current.status}" — not in a recoverable (pending/completed) state`,
            ...sweepResult,
          });
        }

        // Pending with no commit: the work isn't there to recover — directive.
        if (!commitSha) {
          return ok({
            recovered: false,
            action: 're-dispatch',
            task_id: task.id,
            reason: 'no commit on a pending task — re-dispatch SWE',
            ...sweepResult,
          });
        }

        const now = nowISO();
        const result = db.transaction(() => {
          // task_recovered audit row — records the deterministic recovery.
          insertAudit(db, {
            issue_id: task.issue_id,
            branch_id: task.branch_id,
            from_node: 'bro',
            event_type: 'task_recovered',
            summary: `Recovered stuck-${current.status} task ${task.id} at ${commitSha}`,
            content_json: JSON.stringify({ task_id: task.id, commit_sha: commitSha, prior_status: current.status }),
            created_at: now,
          });
          return closeTaskInTx(db, task, commitSha!, verificationSummary, now, closeIssueIfLast, 'task_recover');
        });

        const remote = result.issue_closed
          ? await syncIssueCloseRemotes(db, dbPath, task.issue_id, args['_spawnFn'] as SpawnFn | undefined)
          : undefined;

        return ok({
          recovered: true,
          action: 'closed',
          task_id: task.id,
          commit_sha: commitSha,
          issue_closed: result.issue_closed,
          review_gate_bypassed: result.review_gate_bypassed,
          ...(result.issue_left_open ? { issue_left_open: result.issue_left_open } : {}),
          ...(remote ? { remote } : {}),
          ...sweepResult,
        });
      }),
    ),
  };

  return { definitions, handlers };
}
