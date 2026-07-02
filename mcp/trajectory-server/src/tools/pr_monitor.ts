import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { resolveBackend } from '../sync/backend.js';
import { buildBotPatterns, isBot } from '../sync/bot_patterns.js';
import { spawnSync, SpawnSyncOptions } from 'node:child_process';
import { SUBPROCESS_TIMEOUT_MS } from '../utils/timeouts.js';
import { liveCliBlockReason, liveCliBlockedMessage } from '../utils/live-cli-guard.js';
import { resolveRepoForSync } from '../utils/repo-paths.js';
import { repoSlugFromRemoteUrl } from '../sync/issue_sync.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function wrap(
  fn: (args: Record<string, unknown>) => Promise<CallToolResult>,
): (args: Record<string, unknown>) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return err((e as Error).message);
    }
  };
}

export interface PrComment {
  id: string;
  author: string;
  author_kind: 'bot' | 'human';
  body: string;
  file_path?: string;
  line?: number;
  created_at: string;
  is_resolved: boolean;
}

export interface PrCommentsResult {
  comments: PrComment[];
  pr_state: 'open' | 'merged' | 'closed';
  remote_kind: 'github' | 'gitlab';
  // The PR/MR head (source) branch, used to resolve the owning task so the
  // monitor-path pr_review_runs row carries task_id (#1024).
  head_branch?: string;
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: SpawnSyncOptions,
) => { status: number | null; stdout: string; stderr: string };

function defaultSpawnFn(
  cmd: string,
  args: string[],
  opts: SpawnSyncOptions,
): { status: number | null; stdout: string; stderr: string } {
  const blockReason = liveCliBlockReason();
  if (blockReason) {
    return { status: null, stdout: '', stderr: liveCliBlockedMessage(blockReason, cmd, args) };
  }
  const result = spawnSync(cmd, args, opts);
  return {
    status: result.status,
    stdout: result.stdout ? String(result.stdout) : '',
    stderr: result.stderr ? String(result.stderr) : '',
  };
}

