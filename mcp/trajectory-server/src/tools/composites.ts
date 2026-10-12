import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import { normalizeAgent, requireRoles } from '../middleware/agent-scope.js';
import { BRANCH_ID_RE, SPEC_BODY_MAX_BYTES } from './tasks.js';
import { insertDiscussion } from './discussions.js';
import { insertAudit } from './audit.js';
import {
  claudeRunContext,
  closeOpenRunsForTask,
  openBroRun,
  openSweRun,
  parseRunSessionId,
  RUN_SESSION_ID_SCHEMA,
  sweepRunsOfTerminalTasks,
  type RunContext,
} from './agent-runs.js';
import { outsideProject } from './containment.js';
import { closedTasksWithoutReview, liveTasksOfIssue, recordReviewBypassIfUnreviewed, sweepStaleTasks } from './lifecycle.js';
import {
  syncIssueCloseRemotes,
  resolveDefaultMilestone,
  milestoneDefaultFields,
  validateIssueLabels,
  defaultSyncLabels,
} from './issues.js';
import { defaultSpawnFn, type SpawnFn } from '../sync/issue_sync.js';
import { resolveMilestoneTargets } from './milestones.js';
import type { GraphHolder } from '../graph-db.js';
import { SUBPROCESS_TIMEOUT_MS } from '../utils/timeouts.js';
import { resolveSoleRepo } from '../utils/repo-paths.js';
import { resolve, dirname } from 'node:path';
import type { TaskProvisionInput } from '../types.js';

const WORKTREE_TIMEOUT_MS = 60_000;

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

// Close-time files[] scope gate (#157): diff the commit's cumulative changed
// files (baseRef...commitSha, three-dot → auto merge-base) against the task's
// typed files[] and return the paths NOT covered. Coverage: a files[] entry
// ending in '/' (or one that resolves to a directory under it) matches any path
// beneath it (prefix); otherwise an exact path match. `checked:false` + a reason
// when git can't resolve the repo or commit (caller fails CLOSED).
export function scopeCheckCommit(
  repoPath: string,
  baseRef: string,
  commitSha: string,
  files: readonly string[],
): { outOfScope: string[]; checked: boolean; reason?: string } {
  let diffOut: string;
  try {
    diffOut = execFileSync(
      'git',
      ['-C', repoPath, 'diff', '--name-only', `${baseRef}...${commitSha}`],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: SUBPROCESS_TIMEOUT_MS },
    ).toString();
  } catch (e) {
    return {
      outOfScope: [],
      checked: false,
      reason: (e as Error).message.split('\n')[0] || 'git diff failed',
    };
  }

  const changed = diffOut
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Build the coverage matchers. A files[] entry that names a directory (ends in
  // '/') becomes a prefix matcher; every entry doubles as an exact-path matcher.
  // filesToDirs gives the per-file parent dirs but we want the entries
  // themselves, so derive prefixes directly.
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const entry of files) {
    if (entry.endsWith('/')) {
      prefixes.push(entry);
    } else {
      exact.add(entry);
      prefixes.push(`${entry}/`);
    }
  }

  const outOfScope = changed.filter((path) => {
    if (exact.has(path)) return false;
    return !prefixes.some((p) => path.startsWith(p));
  });

  return { outOfScope, checked: true };
}

// Resolve a task's repo to its on-disk path (repos.path; relative → resolved
// against the trajectory DB's directory). Sole-repo fallback applies when the
// task has no explicit repo. Returns null when no repo can be resolved.
export function resolveRepoPath(db: TrajectoryDB, repoValue: string | null): string | null {
  const name = repoValue && repoValue.length > 0 ? repoValue : resolveSoleRepo(db)?.name ?? null;
  if (!name) return null;
  const reposRow = db.get<{ path: string }>(`SELECT path FROM repos WHERE name = ?`, [name]);
  if (!reposRow) return name;
  const dbDir = db.dbPath === ':memory:' ? process.cwd() : dirname(db.dbPath);
  return reposRow.path.startsWith('/') ? reposRow.path : resolve(dbDir, reposRow.path);
}

