// review_queue: the closed agile tasks still waiting for code review, grouped by overlapping declared files[].
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { UNREVIEWED_CLOSED_TASK } from '../data-contracts.js';

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
    },
  };
}