// Map a pr_review_runs.repo slug (host-qualified "github.com/owner/repo" or bare
// "owner/repo") back to a repos.name so the task lookup can be repo-scoped.
// Best-effort: null when no repos row's remotes match.
function repoNameForSlug(db: TrajectoryDB, slug: string): string | null {
  if (!slug) return null;
  const rows = db.all<{ name: string; remotes: string | null }>(
    `SELECT name, remotes FROM repos`,
  );
  for (const row of rows) {
    if (!row.remotes) continue;
    let remotes: Array<{ url?: string }>;
    try {
      const parsed = JSON.parse(row.remotes) as unknown;
      remotes = Array.isArray(parsed) ? (parsed as Array<{ url?: string }>) : [];
    } catch {
      continue;
    }
    for (const r of remotes) {
      const full = r.url ? repoSlugFromRemoteUrl(r.url) : null;
      if (!full) continue;
      const bare = full.replace(/^[^/]+\//, '');
      if (slug === full || slug === bare) return row.name;
    }
  }
  return null;
}

// Resolve the task that owns a PR from its head branch (+ repo). Populates
// pr_review_runs.task_id on the monitor path (#1024) so the post-pr-comments
// carrier resolution (pr_number → pr_review_runs → tasks → issue) resolves in
// production. Best-effort: returns null when the branch is empty, unknown, or
// ambiguous — the carrier hook then exits cleanly.
function resolveMonitorTaskId(db: TrajectoryDB, branch: string | undefined, repoSlug: string): number | null {
  if (!branch) return null;
  const repoName = repoNameForSlug(db, repoSlug);
  if (repoName) {
    const scoped = db.all<{ id: number }>(
      `SELECT id FROM tasks WHERE branch_id = ? AND repo = ?`,
      [branch, repoName],
    );
    if (scoped.length === 1) return scoped[0]!.id;
  }
  const rows = db.all<{ id: number }>(
    `SELECT id FROM tasks WHERE branch_id = ?`,
    [branch],
  );
  return rows.length === 1 ? rows[0]!.id : null;
}

function normalizePrState(raw: string): 'open' | 'merged' | 'closed' {
  const lower = raw.toLowerCase();
  if (lower === 'open' || lower === 'opened') return 'open';
  if (lower === 'merged') return 'merged';
  return 'closed';
}

function fetchGithubComments(
  prNumber: number,
  repo: string,
  since: string | undefined,
  botPatterns: RegExp[],
  spawnFn: SpawnFn,
): PrCommentsResult | null {
  const opts: SpawnSyncOptions = { timeout: 15000, encoding: 'utf8' };
  const ghArgs = ['pr', 'view', String(prNumber), '--json', 'comments,state,reviews,headRefName'];
  if (repo) ghArgs.splice(2, 0, '-R', repo);
  const result = spawnFn('gh', ghArgs, opts);

  if (result.status !== 0) return null;

  let parsed: {
    state?: string;
    headRefName?: string;
    comments?: Array<{
      id?: string;
      databaseId?: number;
      author?: { login?: string };
      body?: string;
      createdAt?: string;
    }>;
    reviews?: Array<{
      comments?: Array<{
        id?: string;
        databaseId?: number;
        author?: { login?: string };
        body?: string;
        createdAt?: string;
        path?: string;
        line?: number;
        isResolved?: boolean;
      }>;
    }>;
  };

  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }

  const prState = normalizePrState(parsed.state ?? '');
  const rawComments: PrComment[] = [];

  for (const c of parsed.comments ?? []) {
    const id = c.id ?? String(c.databaseId ?? '');
    const author = c.author?.login ?? 'unknown';
    const created_at = c.createdAt ?? '';
    if (since && created_at && created_at <= since) continue;
    rawComments.push({
      id,
      author,
      author_kind: isBot(author, botPatterns) ? 'bot' : 'human',
      body: c.body ?? '',
      created_at,
      is_resolved: false,
    });
  }

  for (const review of parsed.reviews ?? []) {
    for (const c of review.comments ?? []) {
      const id = c.id ?? String(c.databaseId ?? '');
      const author = c.author?.login ?? 'unknown';
      const created_at = c.createdAt ?? '';
      if (since && created_at && created_at <= since) continue;
      const comment: PrComment = {
        id,
        author,
        author_kind: isBot(author, botPatterns) ? 'bot' : 'human',
        body: c.body ?? '',
        created_at,
        is_resolved: c.isResolved ?? false,
      };
      if (c.path) comment.file_path = c.path;
      if (c.line !== undefined) comment.line = c.line;
      rawComments.push(comment);
    }
  }

  return { comments: rawComments, pr_state: prState, remote_kind: 'github', head_branch: parsed.headRefName ?? '' };
}

function fetchGitlabComments(
  prNumber: number,
  repo: string,
  since: string | undefined,
  botPatterns: RegExp[],
  spawnFn: SpawnFn,
): PrCommentsResult | null {
  const opts: SpawnSyncOptions = { timeout: 15000, encoding: 'utf8' };
  const glabArgs = ['mr', 'view', String(prNumber), '--comments', '--output', 'json'];
  if (repo) glabArgs.splice(2, 0, '-R', repo);
  const result = spawnFn('glab', glabArgs, opts);

  if (result.status !== 0) return null;

  let parsed: {
    state?: string;
    source_branch?: string;
    notes?: Array<{
      id?: number;
      author?: { username?: string };
      body?: string;
      created_at?: string;
      resolved?: boolean;
      position?: { new_path?: string; new_line?: number };
    }>;
  };

  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }

  const prState = normalizePrState(parsed.state ?? '');
  const rawComments: PrComment[] = [];

  for (const note of parsed.notes ?? []) {
    const id = String(note.id ?? '');
    const author = note.author?.username ?? 'unknown';
    const created_at = note.created_at ?? '';
    if (since && created_at && created_at <= since) continue;
    const comment: PrComment = {
      id,
      author,
      author_kind: isBot(author, botPatterns) ? 'bot' : 'human',
      body: note.body ?? '',
      created_at,
      is_resolved: note.resolved ?? false,
    };
    if (note.position?.new_path) comment.file_path = note.position.new_path;
    if (note.position?.new_line !== undefined) comment.line = note.position.new_line;
    rawComments.push(comment);
  }

  return { comments: rawComments, pr_state: prState, remote_kind: 'gitlab', head_branch: parsed.source_branch ?? '' };
}

