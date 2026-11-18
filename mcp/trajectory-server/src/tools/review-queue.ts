// review_queue: the closed agile tasks still waiting for code review, grouped by overlapping declared files[].
// review_batch_record: code-reviewer's one verdict on a group of them.
// review_waive_record: the Human's waiver of that review for a feature branch, recorded by bro.
// review_batch_handoff: bro's hand-off of one such group at the feature-branch tip, its close lints and verification-defaults suite run there.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import {
  closeLintsPlan,
  type CloseLintsRun,
  describeFailures,
  LINT_TIMED_OUT,
  runBashKilledAt,
  runCloseLints,
  tailLines,
} from '../hooks/lib/close-lints.js';
import { joinToolchainPath, parseBudget, toolchainDirs } from '../hooks/swe-verification-gate.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { AGILE_PENDING_REVIEW_SQL, AGILE_QUEUED_SQL, batchReviewedSql, featureBranchTaskSql, reviewBatchKey, waivedSql } from '../review-sql.js';
import { batchReviewerSpawn, type ReviewerSpawn } from '../reviewer-effort.js';
import { isStoredAgile } from '../stored-mode.js';
import { acquireSuiteSlot, describeHolder, isFullSuite, SUITE_LOCK_HELD_ENV } from '../suite-lock.js';
import { DONE, inGroup } from '../task-states.js';
import { diffNameStatus, isAncestor, mergeBase, revParseCommit } from '../utils/git-objects.js';
import { resolveBaseRef } from '../utils/git-refs.js';
import { runGitAsync } from '../utils/git-run.js';
import { repoRowPath, repoTargetBase } from '../utils/repo-paths.js';
import { prepareWorktreeDeps } from '../utils/worktree-deps.js';
import { describeSetupFailure, runWorktreeSetup } from '../utils/worktree-setup.js';
import { parseRunSessionId, RUN_SESSION_ID_SCHEMA } from './agent-runs.js';
import { insertAudit } from './audit.js';
import { resolveEffortDefaults } from './config.js';
import { readVerificationDefaults, VERIFICATION_DEFAULTS_FILE } from './verification-defaults.js';
import {
  REVIEWER_OBSERVATION_TTL_S,
  REVIEWER_OBSERVE_FROM_NODE,
  observationAgeS,
  observedReviewer,
  parseFinding,
  type FindingInput,
} from './validation.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

interface QueuedTaskRow {
  id: number;
  issue_id: number;
  branch_id: string;
  commit_sha: string | null;
  base_sha: string | null;
  updated_at: string;
  files: string;
  repo?: string | null;
}

export interface QueuedTask {
  id: number;
  issue_id: number;
  branch_id: string;
  commit_sha: string | null;
  updated_at: string;
}

export interface ReviewGroup {
  tasks: QueuedTask[];
  files: string[];
  base: string | null;
  head: string | null;
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

// The tasks pending review (AGILE_PENDING_REVIEW_SQL), the set the batch
// hand-off, the waiver and the merge gate read, on the task's stamped mode (not
// the current plugin_config.workflow_mode), so a switch to truest keeps the queue.
// A task with no repo on record is listed under every repo, as
// featureBranchTaskSql places it. updated_at is normalized to ms-ISO so legacy
// rows order by time.
const QUEUE_SQL = `SELECT t.id, t.issue_id, t.branch_id, t.commit_sha, t.base_sha, t.files,
         COALESCE(t.repo, i.repo) AS repo, strftime('%Y-%m-%dT%H:%M:%fZ', t.updated_at) AS updated_at
    FROM tasks t LEFT JOIN issues i ON i.id = t.issue_id
   WHERE ${AGILE_PENDING_REVIEW_SQL}
     AND (:repo IS NULL OR COALESCE(t.repo, i.repo, :repo) = :repo)
     AND (:branch IS NULL OR ${featureBranchTaskSql('t', ':branch', ':repo')})
   ORDER BY t.id`;

function declaredFiles(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f): f is string => typeof f === 'string' && f.length > 0).map((f) => f.replace(/\/+$/, ''));
  } catch {
    return [];
  }
}

/** Equal paths, or one a path-prefix of the other at a `/` boundary. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Connected components of the tasks under declared-files overlap within one repo, ordered by lowest task id. */
export function groupQueuedTasks(rows: readonly QueuedTaskRow[]): ReviewGroup[] {
  const sorted = [...rows].sort((x, y) => x.id - y.id);
  const files = sorted.map((r) => declaredFiles(r.files));
  const sameRepo = (i: number, j: number): boolean => (sorted[i].repo ?? null) === (sorted[j].repo ?? null);
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (find(i) === find(j) || !sameRepo(i, j)) continue;
      if (files[i].some((a) => files[j].some((b) => pathsOverlap(a, b)))) parent[find(j)] = find(i);
    }
  }

  const members = new Map<number, number[]>();
  sorted.forEach((_, i) => {
    const root = find(i);
    members.set(root, [...(members.get(root) ?? []), i]);
  });

  return [...members.values()]
    .map((idx) => {
      const tasks = idx.map((i) => sorted[i]);
      const newest = tasks.reduce((a, b) => (b.updated_at > a.updated_at || (b.updated_at === a.updated_at && b.id > a.id) ? b : a));
      return {
        tasks: tasks.map(({ id, issue_id, branch_id, commit_sha, updated_at }) => ({ id, issue_id, branch_id, commit_sha, updated_at })),
        files: [...new Set(idx.flatMap((i) => files[i]))].sort(),
        base: tasks[0].base_sha ?? null,
        head: newest.commit_sha ?? null,
      };
    })
    .sort((a, b) => a.tasks[0].id - b.tasks[0].id);
}

const BATCH_VERDICTS = ['pass', 'fail'] as const;
type BatchVerdict = (typeof BATCH_VERDICTS)[number];
const HEAD_SHA_RE = /^[0-9a-f]{7,64}$/i;

interface RefusedTask {
  task_id: number;
  reason: string;
  shares_with?: number[];
  files?: string[];
}

/** A refused review_batch_handoff, review_batch_record or review_waive_record call; nothing is written. */
class BatchRefused extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly tasks?: readonly RefusedTask[],
    readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