// Resolve a base branch name to a concrete git ref, preferring the freshest
// remote-tracking ref. Returns `origin/<base>` when it resolves (remote-present
// repos — freshest-origin doctrine unchanged), else the local `<base>` when
// refs/heads/<base> resolves (remoteless repos: L6 sandboxes, fresh local
// projects, local-only stacked bases), else null when neither exists.
function resolveBaseRef(repoPath: string, base: string): string | null {
  try {
    execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `origin/${base}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    return `origin/${base}`;
  } catch {
    // origin/<base> absent — fall back to the local branch.
  }
  try {
    execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${base}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    return base;
  } catch {
    return null;
  }
}

// Read a repo's target_branch (pr_target) from the repos table — the sole
// source of truth (#980). Falls back to the sole registered repo when repoValue
// is empty. Returns null when no row or a NULL/empty column.
function readRepoTargetBranch(db: TrajectoryDB, repoValue: string | null): string | null {
  const name = repoValue && repoValue.length > 0 ? repoValue : resolveSoleRepo(db)?.name ?? null;
  if (!name) return null;
  const row = db.get<{ target_branch: string | null }>(
    `SELECT target_branch FROM repos WHERE name = ?`,
    [name],
  );
  const v = row?.target_branch;
  return typeof v === 'string' && v.length > 0 ? v : null;
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

// Shared close path for bro_atomic_close + task_recover: in the caller's
// transaction, advance a task to closed (writing bro_verification_pass +
// finalizing the bro agent_run row) and optionally close the parent issue
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
): { issue_closed: boolean; issue_left_open: IssueLeftOpen | null; review_gate_bypassed: boolean } {
  // 1. bro_verification_pass audit row — the review anchor of this commit.
  insertAudit(db, {
    issue_id: task.issue_id,
    branch_id: task.branch_id,
    from_node: 'bro',
    event_type: 'bro_verification_pass',
    summary: verificationSummary.slice(0, 200),
    content_json: JSON.stringify({ task_id: task.id, commit_sha: commitSha }),
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

  // 3. flip task to closed.
  db.run(
    `UPDATE tasks
        SET status='closed', commit_sha=?, completed_at=COALESCE(completed_at, ?), updated_at=?
      WHERE id=?`,
    [commitSha, now, now, task.id],
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

function outsideProjectResult(refusal: NonNullable<ReturnType<typeof outsideProject>>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(refusal) }], isError: true };
}

// The worktree a task's swe runs in: <repo>/.claude/worktrees/<slug>, slug =
// the branch_id after its type prefix (task_provision's layout).
export function taskWorktreePath(repoPath: string, branchId: string): string {
  return `${repoPath}/.claude/worktrees/${branchId.replace(/^[^/]+\//, '')}`;
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

// Adds the task's worktree unless git already tracks one at that path (matched
// by realpath: `git worktree list --porcelain` emits canonicalized paths, e.g.
// /private/var/… for a /var/… symlink). Throws when `git worktree add` fails.
function ensureTaskWorktree(repoPath: string, branchId: string): { worktreePath: string; reused: boolean } {
  const worktreePath = taskWorktreePath(repoPath, branchId);
  let reused = false;
  if (existsSync(worktreePath)) {
    const canonicalWt = realpathSync(worktreePath);
    try {
      reused = git(repoPath, ['worktree', 'list', '--porcelain'])
        .split('\n')
        .some((l) => l.startsWith('worktree ') && l.slice('worktree '.length) === canonicalWt);
    } catch {
      reused = false;
    }
  }
  if (!reused) {
    git(repoPath, ['worktree', 'add', worktreePath, branchId], WORKTREE_TIMEOUT_MS);
  }
  return { worktreePath, reused };
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

const REOPENABLE_STATUSES = new Set(['closed', 'failed', 'escalated', 'running']);
const SPEC_AMENDABLE_STATUSES = new Set(['pending', 'running', 'needs_validation', 'completed']);

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
        'Heuristic-only branch_id derivation from free-text intent + objective, returning { branch_id, confidence }; pure, no DB writes.',
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
        "Retry composite — one transaction: reads the failed task, appends rationale, creates a " +
        "new task inheriting issue_id/parent_branch_id/repo (overridable). Returns the new task row.",
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
        'Interactive planning composite — atomically runs issue_create + discussion_append(intent) + ' +
        'discussion_append(note) + audit_append(branch_id_proposed). Git branch creation stays caller-side. ' +
        'Returns {issue_id, branch_id}.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          objective: { type: 'string', description: 'Short one-liner issue objective.' },
          intent_verbatim: { type: 'string', description: 'Human intent verbatim — stored as kind=intent discussion.' },
          branch_id: { type: 'string', description: 'Confirmed branch_id (from branch_id_propose + Human confirm).' },
          repo: { type: 'string', description: 'Optional repo name (matches a repos row) this issue belongs to. Defaults to the sole/managed repo when exactly one repos row exists. Mirrors issue_create.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Optional. When supplied, must include at least one priority label AND at least one classification label, drawn from the project\'s configured taxonomy (plugin_config issue_priority_labels / issue_classification_labels) or the generic default (priority: Priority: Urgent|High|Medium|Low; classification: Bug, Feature, Improvement, Docs, Test, Chore). Extra labels are allowed. When omitted, defaults to the first classification + first priority label of the taxonomy. Persisted on the issue row.' },
        },
        required: ['agent', 'objective', 'intent_verbatim', 'branch_id'],
      },
    },
    {
      name: 'bro_verification_fail_record',
      description:
        'V3-fail composite — atomically writes the audit_append + discussion_append that bro emits when a verification check fails.',
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
        'PR-review worktree composite — creates a per-SHA worktree at <repo_path>/.claude/worktrees/pr-review-<sha>, runs a caller-supplied command inside it, then removes the worktree atomically. A repo_path outside the project is refused with outside_project.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          commit_sha: { type: 'string', description: '7–40 hex SHA to check out.' },
          repo_path: {
            type: 'string',
            description: 'Absolute path to the git repo (CLAUDE_PLUGIN_ROOT or inner-repo root).',
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
        'Commit-reap composite — fetches each task\'s worktree HEAD into the main checkout under branch_id, returning { task_id, branch_id, commit_sha }[] ready for pr-reviewer spawn.',
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
      name: 'bro_atomic_close',
      description:
        'Bro task-close composite — writes bro_verification_pass, advances the task to closed, and optionally closes the parent issue, all in one DB transaction. ' +
        'Runs before pr-reviewer: the payload carries review_pending=true (spawn pr-reviewer next). ' +
        'close_issue_if_last_task applies the issue_close rules: it never closes the issue over a live sibling task (issue_left_open {reason: issue_has_open_tasks, tasks}) nor over a closed task, this one included, without a passing review (issue_left_open {reason: tasks_without_review, tasks, review_pending: true}); the issue then closes on merge or via issue_close after review. ' +
        'PostToolUse hooks fire on bro_atomic_close (not task_update_status).',
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
              'also close the issue in the same transaction; otherwise the issue stays open and issue_left_open says why. ' +
              'Before pr-reviewer has passed this task the issue stays open (tasks_without_review, review_pending).',
          },
          waive_scope_gate: {
            type: 'boolean',
            description:
              'When true, SKIP the server-side files[] scope gate (the close-time check that the ' +
              "commit's changed files all fall within the task's typed files[]) and record a waive " +
              'note. Use only when closing intentionally outside a resolvable git checkout, or when ' +
              'the out-of-scope paths are accepted. Default false (gate enforced, fail-closed).',
          },
        },
        required: ['agent', 'task_id', 'commit_sha', 'verification_summary'],
      },
    },
    {
      name: 'task_recover',
      description:
        'Bro task-recovery composite — deterministically recovers a SWE task left stuck pending/completed after the executor died: with a commit_sha it closes the task (and optionally the issue; a review_gate_bypassed audit row records a close with no passing pr-reviewer verdict), without one it returns a re-dispatch directive, and a non-recoverable status is an idempotent no-op. ' +
        'Every call also runs the stale sweep: running tasks with no open swe agent_runs row and updated_at older than TMB_STALE_RUNNING_HOURS (default 6) become failed (task_stale_swept audit row, open runs closed swept_stale); pending tasks older than 7 days are reported only; agent_runs rows still open on already-terminal tasks are closed. ' +
        'Returns {tasks_swept, runs_swept, reported} (plus the recovery result when task_id is given).',
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
        "Bro's atomic planning composite — collapses the pre-SWE setup into one call. Resolves the repo path, validates the base, and sets up the branch ref BEFORE committing, so a git-setup failure persists no orphan task row (the same branch_id retries cleanly). Branch policy: a new ref is created from base (git_setup 'created'); an existing local or origin ref that is an ancestor of / equal to the base tip is fast-forwarded and reused ('reused'); a diverged one is refused with branch_exists_diverged (ref, ahead/behind distance, open PRs) unless reuse_existing keeps it as-is ('reused'). DB transaction: writes a kind='decision' discussion + creates one task (the task_create_batch insert path, with planning_complete). Only the worktree is created after the commit (idempotent, fail-soft; worktree_reused reports an existing one). Returns the spawn-ready shape {task_id, branch_id, repo, slug, worktree_path, git_setup, worktree_reused, diagnostic?} so swe can be dispatched against an existing branch+worktree.",
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
            description: "Optional start-point for the branch ref. Defaults to the repo's target_branch || 'dev'.",
          },
          reuse_existing: {
            type: 'boolean',
            description: 'Keep an existing branch_id that has diverged from base as-is instead of refusing with branch_exists_diverged.',
          },
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
          task: {
            type: 'object',
            description: 'The single task spec.',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              spec_body: {
                type: 'string',
                description: `Full markdown body SWE reads; max ${SPEC_BODY_MAX_BYTES} chars. Must contain a ## Success Criteria H2.`,
              },
              files: {
                type: 'array',
                items: { type: 'string' },
                description: 'Authoritative allowlist of paths SWE may edit (swe-scope-fence hook).',
              },
              verification: {
                type: 'array',
                items: { type: 'string' },
                description: 'Authoritative shell commands the swe-verification-gate hook runs before SWE may complete.',
              },
              repo: {
                type: 'string',
                description: 'Optional relative path to this task\'s git repo (no ".." or leading "/"); omit for single-repo CC.',
              },
              prompt_bearing: {
                type: 'number',
                description: 'Set to 1 when this task intentionally edits prompt-surface files. Default 0.',
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
        "Rework a task in one call: moves a closed, failed, escalated or running task to running, appends files_add / verification_add to its files[] / verification[] fences, writes a kind='decision' discussion + a task_reopened audit row, opens a bro agent_runs row for the rework (reusing an open one; stamped with session_id when passed), and recreates the task's worktree when it is missing. Refused when the task's issue is closed. Returns {task_id, from_status, status, files, verification, worktree_path, worktree_recreated, diagnostic?}; spawn swe on the task next.",
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
          session_id: RUN_SESSION_ID_SCHEMA,
        },
        required: ['agent', 'task_id', 'reason'],
      },
    },
    {
      name: 'task_update_spec',
      description:
        "Amend a pending, running, needs_validation or completed task: replaces files[], verification[] and/or spec_body (each optional, at least one), writes a kind='decision' discussion + a task_spec_amended audit row with an old→new summary. The scope fence and verification gate read the amended values on their next run. Returns {task_id, changed, files, verification}.",
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
            description: `Replacement spec_body; max ${SPEC_BODY_MAX_BYTES} chars, must contain a ## Success Criteria H2.`,
          },
        },
        required: ['agent', 'task_id', 'reason'],
      },
    },
    {
      name: 'task_brief',
      description:
        "Full context bundle for one task in a single call — swe's only context read; joins the trajectory DB (task row, spec_body, the issue's discussion thread) with the kuzu world model for each directory the task's files[] touch. A swe call opens the task's swe agent_runs row when none is open.",
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          task_id: { type: 'number', description: 'Task id to assemble the brief for.' },
        },
        required: ['agent', 'task_id'],
      },
    },
  ];

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
        const sessionId = parseRunSessionId(args['session_id']);

        if (typeof issueId !== 'number' || !Number.isFinite(issueId)) {
          return err('issue_id must be a number');
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
        const verification = validateStrArray(task.verification, 'verification');

        let repoValue: string | null = null;
        if (task.repo !== undefined && task.repo !== null && task.repo !== '') {
          if (typeof task.repo !== 'string') return err('task.repo must be a string');
          if (task.repo.includes('..')) return err(`Invalid repo "${task.repo}": must not contain "..".`);
          if (task.repo.startsWith('/')) return err(`Invalid repo "${task.repo}": must not start with "/".`);
          repoValue = task.repo;
        } else {
          repoValue = resolveSoleRepo(db)?.name ?? null;
        }

        const promptBearing =
          typeof task.prompt_bearing === 'number' && task.prompt_bearing === 1 ? 1 : 0;

        const slug = branchId.replace(/^[^/]+\//, '');

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

        // --- GIT SETUP BEFORE THE COMMIT (atomic guarantee) ---
        // Resolve the repo path + base ref and create the branch ref BEFORE
        // writing the task row. A git failure here returns an error and
        // persists NOTHING, so the same (issue_id, branch_id) retries cleanly
        // — no orphan task row left occupying the UNIQUE constraint. A retry
        // after a partial failure finds the ref at the base tip and reuses
        // it. Only the worktree stays fail-soft (recoverable, post-commit).
        let repoPath: string | null = null;
        if (repoValue) {
          const reposRow = db.get<{ path: string }>(
            `SELECT path FROM repos WHERE name = ?`,
            [repoValue],
          );
          if (reposRow) {
            const dbDir = db.dbPath === ':memory:' ? process.cwd() : dirname(db.dbPath);
            repoPath = reposRow.path.startsWith('/') ? reposRow.path : resolve(dbDir, reposRow.path);
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
        for (const path of [repoPath, taskWorktreePath(repoPath, branchId)]) {
          const refusal = outsideProject('task_provision', runContext.projectRoot, path);
          if (refusal) return outsideProjectResult(refusal);
        }

        const base =
          (args['base'] as string | undefined) ??
          (readRepoTargetBranch(db, repoValue) ?? 'dev');

        // Branch policy: a new ref is created from the base ('created'); an
        // existing ref (local or origin) is reused only when it is an
        // ancestor of / equal to the base tip, fast-forwarded to it
        // ('reused'); a diverged ref is refused unless reuse_existing keeps it
        // as-is ('reused').
        const reuseExisting = args['reuse_existing'] === true;
        const localRef = `refs/heads/${branchId}`;
        const originRef = `refs/remotes/origin/${branchId}`;
        const localSha = refSha(repoPath, localRef);
        const originSha = refSha(repoPath, originRef);
        const branchExists = localSha !== null || originSha !== null;

        // Prefer origin/<base>, fall back to a local branch when no
        // remote-tracking ref exists (remoteless repos), error when neither
        // resolves — before anything is created.
        const resolvedBaseRef = resolveBaseRef(repoPath, base);
        if (!resolvedBaseRef && !(branchExists && reuseExisting)) {
          return err(
            `task_provision: base does not resolve as 'origin/${base}' or local '${base}' in repo '${repoValue}'. ` +
              `No task row was created — retry with a valid base and the same branch_id.`,
          );
        }
        const gitFailure = (what: string, e: unknown): CallToolResult =>
          err(
            `task_provision: ${what} in repo '${repoValue}' ` +
              `(${(e as Error).message.split('\n')[0] || 'git failed'}). No task row was created — ` +
              `retry with the same branch_id.`,
          );

        if (!branchExists) {
          try {
            git(repoPath, ['branch', branchId, resolvedBaseRef!]);
          } catch (e) {
            return gitFailure(`failed to create branch '${branchId}' from '${resolvedBaseRef}'`, e);
          }
        } else {
          const diverged = resolvedBaseRef
            ? [localSha ? localRef : null, originSha ? originRef : null]
                .filter((r): r is string => r !== null)
                .find((r) => !isAncestor(repoPath, r, resolvedBaseRef))
            : undefined;
          if (diverged && !reuseExisting) {
            const distance = refDistance(repoPath, resolvedBaseRef!, diverged);
            const openPrs = openChangeRequestsForBranch(
              db,
              repoValue,
              repoPath,
              branchId,
              args['_spawnFn'] as SpawnFn | undefined,
            );
            const prNote = openPrs.length > 0 ? ` Open PR/MR: ${openPrs.map((p) => p.url || `#${p.number}`).join(', ')}.` : '';
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: 'branch_exists_diverged',
                    branch_id: branchId,
                    ref: diverged,
                    base: resolvedBaseRef,
                    ahead: distance?.ahead ?? null,
                    behind: distance?.behind ?? null,
                    open_prs: openPrs,
                    message:
                      `task_provision: branch '${branchId}' already exists and '${diverged}' has diverged from '${resolvedBaseRef}' ` +
                      `(${distance ? `${distance.ahead} ahead, ${distance.behind} behind` : 'distance unknown'}).${prNote} ` +
                      `Pick a fresh branch_id (branch_id_propose), or pass reuse_existing: true to keep the existing branch as-is. ` +
                      `No task row was created.`,
                  }),
                },
              ],
            };
          }
          try {
            if (diverged || !resolvedBaseRef) {
              if (!localSha) git(repoPath, ['branch', branchId, originRef]);
            } else if (!localSha) {
              git(repoPath, ['branch', branchId, resolvedBaseRef]);
            } else if (localSha !== refSha(repoPath, resolvedBaseRef)) {
              const checkedOutAt = worktreeOfBranch(repoPath, branchId);
              if (checkedOutAt) git(checkedOutAt, ['merge', '--ff-only', '--quiet', resolvedBaseRef]);
              else git(repoPath, ['branch', '-f', branchId, resolvedBaseRef]);
            }
          } catch (e) {
            return gitFailure(`failed to fast-forward existing branch '${branchId}' to '${resolvedBaseRef ?? base}'`, e);
          }
        }

        // --- DB TRANSACTION (atomic) ---
        // The branch ref now exists. Write the decision (satisfies the decision
        // gate) + create the single task via the same INSERT path
        // task_create_batch uses, with the bro agent_run row +
        // planning_complete audit. The registry gate is enforced above; the
        // intent/scope/branch/spec gates are waived internally: this composite
        // IS bro's atomic planning, so those preconditions are subsumed here.
        // Any DB error rolls back the whole transaction.
        const now = nowISO();
        const result = db.transaction(() => {
          insertDiscussion(db, { issue_id: issueId, author: agent, kind: 'decision', body: decisionBody, created_at: now });

          db.run(
            `INSERT INTO tasks
               (issue_id, branch_id, parent_branch_id, title, description,
                status, spec_body, repo, prompt_bearing, files, verification, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
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
              now,
              now,
            ],
          );
          const row = db.get<{ id: number; branch_id: string; repo: string | null }>(
            'SELECT id, branch_id, repo FROM tasks WHERE rowid = last_insert_rowid()',
          );
          if (!row) throw new Error('task_provision: task insert succeeded but row lookup failed');

          openBroRun(db, { id: row.id, issue_id: issueId, repo: row.repo }, now, runContext, sessionId);

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

          return { task_id: row.id };
        });

        // --- WORKTREE SIDE-EFFECT AFTER THE COMMIT (fail-soft) ---
        // The branch ref + task row are committed; the worktree is the only
        // recoverable side-effect, so a failure here returns git_setup:'error'
        // + a diagnostic without rolling back the task — bro can retry the
        // worktree setup. Idempotent: an existing worktree is reused, not
        // re-created.
        let gitSetup: 'created' | 'reused' | 'error' = branchExists ? 'reused' : 'created';
        let worktreeReused = false;
        let diagnostic: string | undefined;
        const worktreePath = taskWorktreePath(repoPath, branchId);

        try {
          worktreeReused = ensureTaskWorktree(repoPath, branchId).reused;
        } catch (e) {
          gitSetup = 'error';
          diagnostic = (e as Error).message;
        }

        return ok({
          task_id: result.task_id,
          branch_id: branchId,
          repo: repoValue,
          slug,
          worktree_path: worktreePath,
          git_setup: gitSetup,
          worktree_reused: worktreeReused,
          ...(diagnostic ? { diagnostic } : {}),
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
        const sessionId = parseRunSessionId(args['session_id']);
        const filesAdd = validateFenceAdditions(args['files_add'], 'files_add');
        const verificationAdd = validateFenceAdditions(args['verification_add'], 'verification_add');

        const task = db.get<{
          id: number;
          issue_id: number;
          branch_id: string;
          status: string;
          files: string | null;
          verification: string | null;
          repo: string | null;
          issue_status: string;
        }>(
          `SELECT t.id, t.issue_id, t.branch_id, t.status, t.files, t.verification, t.repo, i.status AS issue_status
             FROM tasks t JOIN issues i ON i.id = t.issue_id WHERE t.id = ?`,
          [taskId],
        );
        if (!task) return err(`task_reopen: task ${taskId} not found`);
        if (!REOPENABLE_STATUSES.has(task.status)) {
          return err(
            `task_reopen: task ${taskId} is '${task.status}'; task_reopen moves closed, failed, escalated or running tasks. ` +
              `Amend a live task's spec with task_update_spec.`,
          );
        }
        if (task.issue_status === 'closed') {
          return err(`task_reopen: issue ${task.issue_id} is closed; track the rework under an open issue.`);
        }

        const repoPath = resolveRepoPath(db, task.repo);
        if (repoPath) {
          for (const path of [repoPath, taskWorktreePath(repoPath, task.branch_id)]) {
            const refusal = outsideProject('task_reopen', runContext.projectRoot, path);
            if (refusal) return outsideProjectResult(refusal);
          }
        }

        const files = appendUnique(parseTaskFiles(task.files), filesAdd);
        const verification = appendUnique(parseTaskFiles(task.verification), verificationAdd);
        const now = nowISO();
        db.transaction(() => {
          db.run(
            `UPDATE tasks SET status = 'running', files = ?, verification = ?, completed_at = NULL, updated_at = ? WHERE id = ?`,
            [JSON.stringify(files), JSON.stringify(verification), now, taskId],
          );
          const fenceLines = [
            filesAdd.length > 0 ? `files[] += ${filesAdd.join(', ')}` : null,
            verificationAdd.length > 0 ? `verification[] += ${verificationAdd.join(' ; ')}` : null,
          ].filter((l): l is string => l !== null);
          insertDiscussion(db, {
            issue_id: task.issue_id,
            author: agent,
            kind: 'decision',
            body: [`Task ${taskId} reopened from ${task.status}: ${reason}`, ...fenceLines].join('\n'),
            created_at: now,
          });
          insertAudit(db, {
            issue_id: task.issue_id,
            branch_id: task.branch_id,
            from_node: agent,
            event_type: 'task_reopened',
            summary: `Task ${taskId} reopened from ${task.status}: ${reason}`.slice(0, 200),
            content_json: JSON.stringify({
              task_id: taskId,
              from_status: task.status,
              reason,
              files_add: filesAdd,
              verification_add: verificationAdd,
            }),
            created_at: now,
          });
          const openBro = db.get<{ id: number }>(
            `SELECT id FROM agent_runs WHERE task_id = ? AND agent_type = 'bro' AND completed_at IS NULL LIMIT 1`,
            [taskId],
          );
          if (!openBro) openBroRun(db, { id: taskId, issue_id: task.issue_id, repo: task.repo }, now, runContext, sessionId);
        });

        let worktreePath: string | null = null;
        let worktreeRecreated = false;
        let diagnostic: string | undefined;
        if (repoPath) {
          try {
            if (!refSha(repoPath, `refs/heads/${task.branch_id}`) && refSha(repoPath, `refs/remotes/origin/${task.branch_id}`)) {
              git(repoPath, ['branch', task.branch_id, `refs/remotes/origin/${task.branch_id}`]);
            }
            const wt = ensureTaskWorktree(repoPath, task.branch_id);
            worktreePath = wt.worktreePath;
            worktreeRecreated = !wt.reused;
          } catch (e) {
            worktreePath = taskWorktreePath(repoPath, task.branch_id);
            diagnostic = (e as Error).message;
          }
        } else {
          diagnostic = `cannot resolve a repo path for task.repo='${task.repo ?? ''}'; worktree not checked`;
        }

        return ok({
          task_id: taskId,
          from_status: task.status,
          status: 'running',
          files,
          verification,
          worktree_path: worktreePath,
          worktree_recreated: worktreeRecreated,
          ...(diagnostic ? { diagnostic } : {}),
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
          if (!/^## Success Criteria\s*$/m.test(newSpec)) {
            return err('spec_body must contain a ## Success Criteria H2 section.');
          }
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
        }>(`SELECT id, issue_id, branch_id, status, files, verification, spec_body FROM tasks WHERE id = ?`, [taskId]);
        if (!task) return err(`task_update_spec: task ${taskId} not found`);
        if (!SPEC_AMENDABLE_STATUSES.has(task.status)) {
          return err(
            `task_update_spec: task ${taskId} is '${task.status}'; only pending, running, needs_validation or completed tasks ` +
              `are amended. Reopen a closed, failed or escalated task with task_reopen (files_add / verification_add).`,
          );
        }

        const oldFiles = parseTaskFiles(task.files);
        const oldVerification = parseTaskFiles(task.verification);
        const diffSummary = (oldList: string[], newList: string[]) => ({
          added: newList.filter((x) => !oldList.includes(x)),
          removed: oldList.filter((x) => !newList.includes(x)),
        });
        const changes: Record<string, unknown> = {};
        if (newFiles !== undefined) changes['files'] = diffSummary(oldFiles, newFiles);
        if (newVerification !== undefined) changes['verification'] = diffSummary(oldVerification, newVerification);
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

        const files = newFiles ?? oldFiles;
        const verification = newVerification ?? oldVerification;
        const now = nowISO();
        db.transaction(() => {
          db.run(
            `UPDATE tasks SET files = ?, verification = ?, spec_body = ?, updated_at = ? WHERE id = ?`,
            [JSON.stringify(files), JSON.stringify(verification), newSpec ?? task.spec_body, now, taskId],
          );
          insertDiscussion(db, {
            issue_id: task.issue_id,
            author: agent,
            kind: 'decision',
            body: `Task ${taskId} spec amended (${summaryParts.join('; ')}): ${reason}`,
            created_at: now,
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

        return ok({ task_id: taskId, changed, files, verification });
      }),
    ),

    task_brief: requireRoles(
      'task_brief',
      ['bro', 'swe', 'pr-reviewer'],
      wrap(async (args) => {
        const taskId = args['task_id'];
        if (taskId === undefined || taskId === null) return err('task_id is required');

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
          objective: string;
        }>(
          `SELECT t.id, t.issue_id, t.branch_id, t.title, t.status, t.spec_body, t.files, t.verification, t.commit_sha, t.repo,
                  i.objective
             FROM tasks t JOIN issues i ON i.id = t.issue_id
            WHERE t.id = ? LIMIT 1`,
          [taskId],
        );
        if (!task) return err(`No task with id=${taskId}`);

        if (normalizeAgent(args['agent'] as string | undefined) === 'swe') {
          const repoPath = resolveRepoPath(db, task.repo);
          openSweRun(db, task, nowISO(), runContext, repoPath?.startsWith('/') ? taskWorktreePath(repoPath, task.branch_id) : null);
        }

        // Resolve repo: task.repo, else the single-repo fallback (path-keyed
        // resolution — empty in multi-repo projects, which scope by task.repo).
        let repo = task.repo ?? '';
        if (!repo) {
          repo = resolveSoleRepo(db)?.name ?? '';
        }

        // Scope: the dirs the task's typed files[] touch, resolved in the world model.
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

        // The task issue's own discussion thread (intent / decision / notes).
        // Bound it: keep decision/intent rows full (load-bearing scope the
        // executor must obey verbatim); cap other kinds to the last few and
        // truncate their bodies, with a pointer to discussion_search for the
        // full text. This is the unbounded-growth term in the brief — paid on
        // every swe/pr-reviewer spawn for a long-lived issue.
        // #1026: window the NEWEST 200 rows (DESC LIMIT), then reverse to
        // chronological order for display. An ASC LIMIT 200 would drop the
        // latest decision/intent rows on issues with >200 discussions — the
        // exact rows the executor must obey.
        const raw = db.all<{
          author: string;
          kind: string;
          body: string;
          created_at: string;
        }>(
          `SELECT author, kind, body, created_at FROM discussions
            WHERE issue_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`,
          [task.issue_id],
        ).reverse();

        const FULL_KINDS = new Set(['decision', 'intent']);
        const NOTE_CAP = 500;
        const OTHER_ROW_CAP = 8;
        const full = raw.filter((d) => FULL_KINDS.has(d.kind));
        const other = raw.filter((d) => !FULL_KINDS.has(d.kind)).slice(-OTHER_ROW_CAP);
        const task_discussions = raw
          .filter((d) => full.includes(d) || other.includes(d))
          .map((d) => {
            if (FULL_KINDS.has(d.kind) || d.body.length <= NOTE_CAP) return d;
            return {
              ...d,
              body:
                d.body.slice(0, NOTE_CAP) +
                `\n… [truncated; discussion_search(issue_id=${task.issue_id}) for full text]`,
              truncated: true,
            };
          });

        return ok({
          task_id: task.id,
          issue_id: task.issue_id,
          branch_id: task.branch_id,
          title: task.title,
          objective: task.objective,
          status: task.status,
          commit_sha: task.commit_sha,
          repo,
          spec_body: task.spec_body,
          files: parseTaskFiles(task.files),
          verification: parseTaskFiles(task.verification),
          scope_world_model,
          ...(world_model_warning ? { world_model_warning } : {}),
          task_discussions,
        });
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
        const failedTaskId = args['failed_task_id'] as string;
        const newBranchId = args['new_branch_id'] as string;
        const spec = args['corrected_spec_body'] as string;
        const rationale = args['retry_rationale'] as string;
        const description = args['description'] as string;
        const title = (args['title'] as string | undefined) ?? '';
        const repoOverride = (args['repo'] as string | undefined) ?? null;
        const sessionId = parseRunSessionId(args['session_id']);

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
        }>(
          `SELECT id, issue_id, branch_id, parent_branch_id, repo, status,
                  files, verification, prompt_bearing
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

        // --- Retry cap gate ---
        // Walk the task_retry_attempted audit chain: each hop in the chain
        // is one retry. The chain is stored in audit.content_json as
        // {failed_task_id, new_task_id, ...}. Starting from failed_task_id,
        // count how many times we can walk backwards via new_task_id to find
        // a prior task_retry_attempted row that produced it. A depth of 3
        // means we've already retried 3 times; a 4th is rejected.
        //
        // No new column needed: the linkage already exists in audit rows.
        {
          const RETRY_CAP = 3;
          let depth = 0;
          let currentTaskId = Number(failedTaskId);
          while (depth < RETRY_CAP + 1) {
            const row = db.get<{ failed_task_id: number; content_json: string }>(
              `SELECT content_json FROM audit
                WHERE event_type = 'task_retry_attempted'
                  AND json_extract(content_json, '$.new_task_id') = ?
                LIMIT 1`,
              [currentTaskId],
            );
            if (!row) break;
            const parsed = JSON.parse((row as unknown as { content_json: string }).content_json) as {
              failed_task_id: number;
            };
            currentTaskId = parsed.failed_task_id;
            depth++;
          }
          if (depth >= RETRY_CAP) {
            return err(
              `retry limit reached (3) — escalate to Human. ` +
              `Task ${failedTaskId} already has ${depth} prior attempt(s) in its retry lineage. ` +
              `Use discussion_append(kind='question') to involve the Human before retrying further.`,
            );
          }
        }

        const now = nowISO();
        const result = db.transaction(() => {
          insertDiscussion(db, {
            issue_id: failed.issue_id,
            author: 'bro',
            kind: 'decision',
            body: `Retry rationale (failed task ${failedTaskId}): ${rationale}`,
            created_at: now,
          });

          db.run(
            `INSERT INTO tasks
               (issue_id, branch_id, parent_branch_id, title, description,
                status, spec_body, repo, prompt_bearing, files, verification, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
            [
              failed.issue_id,
              newBranchId,
              failed.parent_branch_id ?? failed.branch_id,
              title,
              description,
              spec,
              repoOverride ?? failed.repo,
              failed.prompt_bearing,
              failed.files,
              failed.verification,
              now,
              now,
            ],
          );

          const newTask = db.get<{ id: number; branch_id: string; repo: string | null }>(
            'SELECT id, branch_id, repo FROM tasks WHERE rowid = last_insert_rowid()',
          );
          if (!newTask) throw new Error('insert succeeded but row lookup failed');

          // Bro-as-agent_run (#2886): open a bro row for the retry task,
          // mirror of the task_create_batch case.
          openBroRun(db, { id: newTask.id, issue_id: failed.issue_id, repo: newTask.repo }, now, runContext, sessionId);

          insertAudit(db, {
            issue_id: failed.issue_id,
            branch_id: newBranchId,
            from_node: 'bro',
            event_type: 'task_retry_attempted',
            summary: `Retry of failed task ${failedTaskId}: ${rationale.slice(0, 120)}`,
            content_json: JSON.stringify({
              failed_task_id: failed.id,
              new_task_id: newTask.id,
              new_branch_id: newBranchId,
            }),
            created_at: now,
          });

          return newTask;
        });

        return ok({ task_id: result.id, branch_id: result.branch_id });
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
        if (suppliedLabels !== undefined) {
          const labelError = validateIssueLabels(db, suppliedLabels);
          if (labelError !== null) return err(labelError);
        }
        const labels = suppliedLabels ?? defaultSyncLabels(db);

        const now = nowISO();
        // Resolve the issue's repo (explicit arg, else the sole registered repo)
        // so the milestone default + FK insert bind to the right repo (#15).
        const issueRepo = explicitRepo ?? resolveSoleRepo(db)?.name ?? null;
        const milestoneResolution = resolveDefaultMilestone(db, null, issueRepo);
        const milestone = milestoneResolution.milestone;
        const result = db.transaction(() => {
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
      ['pr-reviewer'],
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
        const wtPath = `${repoPath}/.claude/worktrees/pr-review-${commitSha}`;
        let stdout = '';
        let stderr = '';
        let exitCode = 0;

        try {
          execFileSync('git', ['-C', repoPath, 'worktree', 'add', wtPath, commitSha], {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: WORKTREE_TIMEOUT_MS,
          });
        } catch (e) {
          return err(`worktree add failed: ${(e as Error).message}`);
        }

        try {
          const result = execFileSync('bash', ['-c', command], {
            cwd: wtPath,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 60_000,
          });
          stdout = result.toString('utf8');
        } catch (e: unknown) {
          const spawnErr = e as { stdout?: Buffer; stderr?: Buffer; status?: number; message?: string };
          stdout = spawnErr.stdout?.toString('utf8') ?? '';
          stderr = spawnErr.stderr?.toString('utf8') ?? spawnErr.message ?? '';
          exitCode = spawnErr.status ?? 1;
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

        const passed = exitCode === 0;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                worktree: wtPath,
                exit_code: exitCode,
                passed,
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
          const task = db.get<{ id: number; branch_id: string; commit_sha: string | null }>(
            'SELECT id, branch_id, commit_sha FROM tasks WHERE id = ? LIMIT 1',
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
          // root) — that is where ensure-swe-worktree.sh creates it. A worktree's
          // `.git` is a file (a gitdir pointer), not a fetchable remote, so do
          // NOT fetch from it: the worktree shares the main repo's object store,
          // so the commit is already present here. When commit_sha is known,
          // point the branch ref at it directly (update-ref); otherwise read the
          // worktree's detached HEAD and set the ref to that. (#156)
          const wtPath = `${repoPath}/.claude/worktrees/${slug}`;
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

    bro_atomic_close: requireRoles(
      'bro_atomic_close',
      ['bro'],
      wrap(async (args) => {
        const taskId = args['task_id'] as string;
        if (!taskId) return err('Missing required arg: task_id');

        const commitSha = ((args['commit_sha'] as string | undefined) ?? '').toLowerCase();
        if (!commitSha || !/^[0-9a-f]{7,40}$/.test(commitSha)) {
          return err('commit_sha must be a 7..40-char hex SHA.');
        }

        const verificationSummary = args['verification_summary'];
        if (verificationSummary === undefined || verificationSummary === null) {
          return err('Missing required arg: verification_summary');
        }
        if (typeof verificationSummary !== 'string') {
          return err('verification_summary must be a string');
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
          'SELECT id, issue_id, branch_id, parent_branch_id, status, commit_sha, repo, files FROM tasks WHERE id = ? LIMIT 1',
          [taskId],
        );
        if (!task) return err(`No task with id=${taskId}`);
        if (task.status !== 'completed' && task.status !== 'needs_validation') {
          return err(
            `Task ${taskId} status is "${task.status}", expected "completed" or "needs_validation". ` +
              `bro_atomic_close runs after SWE flips status to completed.`,
          );
        }

        // --- Close-time files[] scope gate (#157) ---
        // Deterministic, un-skippable: diff the commit's cumulative changes
        // against the task's typed files[] and REFUSE to close on any
        // out-of-scope path. Fail-CLOSED when the repo/commit can't be resolved.
        // waive_scope_gate=true skips the gate and records an audit note.
        // task_recover's shared close path is intentionally NOT gated.
        const now = nowISO();

        if (!waiveScopeGate) {
          const repoPath = resolveRepoPath(db, task.repo);
          const base = task.parent_branch_id || 'dev';
          const baseRef = repoPath ? resolveBaseRef(repoPath, base) : null;
          const scope =
            repoPath && baseRef
              ? scopeCheckCommit(repoPath, baseRef, commitSha, parseTaskFiles(task.files))
              : {
                  outOfScope: [],
                  checked: false,
                  reason: repoPath
                    ? `base does not resolve as 'origin/${base}' or local '${base}'`
                    : `cannot resolve a path for repo '${task.repo ?? ''}'`,
                };

          if (!scope.checked) {
            return err(
              `bro_atomic_close scope gate: cannot resolve ${task.repo ?? '<repo>'}@${commitSha} to verify ` +
                `files[] scope (${scope.reason ?? 'unknown'}). Pass waive_scope_gate=true if this close ` +
                `is intentional outside a git checkout.`,
            );
          }
          if (scope.outOfScope.length > 0) {
            return err(
              `bro_atomic_close scope gate: these committed files are outside the task's files[] fence: ` +
                `${scope.outOfScope.join(', ')}. Add them to files[] (re-plan) or revert them, then retry. ` +
                `Pass waive_scope_gate=true to override.`,
            );
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
              summary: `bro_atomic_close scope gate waived for task ${task.id}`,
              content_json: JSON.stringify({ skill: 'bro_atomic_close', task_id: task.id, commit_sha: commitSha }),
              created_at: now,
            });
          }
          const closed = closeTaskInTx(db, task, commitSha, verificationSummary, now, closeIssueIfLast);
          return {
            task_id: task.id,
            issue_closed: closed.issue_closed,
            review_pending: true,
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