function resolveComments(
  backend: 'gh' | 'glab' | 'both' | 'off' | null,
  prNumber: number,
  repo: string,
  since: string | undefined,
  botPatterns: RegExp[],
  spawnFn: SpawnFn,
): PrCommentsResult | null {
  if (backend === 'gh') {
    return fetchGithubComments(prNumber, repo, since, botPatterns, spawnFn);
  }
  if (backend === 'glab') {
    return fetchGitlabComments(prNumber, repo, since, botPatterns, spawnFn);
  }
  if (backend === 'both') {
    return (
      fetchGithubComments(prNumber, repo, since, botPatterns, spawnFn) ??
      fetchGitlabComments(prNumber, repo, since, botPatterns, spawnFn)
    );
  }
  return (
    fetchGithubComments(prNumber, repo, since, botPatterns, spawnFn) ??
    fetchGitlabComments(prNumber, repo, since, botPatterns, spawnFn)
  );
}

export function prMonitorTools(db: TrajectoryDB, _spawnFn?: SpawnFn): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const spawn = _spawnFn ?? defaultSpawnFn;

  const definitions: Tool[] = [
    {
      name: 'pr_monitor_comments_get',
      description:
        'Fetch PR/MR comments from GitHub or GitLab. Returns structured comment list with bot/human classification, file/line metadata, and PR state.',
      inputSchema: {
        type: 'object',
        properties: {
          pr_number: {
            type: 'number',
            description: 'PR or MR number to fetch comments for.',
          },
          repo: {
            type: 'string',
            description: 'Optional repo slug (owner/repo) passed to gh -R / glab -R. When omitted, resolves to the sole registered repo\'s remote slug; in a multi-repo workspace it is required (a named error is returned otherwise). The cwd git remote is never used in a multi-repo workspace.',
          },
          since: {
            type: 'string',
            description: 'ISO 8601 timestamp. Only return comments created after this time. When omitted, the server reads the cursor from pr_review_runs.last_fetched_at so the next fetch returns only comments newer than the last one.',
          },
        },
        required: ['pr_number'],
      },
    },
    {
      name: 'pr_monitor_runs_list',
      description:
        'List incremental-polling cursors for /monitor. Returns one row per (pr_number, repo) with last_fetched_at + last_comment_id. Read-only diagnostic surface for the cursor wired by pr_monitor_comments_get.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          pr_number: {
            type: 'number',
            description: 'Optional filter — only return rows for this PR number.',
          },
          limit: { type: 'number', description: 'Optional — max rows to return. When provided, response includes next_cursor.' },
          cursor: { type: 'string', description: 'Opaque cursor from a previous response.' },
        },
      },
    },
  ];

  const handlers: Record<string, Fn> = {
    pr_monitor_comments_get: requireRoles('pr_monitor_comments_get', ['bro'], wrap(async (args) => {
      const prNumber = Number(args['pr_number']);
      if (!Number.isInteger(prNumber) || prNumber <= 0) {
        return err('pr_number must be a positive integer');
      }
      // Repo slug resolution (#15): explicit arg wins. Otherwise resolve the
      // sole registered repo's remote slug — never the cwd git remote. In a
      // multi-repo workspace with no slug, return a named error rather than
      // syncing against the wrong (or cwd) remote; this also keeps the
      // pr_review_runs cursor key per-repo so two repos sharing a PR number
      // can't collide on (pr_number, '').
      const explicitRepo =
        typeof args['repo'] === 'string' && (args['repo'] as string).length > 0
          ? (args['repo'] as string)
          : null;
      let repo: string;
      if (explicitRepo !== null) {
        repo = explicitRepo;
      } else {
        const repoCount = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM repos')?.c ?? 0;
        if (repoCount > 1) {
          return err(
            'pr_monitor_comments_get: multiple repos registered and no repo slug given — ' +
              'pass repo="owner/repo". The cwd git remote is never used in a multi-repo workspace.',
          );
        }
        // 0 or 1 repos: derive the sole repo's slug from its remotes; fall back
        // to '' (cwd remote) only when no repo/remote slug resolves (uninitialized).
        const resolved = resolveRepoForSync(db, null);
        const slug = resolved
          ? resolved.remotes
              .map((r) => repoSlugFromRemoteUrl(r.url))
              .find((s): s is string => s !== null) ?? null
          : null;
        repo = slug ?? '';
      }

      // Wire incremental polling: prefer the explicit `since` arg, otherwise
      // read the cursor from pr_review_runs and pass `last_fetched_at` as the
      // since-filter on the next backend fetch.
      let since: string | undefined =
        typeof args['since'] === 'string' ? args['since'] : undefined;
      if (since === undefined) {
        const cursor = db.get<{ last_fetched_at: string }>(
          `SELECT last_fetched_at FROM pr_review_runs WHERE pr_number = ? AND repo = ?`,
          [prNumber, repo],
        );
        if (cursor?.last_fetched_at) since = cursor.last_fetched_at;
      }

      const configRow = db.get<{ value_json: string }>(
        `SELECT value_json FROM plugin_config WHERE key = 'issue_sync'`,
      );
      const configValue = configRow ? (JSON.parse(configRow.value_json) as string) : 'auto';

      let backend: 'gh' | 'glab' | 'both' | 'off' | null;
      if (configValue === 'off') {
        const ghAvail = spawn('gh', ['auth', 'status'], { timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' }).status === 0;
        if (ghAvail) {
          backend = 'gh';
        } else {
          const glabAvail = spawn('glab', ['auth', 'status'], { timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' }).status === 0;
          if (!glabAvail) {
            return err('Neither gh nor glab is installed/available; cannot fetch PR comments');
          }
          backend = 'glab';
        }
      } else {
        // repoRemotes is null here: comment fetching resolves the backend from
        // the explicit/derived repo slug and resolveComments falls back to
        // trying both CLIs, so the auto decision needn't re-probe the cwd (#1043).
        backend = resolveBackend(configValue, null, _spawnFn !== undefined);
      }

      const configBots = db.get<{ value_json: string }>(
        `SELECT value_json FROM plugin_config WHERE key = 'pr_review_bots'`,
      );
      let botsOverride = '';
      if (configBots) {
        try {
          const parsed = JSON.parse(configBots.value_json) as unknown;
          if (typeof parsed === 'string') botsOverride = parsed;
        } catch {
          // malformed config row — fall through to defaults
        }
      }
      const botPatterns = buildBotPatterns(botsOverride);

      const fetchResult = resolveComments(backend, prNumber, repo, since, botPatterns, spawn);

      if (!fetchResult) {
        return err('Failed to fetch PR comments — check gh/glab auth and PR number');
      }

      const now = nowISO();
      const lastCommentId =
        fetchResult.comments.length > 0
          ? (fetchResult.comments[fetchResult.comments.length - 1]?.id ?? null)
          : null;

      // Upsert the cursor: a re-fetch of the same (pr_number, repo) should
      // overwrite last_fetched_at + last_comment_id rather than insert a
      // duplicate row. Monitoring rows always have pr_number > 0 so they
      // are covered by idx_pr_review_runs_pr (partial unique WHERE pr_number > 0).
      // Use SELECT + INSERT/UPDATE to avoid relying on partial-index ON CONFLICT.
      // Resolve the owning task from the PR head branch so the carrier
      // resolution (pr_number → pr_review_runs → tasks → issue) works in
      // production (#1024). Null when unresolvable — COALESCE keeps a
      // previously-resolved task_id rather than nulling it on a later fetch.
      const taskId = resolveMonitorTaskId(db, fetchResult.head_branch, repo);

      const existingCursor = db.get<{ id: number }>(
        'SELECT id FROM pr_review_runs WHERE pr_number = ? AND repo = ?',
        [prNumber, repo],
      );
      if (existingCursor) {
        db.run(
          'UPDATE pr_review_runs SET last_fetched_at = ?, last_comment_id = ?, task_id = COALESCE(?, task_id) WHERE id = ?',
          [now, lastCommentId, taskId, existingCursor.id],
        );
      } else {
        db.run(
          `INSERT INTO pr_review_runs (pr_number, repo, last_fetched_at, last_comment_id, task_id)
           VALUES (?, ?, ?, ?, ?)`,
          [prNumber, repo, now, lastCommentId, taskId],
        );
      }

      return ok(fetchResult);
    })),

    pr_monitor_runs_list: requireRoles('pr_monitor_runs_list', ['bro'], async (args) => {
      const prFilter = args['pr_number'];
      const filterPrNumber =
        prFilter === undefined || prFilter === null ? null : Number(prFilter);

      if (filterPrNumber !== null && (!Number.isInteger(filterPrNumber) || filterPrNumber <= 0)) {
        return err('pr_number must be a positive integer when provided');
      }

      const limitArg = args['limit'] as number | undefined;
      const cursorArg = args['cursor'] as string | undefined;

      type RunRow = {
        id: number;
        pr_number: number;
        repo: string;
        last_fetched_at: string;
        last_comment_id: string | null;
      };

      if (limitArg === undefined || limitArg === null) {
        const rows =
          filterPrNumber === null
            ? db.all<RunRow>(
                'SELECT id, pr_number, repo, last_fetched_at, last_comment_id FROM pr_review_runs ORDER BY pr_number, repo',
              )
            : db.all<RunRow>(
                'SELECT id, pr_number, repo, last_fetched_at, last_comment_id FROM pr_review_runs WHERE pr_number = ? ORDER BY repo',
                [filterPrNumber],
              );
        return ok({ rows, count: rows.length });
      }

      const limit = Math.min(Math.max(1, limitArg), 500);
      let cursorFilter = '';
      let cursorParams: unknown[] = [];

      if (cursorArg) {
        try {
          const decoded = JSON.parse(
            Buffer.from(cursorArg, 'base64').toString('utf8'),
          ) as { id: number };
          if (typeof decoded.id === 'number') {
            cursorFilter = 'AND id > ?';
            cursorParams = [decoded.id];
          }
        } catch {
          // ignore invalid cursor
        }
      }

      const whereBase = filterPrNumber !== null ? 'WHERE pr_number = ? ' : 'WHERE 1=1 ';
      const baseParams: unknown[] = filterPrNumber !== null ? [filterPrNumber] : [];

      const sql =
        'SELECT id, pr_number, repo, last_fetched_at, last_comment_id FROM pr_review_runs ' +
        whereBase +
        cursorFilter +
        ' ORDER BY id ASC LIMIT ?';

      const fetchedRows = db.all<RunRow>(sql, [...baseParams, ...cursorParams, limit + 1]);

      const hasMore = fetchedRows.length > limit;
      const rows = hasMore ? fetchedRows.slice(0, limit) : fetchedRows;
      const last = rows[rows.length - 1];
      const next_cursor =
        hasMore && last
          ? Buffer.from(JSON.stringify({ id: last.id })).toString('base64')
          : undefined;

      return ok({ rows, count: rows.length, next_cursor });
    }),
  };

  return { definitions, handlers };
}