interface BatchArgs {
  taskIds: number[];
  featureBranch: string;
  headSha: string;
  batchHandoffId: number;
  verdict: BatchVerdict;
  findings: FindingInput[] | null;
}

/** The task_ids arg, deduplicated and sorted ascending. */
function parseTaskIds(rawIds: unknown): number[] {
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new BatchRefused('invalid_args', 'task_ids must be a non-empty array of task ids');
  }
  const taskIds = rawIds.map(positiveInt);
  if (!taskIds.every((n): n is number => n !== null)) {
    throw new BatchRefused('invalid_args', `task_ids must be positive integers; got ${JSON.stringify(rawIds)}`);
  }
  return [...new Set(taskIds)].sort((a, b) => a - b);
}

function positiveInt(v: unknown): number | null {
  const n = typeof v === 'number' || (typeof v === 'string' && /^[0-9]+$/.test(v)) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function parseFeatureBranch(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BatchRefused('invalid_args', 'feature_branch must be a non-empty string');
  }
  return value.trim();
}

function parseBatchArgs(args: Record<string, unknown>): BatchArgs {
  const taskIds = parseTaskIds(args['task_ids']);
  const featureBranch = parseFeatureBranch(args['feature_branch']);
  const batchHandoffId = positiveInt(args['batch_handoff_id']);
  if (batchHandoffId === null) {
    throw new BatchRefused('invalid_args', 'batch_handoff_id must be the positive integer id review_batch_handoff returned');
  }
  const headSha = args['head_sha'];
  if (typeof headSha !== 'string' || !HEAD_SHA_RE.test(headSha)) {
    throw new BatchRefused('invalid_args', 'head_sha must be a 7-64 hex commit SHA');
  }
  const verdict = args['verdict'];
  if (!BATCH_VERDICTS.includes(verdict as BatchVerdict)) {
    throw new BatchRefused('invalid_args', `verdict must be one of ${BATCH_VERDICTS.join(', ')}; got ${JSON.stringify(verdict)}`);
  }
  const rawFindings = args['findings'];
  let findings: FindingInput[] | null = null;
  if (rawFindings !== undefined && rawFindings !== null) {
    if (!Array.isArray(rawFindings)) throw new BatchRefused('invalid_args', 'findings must be an array');
    try {
      findings = rawFindings.map((item, i) => parseFinding(item, i));
    } catch (e) {
      throw new BatchRefused('invalid_args', (e as Error).message);
    }
  }
  return {
    taskIds,
    featureBranch,
    headSha: headSha.toLowerCase(),
    batchHandoffId,
    verdict: verdict as BatchVerdict,
    findings,
  };
}

const HANDOFF_SQL = `SELECT json_extract(content_json, '$.task_ids') AS task_ids,
         json_extract(content_json, '$.head_sha') AS head_sha,
         json_extract(content_json, '$.feature_branch') AS feature_branch,
         json_extract(content_json, '$.repo') AS repo
    FROM audit
   WHERE id = ? AND event_type = 'review_batch_handoff' AND from_node = 'bro' AND json_valid(content_json)`;

interface HandoffRow {
  task_ids: string | null;
  head_sha: string | null;
  feature_branch: string | null;
  repo: string | null;
}

/** The feature branch's current tip in the repo of the cited hand-off, or why it does not resolve. */
interface FeatureTip {
  sha: string | null;
  where: string;
}

// Runs git, so recordBatch reads it before the write transaction opens.
function handedOffTip(db: TrajectoryDB, batch: BatchArgs): FeatureTip {
  const ref = `refs/heads/${batch.featureBranch}`;
  const row = db.get<HandoffRow>(HANDOFF_SQL, [batch.batchHandoffId]);
  const path = row?.repo ? db.get<{ path: string }>('SELECT path FROM repos WHERE name = ?', [row.repo])?.path : undefined;
  if (!path) return { sha: null, where: `repo ${JSON.stringify(row?.repo ?? null)} has no repos row` };
  const repoPath = repoRowPath(db, path);
  return { sha: revParseCommit(repoPath, ref), where: `${ref} in ${repoPath}` };
}

// Why the cited review_batch_handoff row does not hand off this exact call at
// the feature branch's current tip, or null.
function handoffRefusal(db: TrajectoryDB, batch: BatchArgs, tip: FeatureTip): BatchRefused | null {
  const row = db.get<HandoffRow>(HANDOFF_SQL, [batch.batchHandoffId]);
  if (!row) {
    return new BatchRefused(
      'batch_handoff_unknown',
      `no bro review_batch_handoff audit row has id ${batch.batchHandoffId}; review the group bro handed off with review_batch_handoff and cite its batch_handoff_id.`,
    );
  }
  let handedOff: number[] = [];
  try {
    const parsed: unknown = JSON.parse(row.task_ids ?? '[]');
    if (Array.isArray(parsed)) handedOff = [...new Set(parsed.map(positiveInt).filter((n): n is number => n !== null))].sort((a, b) => a - b);
  } catch {
    /* an unreadable task list matches no call */
  }
  const mismatches: string[] = [];
  if (handedOff.join(',') !== batch.taskIds.join(',')) mismatches.push(`task_ids [${handedOff.join(', ')}] handed off, [${batch.taskIds.join(', ')}] given`);
  if ((row.head_sha ?? '').toLowerCase() !== batch.headSha) mismatches.push(`head_sha ${row.head_sha} handed off, ${batch.headSha} given`);
  if (row.feature_branch !== batch.featureBranch) mismatches.push(`feature_branch ${row.feature_branch} handed off, ${batch.featureBranch} given`);
  if (mismatches.length > 0) {
    return new BatchRefused('batch_handoff_mismatch', `review_batch_handoff ${batch.batchHandoffId} does not match this call: ${mismatches.join('; ')}.`);
  }
  if (tip.sha?.toLowerCase() === batch.headSha) return null;
  return new BatchRefused(
    'head_moved',
    `${tip.where} is ${tip.sha ?? 'unresolved'}, not head_sha ${batch.headSha}: the feature branch moved since review_batch_handoff ${batch.batchHandoffId}; bro hands the group off again at the new tip.`,
  );
}

