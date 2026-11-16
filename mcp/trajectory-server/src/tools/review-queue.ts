// review_queue: the closed agile tasks still waiting for code review, grouped by overlapping declared files[].
// review_batch_record: code-reviewer's one verdict on a group of them.
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { UNREVIEWED_CLOSED_TASK } from '../data-contracts.js';
import { AGILE_QUEUED_SQL, batchReviewedSql, reviewBatchKey } from '../review-sql.js';
import { isAncestor } from '../utils/git-objects.js';
import { repoRowPath } from '../utils/repo-paths.js';
import { insertAudit } from './audit.js';
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

// The doctor's agile_review_queued membership, on the task's stamped mode (not
// the current plugin_config.workflow_mode), so a switch to truest keeps the queue.
// updated_at is normalized to ms-ISO so legacy rows order by time.
const QUEUE_SQL = `SELECT t.id, t.issue_id, t.branch_id, t.commit_sha, t.base_sha, t.files,
         strftime('%Y-%m-%dT%H:%M:%fZ', t.updated_at) AS updated_at
    FROM tasks t
   WHERE ${UNREVIEWED_CLOSED_TASK('t')} AND t.workflow_mode = 'agile'
     AND (:repo IS NULL OR t.repo = :repo)
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

/** Connected components of the tasks under declared-files overlap, ordered by lowest task id. */
export function groupQueuedTasks(rows: readonly QueuedTaskRow[]): ReviewGroup[] {
  const sorted = [...rows].sort((x, y) => x.id - y.id);
  const files = sorted.map((r) => declaredFiles(r.files));
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
      if (find(i) === find(j)) continue;
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

/** A refused review_batch_record call; the transaction rolls back, so nothing is written. */
class BatchRefused extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly tasks?: ReadonlyArray<{ task_id: number; reason: string }>,
  ) {
    super(message);
  }
}

interface BatchArgs {
  taskIds: number[];
  featureBranch: string;
  headSha: string;
  verdict: BatchVerdict;
  findings: FindingInput[] | null;
}

function parseBatchArgs(args: Record<string, unknown>): BatchArgs {
  const rawIds = args['task_ids'];
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new BatchRefused('invalid_args', 'task_ids must be a non-empty array of task ids');
  }
  const taskIds = rawIds.map((v) => (typeof v === 'number' || (typeof v === 'string' && /^[0-9]+$/.test(v)) ? Number(v) : NaN));
  if (!taskIds.every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new BatchRefused('invalid_args', `task_ids must be positive integers; got ${JSON.stringify(rawIds)}`);
  }
  const featureBranch = args['feature_branch'];
  if (typeof featureBranch !== 'string' || featureBranch.trim() === '') {
    throw new BatchRefused('invalid_args', 'feature_branch must be a non-empty string');
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
    taskIds: [...new Set(taskIds)].sort((a, b) => a - b),
    featureBranch: featureBranch.trim(),
    headSha: headSha.toLowerCase(),
    verdict: verdict as BatchVerdict,
    findings,
  };
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
}

const BATCH_TASK_SQL = `SELECT t.id, t.issue_id, t.status, t.workflow_mode, t.commit_sha,
         COALESCE(t.repo, i.repo) AS repo, r.path AS repo_path,
         ${AGILE_QUEUED_SQL} AS queued, ${batchReviewedSql('t')} AS batch_reviewed
    FROM tasks t LEFT JOIN issues i ON i.id = t.issue_id
    LEFT JOIN repos r ON r.name = COALESCE(t.repo, i.repo)
   WHERE t.id = ?`;

// The allowlist: why <row> may not be batch-reviewed at <headSha>, or null.
function batchTaskRefusal(db: TrajectoryDB, row: BatchTaskRow, headSha: string): string | null {
  if (row.status !== 'closed') return `not_closed (status ${row.status})`;
  if (row.workflow_mode !== 'agile') return `not_agile (workflow_mode ${row.workflow_mode ?? 'null'})`;
  if (row.queued !== 1) return 'not_queued: no bro review_queued row names its current commit';
  if (row.batch_reviewed === 1) return 'already_batch_reviewed';
  if (row.repo_path === null) return `repo_unknown: no repos row for ${JSON.stringify(row.repo)}`;
  if (!isAncestor(repoRowPath(db, row.repo_path), row.commit_sha ?? '', headSha)) {
    return `not_ancestor: ${row.commit_sha} is not an ancestor of ${headSha} in ${row.repo}`;
  }
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

    const rows: BatchTaskRow[] = [];
    const refused: Array<{ task_id: number; reason: string }> = [];
    for (const id of batch.taskIds) {
      const row = db.get<BatchTaskRow>(BATCH_TASK_SQL, [id]);
      const reason = row ? batchTaskRefusal(db, row, batch.headSha) : 'not_found';
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

function refusal(e: BatchRefused): CallToolResult {
  const body = { error: e.reason, message: e.message, ...(e.tasks ? { tasks: e.tasks } : {}) };
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
        'The closed agile tasks awaiting code review, as agile_review_queued counts them. Returns {total, groups:[{tasks, files, base, head}]}; tasks whose declared files[] overlap share a group. Read-only, no git.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          repo: { type: 'string', description: 'Only tasks of this repos.name.' },
          grace_hours: {
            type: 'number',
            minimum: 0,
            description: 'Leave out tasks closed less than this many hours ago. Default 0: every unreviewed agile close.',
          },
        },
        required: ['agent'],
      },
    },
    {
      name: 'review_batch_record',
      description:
        'code-reviewer only: one verdict on a group of queued agile tasks at feature-branch head_sha. Refused, writing nothing, unless every task is closed agile, queued at its commit, not yet batch-reviewed, and that commit an ancestor of head_sha. ' +
        'pass batch-reviews them all; fail leaves them queued.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          task_ids: { type: 'array', items: { type: 'integer' }, minItems: 1 },
          feature_branch: { type: 'string' },
          head_sha: { type: 'string', description: 'The feature-branch commit reviewed.' },
          verdict: { type: 'string', enum: [...BATCH_VERDICTS] },
          findings: { type: 'array', items: { type: 'object' }, description: 'Optional, in validation_record\'s finding shape.' },
        },
        required: ['agent', 'task_ids', 'feature_branch', 'head_sha', 'verdict'],
      },
    },
  ];

  const handler = (args: Record<string, unknown>): CallToolResult => {
    const repo = args['repo'];
    if (repo !== undefined && repo !== null && typeof repo !== 'string') return err('repo must be a string');
    const grace = args['grace_hours'] ?? 0;
    if (typeof grace !== 'number' || !Number.isFinite(grace) || grace < 0) {
      return err('grace_hours must be a non-negative number');
    }
    const rows = db.all<QueuedTaskRow>(QUEUE_SQL, [{ grace_hours: grace, repo: repo ?? null }]);
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
          return Promise.resolve(err((e as Error).message));
        }
      }),
      review_batch_record: requireRoles('review_batch_record', ['code-reviewer'], (args) => {
        try {
          return Promise.resolve(ok(recordBatch(db, parseBatchArgs(args))));
        } catch (e) {
          return Promise.resolve(e instanceof BatchRefused ? refusal(e) : err((e as Error).message));
        }
      }),
    },
  };
}