interface BatchObservation {
  id: number;
  session_id: string | null;
  agent_id: string | null;
  observed_at: string | null;
}

// The newest unconsumed, unsuperseded observation of this exact call (its
// reviewBatchKey), as validation_record reads its own by (task_id, attempt_n).
const BATCH_OBSERVATION_SQL = `SELECT id,
         json_extract(content_json, '$.session_id') AS session_id,
         json_extract(content_json, '$.agent_id') AS agent_id,
         COALESCE(json_extract(content_json, '$.observed_at'), created_at) AS observed_at
    FROM audit
   WHERE event_type = 'reviewer_identity_observed' AND from_node = ? AND json_valid(content_json)
     AND json_extract(content_json, '$.batch_key') = ?
     AND COALESCE(json_extract(content_json, '$.consumed'), 0) = 0
     AND COALESCE(json_extract(content_json, '$.superseded'), 0) = 0
   ORDER BY id DESC LIMIT 1`;

const CONSUME_BATCH_OBSERVATIONS_SQL = `UPDATE audit
     SET content_json = CASE WHEN id = :consumed THEN json_set(content_json, '$.consumed', 1)
       ELSE json_set(content_json, '$.superseded', 1, '$.superseded_by', :consumed, '$.superseded_at', :now) END
   WHERE event_type = 'reviewer_identity_observed' AND from_node = :from_node AND id <= :consumed
     AND json_valid(content_json) AND json_extract(content_json, '$.batch_key') = :key
     AND COALESCE(json_extract(content_json, '$.consumed'), 0) = 0
     AND COALESCE(json_extract(content_json, '$.superseded'), 0) = 0`;

interface BatchTaskRow {
  id: number;
  issue_id: number;
  status: string;
  workflow_mode: string | null;
  commit_sha: string | null;
  repo: string | null;
  repo_path: string | null;
  queued: number;
  batch_reviewed: number;
  waived: number;
  pending: number;
}

// queued, batch_reviewed and waived name why a task is refused; pending
// (AGILE_PENDING_REVIEW_SQL) is the set review_queue lists.
const BATCH_TASK_SQL = `SELECT t.id, t.issue_id, t.status, t.workflow_mode, t.commit_sha,
         COALESCE(t.repo, i.repo) AS repo, r.path AS repo_path,
         ${AGILE_QUEUED_SQL} AS queued, ${batchReviewedSql('t')} AS batch_reviewed, ${waivedSql('t')} AS waived,
         ${AGILE_PENDING_REVIEW_SQL} AS pending
    FROM tasks t LEFT JOIN issues i ON i.id = t.issue_id
    LEFT JOIN repos r ON r.name = COALESCE(t.repo, i.repo)
   WHERE t.id = ?`;

// The allowlist checks that need no git: why <row> may not be batch-reviewed, or null.
function batchTaskStateRefusal(row: BatchTaskRow): string | null {
  if (!inGroup(DONE, row.status)) return `not_closed (status ${row.status})`;
  if (!isStoredAgile(row.workflow_mode)) return `not_agile (workflow_mode ${row.workflow_mode ?? 'null'})`;
  if (row.queued !== 1) return 'not_queued: no bro review_queued row names its current commit';
  if (row.batch_reviewed === 1) return 'already_batch_reviewed';
  if (row.waived === 1) return 'already_waived: a bro review_waived row names its current commit';
  if (row.pending !== 1) return 'already_passed: a code-reviewer pass covers its current commit';
  if (row.repo_path === null) return `repo_unknown: no repos row for ${JSON.stringify(row.repo)}`;
  return null;
}

const ancestryKey = (repoPath: string, commitSha: string | null): string => `${repoPath}\0${commitSha ?? ''}`;

// Whether each task's commit is an ancestor of headSha in its repo, keyed by
// ancestryKey, for the tasks that pass the state checks. Runs before the
// write transaction opens so no git process runs while it holds the lock.
function batchAncestry(db: TrajectoryDB, batch: BatchArgs): Map<string, boolean> {
  const ancestry = new Map<string, boolean>();
  for (const id of batch.taskIds) {
    const row = db.get<BatchTaskRow>(BATCH_TASK_SQL, [id]);
    if (!row || row.repo_path === null || batchTaskStateRefusal(row) !== null) continue;
    const key = ancestryKey(row.repo_path, row.commit_sha);
    if (!ancestry.has(key)) ancestry.set(key, isAncestor(repoRowPath(db, row.repo_path), row.commit_sha ?? '', batch.headSha));
  }
  return ancestry;
}

// The allowlist: why <row> may not be batch-reviewed at <headSha>, or null.
function batchTaskRefusal(row: BatchTaskRow, headSha: string, ancestry: ReadonlyMap<string, boolean>): string | null {
  const stateRefusal = batchTaskStateRefusal(row);
  if (stateRefusal !== null) return stateRefusal;
  const isAnc = ancestry.get(ancestryKey(row.repo_path ?? '', row.commit_sha));
  // The task's commit or repo moved between the ancestry check and the transaction.
  if (isAnc === undefined) return `task_changed: task ${row.id} changed while review_batch_record ran; call it again`;
  if (!isAnc) return `not_ancestor: ${row.commit_sha} is not an ancestor of ${headSha} in ${row.repo}`;
  return null;
}

interface BatchRecorded {
  audit_id: number;
  verdict: BatchVerdict;
  task_ids: number[];
  commit_shas: string[];
  reviewer_agent_id: string;
}

function recordBatch(db: TrajectoryDB, batch: BatchArgs): BatchRecorded {
  const ancestry = batchAncestry(db, batch);
  const tip = handedOffTip(db, batch);
  return db.transaction(() => {
    const key = reviewBatchKey(batch.taskIds, batch.headSha);
    const latest = db.get<BatchObservation>(BATCH_OBSERVATION_SQL, [REVIEWER_OBSERVE_FROM_NODE, key]);
    const call = `review_batch_record call for tasks ${batch.taskIds.join(', ')} at ${batch.headSha}`;
    if (!latest) {
      throw new BatchRefused(
        'subagent_session_unavailable',
        `no reviewer_identity_observed row for this ${call}. review_batch_record must be called by a spawned code-reviewer subagent (the reviewer-identity-observe hook records its identity).`,
      );
    }
    const ageS = observationAgeS(latest, Date.now());
    if (ageS > REVIEWER_OBSERVATION_TTL_S) {
      throw new BatchRefused(
        'subagent_session_unavailable',
        `the newest unconsumed reviewer_identity_observed row for this ${call} (audit id ${latest.id}) is past the ${REVIEWER_OBSERVATION_TTL_S}s freshness window; call review_batch_record again so the hook records a fresh row.`,
      );
    }
    let reviewer: { agentId: string; sessionId: string | null };
    try {
      reviewer = observedReviewer(latest, call);
    } catch (e) {
      const message = (e as Error).message;
      throw new BatchRefused(message.slice(0, message.indexOf(':')), message);
    }
    const placeholders = batch.taskIds.map(() => '?').join(', ');
    const sweOf = db.all<{ task_id: number }>(
      `SELECT DISTINCT task_id FROM agent_runs WHERE agent_type = 'swe' AND spawn_id = ? AND task_id IN (${placeholders}) ORDER BY task_id`,
      [reviewer.agentId, ...batch.taskIds],
    );
    if (sweOf.length > 0) {
      throw new BatchRefused(
        'reviewer_not_independent',
        `reviewer agent_id ${reviewer.agentId} is the swe that ran task ${sweOf.map((r) => r.task_id).join(', ')}; spawn a separate code-reviewer.`,
      );
    }
    const handoff = handoffRefusal(db, batch, tip);
    if (handoff !== null) throw handoff;

    const rows: BatchTaskRow[] = [];
    const refused: Array<{ task_id: number; reason: string }> = [];
    for (const id of batch.taskIds) {
      const row = db.get<BatchTaskRow>(BATCH_TASK_SQL, [id]);
      const reason = row ? batchTaskRefusal(row, batch.headSha, ancestry) : 'not_found';
      if (reason !== null) refused.push({ task_id: id, reason });
      else if (row) rows.push(row);
    }
    if (refused.length > 0) {
      throw new BatchRefused('task_not_batchable', `${refused.length} of ${batch.taskIds.length} task(s) cannot be batch-reviewed; nothing was recorded.`, refused);
    }

    const now = nowISO();
    db.run(CONSUME_BATCH_OBSERVATIONS_SQL, [{ consumed: latest.id, now, from_node: REVIEWER_OBSERVE_FROM_NODE, key }]);
    const commitShas = rows.map((r) => r.commit_sha ?? '');
    const auditId = insertAudit(db, {
      issue_id: rows[0].issue_id,
      branch_id: batch.featureBranch,
      from_node: 'code-reviewer',
      event_type: 'review_batch_recorded',
      summary: `code-reviewer ${reviewer.agentId} recorded ${batch.verdict} on tasks ${batch.taskIds.join(', ')} at ${batch.featureBranch}@${batch.headSha}`,
      content_json: JSON.stringify({
        task_ids: batch.taskIds,
        commit_shas: commitShas,
        feature_branch: batch.featureBranch,
        head_sha: batch.headSha,
        batch_handoff_id: batch.batchHandoffId,
        verdict: batch.verdict,
        findings: batch.findings,
        reviewer_agent_id: reviewer.agentId,
        subagent_session_id: reviewer.sessionId,
      }),
      created_at: now,
    });
    return { audit_id: auditId, verdict: batch.verdict, task_ids: batch.taskIds, commit_shas: commitShas, reviewer_agent_id: reviewer.agentId };
  });
}

interface WaiveArgs {
  featureBranch: string;
  repo: string | null;
  humanAnswer: string;
}

/** The optional repo arg: a repos.name, or null when omitted. */
function parseRepo(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') throw new BatchRefused('invalid_args', 'repo must be a non-empty string');
  return value.trim();
}

function parseWaiveArgs(args: Record<string, unknown>): WaiveArgs {
  const featureBranch = args['feature_branch'];
  if (typeof featureBranch !== 'string' || featureBranch.trim() === '') {
    throw new BatchRefused('invalid_args', 'feature_branch must be a non-empty string');
  }
  const humanAnswer = args['human_answer'];
  if (typeof humanAnswer !== 'string' || humanAnswer.trim() === '') {
    throw new BatchRefused('invalid_args', "human_answer must be the Human's AskUserQuestion answer, quoted verbatim and non-empty");
  }
  return { featureBranch: featureBranch.trim(), repo: parseRepo(args['repo']), humanAnswer };
}

// The tasks of a feature branch in :repo (NULL: every repo) that no grouped
// review has settled yet, a reopened task (status other than closed) included.
const BRANCH_PENDING_SQL = `SELECT t.id, t.issue_id, t.status, t.commit_sha, t.base_sha,
         COALESCE(t.repo, i.repo) AS repo, r.path AS repo_path
    FROM tasks t LEFT JOIN issues i ON i.id = t.issue_id
    LEFT JOIN repos r ON r.name = COALESCE(t.repo, i.repo)
   WHERE ${featureBranchTaskSql('t', ':branch', ':repo')} AND ${AGILE_PENDING_REVIEW_SQL}
   ORDER BY t.id`;

interface PendingTaskRow {
  id: number;
  issue_id: number;
  status: string;
  commit_sha: string;
  base_sha: string | null;
  repo: string | null;
  repo_path: string | null;
}

interface WaiveRecorded {
  audit_id: number;
  feature_branch: string;
  task_ids: number[];
  commit_shas: string[];
}

function recordWaiver(db: TrajectoryDB, waive: WaiveArgs): WaiveRecorded {
  return db.transaction(() => {
    const pending = db.all<PendingTaskRow>(BRANCH_PENDING_SQL, [{ branch: waive.featureBranch, repo: waive.repo }]);
    // featureBranchTaskSql places a task by its own repo, else its issue's, else its merge row's, so a
    // named repo returns only the tasks it places there. t.repo holds the first two; a null one was
    // placed by its merge row alone (or by nothing), so the span check counts only the repos tasks and
    // issues record, and such a task never turns a call into mixed_repos.
    const repos = [...new Set(pending.flatMap((t) => (t.repo === null ? [] : [t.repo])))];
    if (repos.length > 1) {
      throw new BatchRefused('mixed_repos', `feature branch ${waive.featureBranch} has queued tasks in repos ${repos.map((r) => JSON.stringify(r)).join(', ')}; name one as repo. Nothing was recorded.`);
    }
    // A reopened task has no commit to waive yet: it stays pending until it closes and is queued again.
    const tasks = pending.filter((t) => t.status === 'closed');
    if (tasks.length === 0) {
      throw new BatchRefused('no_queued_task', `feature branch ${waive.featureBranch} has no queued agile task to waive; nothing was recorded.`);
    }
    const taskIds = tasks.map((t) => t.id);
    const commitShas = tasks.map((t) => t.commit_sha);
    const auditId = insertAudit(db, {
      issue_id: tasks[0].issue_id,
      branch_id: waive.featureBranch,
      from_node: 'bro',
      event_type: 'review_waived',
      summary: `the Human waived the grouped review of tasks ${taskIds.join(', ')} on ${waive.featureBranch}`,
      content_json: JSON.stringify({
        feature_branch: waive.featureBranch,
        task_ids: taskIds,
        commit_shas: commitShas,
        human_answer: waive.humanAnswer,
      }),
      created_at: nowISO(),
    });
    return { audit_id: auditId, feature_branch: waive.featureBranch, task_ids: taskIds, commit_shas: commitShas };
  });
}

interface HandoffArgs {
  featureBranch: string;
  taskIds: number[];
  sessionId: string;
}

function parseHandoffArgs(args: Record<string, unknown>): HandoffArgs {
  const featureBranch = parseFeatureBranch(args['feature_branch']);
  const taskIds = parseTaskIds(args['task_ids']);
  let sessionId: string | null;
  try {
    sessionId = parseRunSessionId(args['session_id']);
  } catch (e) {
    throw new BatchRefused('invalid_args', (e as Error).message);
  }
  if (sessionId === null) {
    throw new BatchRefused('invalid_args', 'session_id is required: the code-reviewer spawn carries it as subagent_session_id');
  }
  return { featureBranch, taskIds, sessionId };
}

/** One lint of the batch's close-lint run, as the review_batch_handoff row stores it. */
interface HandoffLintResult {
  name: string;
  exit_code: number;
  elapsed_s: number;
  output_tail: string;
}

interface HandoffLint {
  fingerprint: string;
  exit_code: number;
  results: HandoffLintResult[];
}

/** The verification budget in seconds: TMB_VERIFICATION_TIMEOUT_S, else plugin_config.verification_timeout_s. */
function lintBudgetS(db: TrajectoryDB): number {
  let raw = process.env['TMB_VERIFICATION_TIMEOUT_S'] ?? '';
  if (raw === '') {
    const row = db.get<{ v: unknown }>(`SELECT json_extract(value_json, '$') AS v FROM plugin_config WHERE key = 'verification_timeout_s'`);
    raw = typeof row?.v === 'number' || typeof row?.v === 'string' ? String(row.v) : '';
  }
  return parseBudget(raw).timeoutS;
}

const GIT_WORKTREE_TIMEOUT_MS = 120_000;

// runCloseLints records every run into the lint_runs of the DB it is given,
// keyed by task_id, which a batch has none of. The batch run goes into a
// throwaway DB holding just those two tables (no tasks table, so the lint set
// is the code-class one) and its result into the review_batch_handoff row.
function createScratchLintDb(path: string): void {
  const scratch = new DatabaseSync(path);
  try {
    scratch.exec(`CREATE TABLE lint_runs (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, commit_sha TEXT NOT NULL,
        base_sha TEXT NOT NULL, fingerprint TEXT NOT NULL, source TEXT NOT NULL, started_at TEXT NOT NULL,
        finished_at TEXT, exit_code INTEGER);
      CREATE TABLE lint_run_results (run_id INTEGER NOT NULL, ordinal INTEGER NOT NULL, name TEXT NOT NULL,
        exit_code INTEGER, elapsed_s REAL, output_tail TEXT, PRIMARY KEY (run_id, ordinal));`);
  } finally {
    scratch.close();
  }
}

async function removeTempWorktree(repoPath: string, wt: string): Promise<void> {
  await runGitAsync(repoPath, ['worktree', 'remove', '--force', wt], { timeout: GIT_WORKTREE_TIMEOUT_MS });
  try {
    rmSync(wt, { recursive: true, force: true });
  } catch {
    /* the prune below still drops the registration once its .git file is gone */
  }
  await runGitAsync(repoPath, ['worktree', 'prune']);
}

/** The verification-defaults commands of a hand-off, as its row and result store them. */
interface HandoffSuite {
  commands: string[];
  passed: boolean;
  /** Why no suite ran, when commands is empty. */
  note?: string;
}

interface SuiteFailure {
  command: string;
  exit_code: number;
  tail: string;
}

const SUITE_TAIL_CHARS = 2000;

function suiteTail(output: string): string {
  const tail = tailLines(output);
  return tail.length > SUITE_TAIL_CHARS ? tail.slice(-SUITE_TAIL_CHARS) : tail;
}

function readOutput(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

// Each command in <wt> in order, sharing <budgetS>, stopping at the first
// that exits non-zero: that failure, or null when all pass. A full suite
// (isFullSuite) first takes a suite slot, as the swe-verification-gate does,
// waiting at most the budget; a slot still busy then refuses the hand-off.
async function runSuiteCommands(wt: string, commands: readonly string[], budgetS: number, env: NodeJS.ProcessEnv): Promise<SuiteFailure | null> {
  if (commands.length === 0) return null;
  const started = Date.now();
  const leftS = (): number => budgetS - (Date.now() - started) / 1000;
  const fullSuite = commands.find(isFullSuite);
  let runEnv = env;
  let release = (): void => {};
  if (fullSuite !== undefined) {
    const slot = await acquireSuiteSlot({ command: fullSuite, worktree: wt, env, maxWaitS: Math.max(0, Math.floor(budgetS)) });
    if (slot.kind === 'busy') {
      throw new BatchRefused('suite_slot_busy', `the suite did not run: every suite slot is ${describeHolder(slot.holder)}; waited ${slot.waitedS}s. Hand the group off again once that suite finishes.`);
    }
    if (slot.kind === 'held') {
      runEnv = { ...env, [SUITE_LOCK_HELD_ENV]: slot.slot };
      release = slot.release;
    }
  }
  const scratch = mkdtempSync(join(env.TMPDIR || tmpdir(), 'tmb-review-suite-'));
  try {
    for (const [i, command] of commands.entries()) {
      const left = leftS();
      if (left <= 0) return { command, exit_code: LINT_TIMED_OUT, tail: `the ${budgetS}s verification budget ran out before it started` };
      const outPath = join(scratch, `out-${i + 1}`);
      const rc = await runBashKilledAt(command, wt, runEnv, left, outPath);
      if (rc === 0) continue;
      const printed = suiteTail(readOutput(outPath));
      const killed = rc === LINT_TIMED_OUT ? `killed at the ${budgetS}s verification budget` : '';
      return { command, exit_code: rc, tail: [printed, killed].filter((s) => s !== '').join('\n') };
    }
    return null;
  } finally {
    release();
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Refuses the hand-off as suite_failed when a suite command fails in <wt>.
async function assertSuitePasses(wt: string, head: string, commands: readonly string[], budgetS: number, env: NodeJS.ProcessEnv): Promise<void> {
  const failure = await runSuiteCommands(wt, commands, budgetS, env);
  if (failure === null) return;
  throw new BatchRefused(
    'suite_failed',
    `the suite (${VERIFICATION_DEFAULTS_FILE}) fails on ${head}: \`${failure.command}\` exited ${failure.exit_code}; fix it on the feature branch, then hand the group off again.\n${failure.tail}`,
    undefined,
    { suite: { commands: [...commands], passed: false, failed_command: failure.command, exit_code: failure.exit_code, tail: failure.tail } },
  );
}

// The close lints of <head> against <base>, then, once they pass, the
// <suiteCommands>, all within <budgetS>, in a temporary detached worktree of
// <repoPath> prepared as cli.js integrate prepares its own; the lint run, or
// why none ran. A failing suite command refuses the hand-off.
async function runBatchChecks(repoPath: string, head: string, base: string, budgetS: number, suiteCommands: readonly string[]): Promise<CloseLintsRun | string> {
  const env = process.env;
  const worktrees = join(repoPath, '.claude', 'worktrees');
  let wt: string;
  try {
    mkdirSync(worktrees, { recursive: true });
    wt = mkdtempSync(join(worktrees, 'review-batch.'));
  } catch (e) {
    return `cannot create a temporary worktree dir under ${worktrees}: ${(e as Error).message}`;
  }
  const scratch = mkdtempSync(join(env.TMPDIR || tmpdir(), 'tmb-review-batch-'));
  try {
    const add = await runGitAsync(repoPath, ['worktree', 'add', '-q', '--detach', wt, head], { timeout: GIT_WORKTREE_TIMEOUT_MS });
    if (add.error || add.status !== 0) return `git worktree add ${head} failed: ${(add.stderr ?? '').trim()}`;
    const runEnv = { ...env, PATH: joinToolchainPath(toolchainDirs(env, wt), env.PATH ?? '') };
    const deps = await prepareWorktreeDeps(repoPath, wt, { env: runEnv });
    if (deps.install_error !== undefined) return `worktree setup failed: ${deps.install_error}`;
    const setup = await runWorktreeSetup(wt, { env: runEnv });
    if (setup.error !== undefined) return describeSetupFailure(setup);
    const lintDb = join(scratch, 'lints.db');
    createScratchLintDb(lintDb);
    const started = Date.now();
    const lints = await runCloseLints(wt, head, base, budgetS, runEnv, { db: lintDb, taskId: '0', source: 'gate' });
    if (typeof lints === 'string' || lints.exitCode !== 0) return lints;
    await assertSuitePasses(wt, head, suiteCommands, budgetS - (Date.now() - started) / 1000, runEnv);
    return lints;
  } finally {
    await removeTempWorktree(repoPath, wt);
    rmSync(scratch, { recursive: true, force: true });
  }
}

interface BatchChecks {
  lint: HandoffLint;
  suite: HandoffSuite;
}

// The close lints and the verification-defaults suite of <head>, both as
// committed there; refuses the hand-off when either fails or cannot run.
async function batchChecks(db: TrajectoryDB, repoPath: string, head: string, base: string): Promise<BatchChecks> {
  const plan = await closeLintsPlan(repoPath, head, process.env, '');
  if (typeof plan === 'string') throw new BatchRefused('lint_unavailable', `the close lints of ${head} cannot run: ${plan}`);
  const defaults = readVerificationDefaults(repoPath, head);
  if ('error' in defaults) {
    throw new BatchRefused('verification_defaults_invalid', `${VERIFICATION_DEFAULTS_FILE} at ${head} is invalid: ${defaults.error}`);
  }
  const suite: HandoffSuite =
    defaults.commands.length === 0
      ? { commands: [], passed: true, note: `no ${VERIFICATION_DEFAULTS_FILE} at ${head}, so no suite ran` }
      : { commands: defaults.commands, passed: true };
  if (plan.lints.length === 0 && defaults.commands.length === 0) return { lint: { fingerprint: plan.fingerprint, exit_code: 0, results: [] }, suite };
  const run = await runBatchChecks(repoPath, head, base, lintBudgetS(db), defaults.commands);
  if (typeof run === 'string') throw new BatchRefused('lint_unavailable', `the close lints and suite of ${head} cannot run: ${run}`);
  if (run.exitCode !== 0) {
    throw new BatchRefused('lint_failed', `the close lints fail on ${head}; fix them on the feature branch, then hand the group off again.\n${describeFailures(run)}`);
  }
  const lint = {
    fingerprint: run.fingerprint,
    exit_code: run.exitCode,
    results: run.results.map((r) => ({ name: r.name, exit_code: r.exitCode, elapsed_s: r.elapsedS, output_tail: tailLines(r.output) })),
  };
  return { lint, suite };
}

// The paths <task> changed: git diff --name-only <base_sha> <commit_sha>.
function taskChangedFiles(repoPath: string, task: PendingTaskRow): string[] | null {
  if (!task.base_sha) return null;
  const entries = diffNameStatus(repoPath, task.base_sha, task.commit_sha);
  return entries === null ? null : [...new Set(entries.map((e) => e.path))];
}

// Refuses a group that leaves out a queued task sharing a changed file with it,
// so one review sees every change to each file it judges (AGILE.md).
function assertGroupKeepsSharedFiles(repoPath: string, repo: string, group: readonly PendingTaskRow[], pending: readonly PendingTaskRow[]): void {
  const inGroup = new Set(group.map((t) => t.id));
  const outside = pending.filter((t) => !inGroup.has(t.id) && t.repo === repo);
  if (outside.length === 0) return;
  const changed = new Map<number, string[]>();
  const unknown: RefusedTask[] = [];
  for (const task of [...group, ...outside]) {
    const files = taskChangedFiles(repoPath, task);
    if (files === null) unknown.push({ task_id: task.id, reason: `git diff ${task.base_sha ?? '(no base_sha)'} ${task.commit_sha} gave no answer in ${repoPath}` });
    else changed.set(task.id, files);
  }
  if (unknown.length > 0) {
    throw new BatchRefused('changed_files_unknown', `the changed files of ${unknown.length} task(s) cannot be read, so the group cannot be checked for a split file; nothing was recorded.`, unknown);
  }
  const split: RefusedTask[] = [];
  for (const task of outside) {
    const own = new Set(changed.get(task.id));
    const sharesWith = group.filter((g) => changed.get(g.id)?.some((f) => own.has(f))).map((g) => g.id);
    if (sharesWith.length === 0) continue;
    const files = [...new Set(group.flatMap((g) => changed.get(g.id)?.filter((f) => own.has(f)) ?? []))].sort();
    split.push({ task_id: task.id, reason: 'left_out_shares_changed_files', shares_with: sharesWith, files });
  }
  if (split.length > 0) {
    throw new BatchRefused(
      'group_splits_shared_file',
      `${split.length} queued task(s) left out of task_ids change a file a task in the group changes; add them to task_ids so one review sees every change to those files. Nothing was recorded.`,
      split,
    );
  }
}

interface BatchHandoff {
  batch_handoff_id: number;
  head_sha: string;
  base_sha: string;
  task_ids: number[];
  suite: HandoffSuite;
  reviewer_spawn: ReviewerSpawn;
}

const pendingKey = (rows: readonly PendingTaskRow[]): string => rows.map((t) => `${t.id}@${t.commit_sha}:${t.status}`).join(',');

async function handoffBatch(db: TrajectoryDB, h: HandoffArgs): Promise<BatchHandoff> {
  const branch = h.featureBranch;
  // Every repo's pending tasks of the branch; the group's own repo keys the rest.
  const pendingAll = db.all<PendingTaskRow>(BRANCH_PENDING_SQL, [{ branch, repo: null }]);
  const byId = new Map(pendingAll.map((t) => [t.id, t]));
  const notQueued = h.taskIds.flatMap((id) => {
    const task = byId.get(id);
    if (task === undefined) return [{ task_id: id, reason: `not a queued agile task of ${branch} awaiting review` }];
    if (task.status !== 'closed') return [{ task_id: id, reason: `reopened: status ${task.status}; close it and land it with feature-merge again` }];
    return [];
  });
  if (notQueued.length > 0) {
    throw new BatchRefused('task_not_queued', `${notQueued.length} of ${h.taskIds.length} task(s) are not queued for review on ${branch}; nothing was recorded.`, notQueued);
  }
  const group = h.taskIds.map((id) => byId.get(id) as PendingTaskRow);
  const unknownRepo = group.filter((t) => t.repo === null || t.repo_path === null);
  if (unknownRepo.length > 0) {
    throw new BatchRefused('repo_unknown', 'no repos row resolves for some task(s); nothing was recorded.', unknownRepo.map((t) => ({ task_id: t.id, reason: `repo_unknown: ${JSON.stringify(t.repo)}` })));
  }
  const repos = [...new Set(group.map((t) => t.repo as string))];
  if (repos.length > 1) throw new BatchRefused('mixed_repos', `the tasks span repos ${repos.join(', ')}; hand off one group per repo.`);
  const repo = repos[0];
  const repoPath = repoRowPath(db, group[0].repo_path as string);
  // t.repo is the task's repo, else its issue's; featureBranchTaskSql falls back further, to the merge
  // row's, which pendingAll (every repo) does not split by. A task neither records may be in this repo,
  // so it stays in: a shared file with it refuses the hand-off rather than slipping past review.
  const ofRepo = (rows: readonly PendingTaskRow[]): PendingTaskRow[] => rows.filter((t) => t.repo === repo || t.repo === null);
  const pending = ofRepo(pendingAll);

  const head = revParseCommit(repoPath, `refs/heads/${branch}`);
  if (head === null) throw new BatchRefused('branch_unresolved', `refs/heads/${branch} does not resolve in ${repoPath}.`);
  const target = repoTargetBase(db, repoPath, repo);
  const targetRef = resolveBaseRef(repoPath, target);
  const base = targetRef === null ? null : mergeBase(repoPath, targetRef, head);
  if (base === null) {
    throw new BatchRefused('target_unresolved', `no merge-base of ${branch} (${head}) and its target ${targetRef ?? target} resolves in ${repoPath}.`);
  }
  const notAncestor = group.filter((t) => !isAncestor(repoPath, t.commit_sha, head));
  if (notAncestor.length > 0) {
    throw new BatchRefused(
      'not_ancestor',
      `${notAncestor.length} task commit(s) are not ancestors of ${branch}@${head}; nothing was recorded.`,
      notAncestor.map((t) => ({ task_id: t.id, reason: `not_ancestor: ${t.commit_sha} is not an ancestor of ${head} in ${repo}` })),
    );
  }
  assertGroupKeepsSharedFiles(repoPath, repo, group, pending);
  const { lint, suite } = await batchChecks(db, repoPath, head, base);

  return db.transaction(() => {
    // The lints ran outside the transaction; a task that closed, moved or was reviewed meanwhile voids the checks above.
    const now = ofRepo(db.all<PendingTaskRow>(BRANCH_PENDING_SQL, [{ branch, repo: null }]));
    if (pendingKey(now) !== pendingKey(pending)) {
      throw new BatchRefused('task_changed', `the queued tasks of ${branch} changed while review_batch_handoff ran; call it again.`);
    }
    const commitShas = group.map((t) => t.commit_sha);
    const auditId = insertAudit(db, {
      issue_id: group[0].issue_id,
      branch_id: branch,
      from_node: 'bro',
      event_type: 'review_batch_handoff',
      summary: `bro handed off tasks ${h.taskIds.join(', ')} for grouped review at ${branch}@${head}`,
      content_json: JSON.stringify({
        feature_branch: branch,
        head_sha: head,
        base_sha: base,
        task_ids: h.taskIds,
        commit_shas: commitShas,
        repo,
        lint,
        suite,
      }),
      created_at: nowISO(),
    });
    const reviewer_spawn = batchReviewerSpawn(
      { batch_handoff_id: String(auditId), feature_branch: branch, head_sha: head, repo, repo_path: repoPath, subagent_session_id: h.sessionId },
      resolveEffortDefaults(db).reviewer,
    );
    return { batch_handoff_id: auditId, head_sha: head, base_sha: base, task_ids: h.taskIds, suite, reviewer_spawn };
  });
}

function refusal(e: BatchRefused): CallToolResult {
  const body = { error: e.reason, message: e.message, ...(e.tasks ? { tasks: e.tasks } : {}), ...e.detail };
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true };
}

export function reviewQueueTools(db: TrajectoryDB): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'review_queue',
      description:
        'Agile tasks awaiting code review: queued or reopened after feature-merge. Returns {total, groups:[{tasks, files, base, head}]}; same-repo tasks with overlapping files[] share a group. Read-only, no git.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          repo: { type: 'string', description: 'Only tasks of this repos.name.' },
          feature_branch: { type: 'string', description: 'Only tasks merged onto this feature branch.' },
        },
        required: ['agent'],
      },
    },
    {
      name: 'review_batch_handoff',
      description:
        "bro only: hands feature_branch's queued tasks to a review at its tip once its close lints then verification-defaults suite pass. Returns {batch_handoff_id, head_sha, base_sha, task_ids, suite, reviewer_spawn}. " +
        'Refused, writing nothing, if a task is not queued there or under the tip, a check fails, or a left-out task shares a changed file.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          feature_branch: { type: 'string' },
          task_ids: { type: 'array', items: { type: 'integer' }, minItems: 1 },
          session_id: { ...RUN_SESSION_ID_SCHEMA, description: 'Your host session id; the reviewer spawn carries it.' },
        },
        required: ['agent', 'feature_branch', 'task_ids', 'session_id'],
      },
    },
    {
      name: 'review_batch_record',
      description:
        'code-reviewer only: one verdict on queued agile tasks at head_sha. Refused, writing nothing, unless batch_handoff_id handed off these task_ids at head_sha, still the tip, and every task is closed agile, queued at its commit (not batch-reviewed, waived or passed), that commit an ancestor of head_sha. ' +
        'pass batch-reviews them all; fail leaves them queued.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          task_ids: { type: 'array', items: { type: 'integer' }, minItems: 1 },
          feature_branch: { type: 'string' },
          head_sha: { type: 'string', description: 'The feature-branch commit reviewed.' },
          batch_handoff_id: { type: 'integer', minimum: 1, description: 'From your spawn prompt.' },
          verdict: { type: 'string', enum: [...BATCH_VERDICTS] },
          findings: { type: 'array', items: { type: 'object' }, description: 'Optional, in validation_record\'s finding shape.' },
        },
        required: ['agent', 'task_ids', 'feature_branch', 'head_sha', 'batch_handoff_id', 'verdict'],
      },
    },
    {
      name: 'review_waive_record',
      description:
        'bro only. Call only after the Human answered Yes to your AskUserQuestion to merge feature_branch without grouped review. ' +
        'Waives its queued agile tasks in one repo; refused, writing nothing, if none is queued or repo is omitted and they span repos.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          feature_branch: { type: 'string' },
          repo: { type: 'string', description: 'The repos.name of feature_branch; required when its queued tasks span repos.' },
          human_answer: { type: 'string', description: "The Human's answer, quoted verbatim." },
        },
        required: ['agent', 'feature_branch', 'human_answer'],
      },
    },
  ];

  const handler = (args: Record<string, unknown>): CallToolResult => {
    const repo = args['repo'];
    if (repo !== undefined && repo !== null && typeof repo !== 'string') return err('repo must be a string');
    const branchArg = args['feature_branch'];
    const branch = branchArg === undefined ? null : parseFeatureBranch(branchArg);
    const rows = db.all<QueuedTaskRow>(QUEUE_SQL, [{ repo: repo ?? null, branch }]);
    const groups = groupQueuedTasks(rows);
    return ok({ total: rows.length, groups });
  };

  return {
    definitions,
    handlers: {
      review_queue: requireRoles('review_queue', ['bro'], (args) => {
        try {
          return Promise.resolve(handler(args));
        } catch (e) {
          return Promise.resolve(e instanceof BatchRefused ? refusal(e) : err((e as Error).message));
        }
      }),
      review_batch_handoff: requireRoles('review_batch_handoff', ['bro'], async (args) => {
        try {
          return ok(await handoffBatch(db, parseHandoffArgs(args)));
        } catch (e) {
          return e instanceof BatchRefused ? refusal(e) : err((e as Error).message);
        }
      }),
      review_batch_record: requireRoles('review_batch_record', ['code-reviewer'], (args) => {
        try {
          return Promise.resolve(ok(recordBatch(db, parseBatchArgs(args))));
        } catch (e) {
          return Promise.resolve(e instanceof BatchRefused ? refusal(e) : err((e as Error).message));
        }
      }),
      review_waive_record: requireRoles('review_waive_record', ['bro'], (args) => {
        try {
          return Promise.resolve(ok(recordWaiver(db, parseWaiveArgs(args))));
        } catch (e) {
          return Promise.resolve(e instanceof BatchRefused ? refusal(e) : err((e as Error).message));
        }
      }),
    },
  };
}
