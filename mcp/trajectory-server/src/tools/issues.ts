import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SpawnSyncOptions } from 'node:child_process';
import type { TrajectoryDB } from '../db.js';
import { resolveDefaultRepoPath } from '../utils/repo-paths.js';
import { nowISO } from '../db.js';
import type { Issue, IssueRow, Task } from '../types.js';
import { normalizeAgent, redactIssue, requireRoles } from '../middleware/agent-scope.js';
import { resolveBackend, detectPreferred } from '../sync/backend.js';
import { syncIssueCreate, syncIssueClose, isSyncFailure } from '../sync/issue_sync.js';
import { serverLog } from '../logger.js';

type SpawnFn = (
  cmd: string,
  args: string[],
  opts: SpawnSyncOptions,
) => { status: number | null; stdout: string; stderr: string };

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

// Sync paths pass labels through to the remote (GitLab / GitHub) via
// syncIssueCreate, but they aren't persisted in the local issues table.
function decodeIssue(row: IssueRow): Issue {
  return { ...row };
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

function requireArg(args: Record<string, unknown>, name: string): unknown {
  if (args[name] === undefined || args[name] === null) {
    throw new Error(`Missing required arg: ${name}`);
  }
  return args[name];
}

function wrapHandler(fn: (args: Record<string, unknown>) => Promise<CallToolResult>): Fn {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return err((e as Error).message);
    }
  };
}

function resolveSpawnCwd(db: TrajectoryDB, dbPath: string): string | undefined {
  return resolveDefaultRepoPath(db, dbPath);
}

export function issueTools(db: TrajectoryDB, dbPath = ''): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'issue_create',
      description: 'Create a new issue with an objective and an optional full markdown description.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Caller agent name' },
          objective: { type: 'string', description: 'Short one-liner summary' },
          description: { type: 'string', description: 'Full issue description: requirements, context, acceptance criteria. Markdown. Gated from SWE for info isolation.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Optional labels to apply to the remote issue.' },
        },
        required: ['agent', 'objective'],
      },
    },
    {
      name: 'issue_get',
      description: 'Fetch a single issue by ID.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          issue_id: { type: 'string', description: 'The issue string ID' },
          include_description: { type: 'boolean', description: 'Whether to include the full description (default false). Architect + bro only.' },
        },
        required: ['agent', 'issue_id'],
      },
    },
    {
      name: 'issue_resume',
      description: 'Return an issue with its first actionable pending/failed task.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          issue_id: { type: 'string' },
        },
        required: ['agent', 'issue_id'],
      },
    },
    {
      name: 'issue_close',
      description: 'Close an issue by setting its status to closed.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          issue_id: { type: 'string' },
        },
        required: ['agent', 'issue_id'],
      },
    },
    {
      name: 'issue_get_phase',
      description: 'Return the current workflow phase and task completion counts for an issue.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          issue_id: { type: 'string' },
        },
        required: ['agent', 'issue_id'],
      },
    },
        {
      name: 'issue_list',
      description: 'Enumerate issues for the bro pre-scan. Returns a thin index (id, objective, status, created_at, updated_at) ordered by updated_at DESC. Used at session start to decide whether to resume an in-flight issue or start fresh.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          status: {
            type: 'string',
            enum: ['open', 'in_progress', 'closed'],
            description: 'Optional status filter. Omit to return all issues.',
          },
          limit: { type: 'number', description: 'Max rows. Default 50, max 200.' },
          offset: { type: 'number', description: 'Row offset. Default 0.' },
        },
        required: ['agent'],
      },
    },
    {
      name: 'issue_update_description',
      description: "Update an issue's description. Used by bro to backfill issues whose descriptions were truncated on import (e.g., from Linear).",
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: ['bro'], description: 'Calling agent identity (bro only)' },
          issue_id: { type: 'string', description: 'Issue ID as string' },
          description: { type: 'string', description: 'Full markdown description (no length cap)' },
        },
        required: ['agent', 'issue_id', 'description'],
      },
    },
    {
      name: 'issue_sync_retry',
      description: 'Manually retry remote sync for an issue where auto-sync failed. Bro only.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: ['bro'], description: 'Calling agent identity (bro only)' },
          issue_id: { type: 'string', description: 'Issue ID as string' },
        },
        required: ['agent', 'issue_id'],
      },
    },
  ];

  const handlers: Record<string, Fn> = {
    issue_create: requireRoles('issue_create', ['bro'], wrapHandler(async (args) => {
      const agent = normalizeAgent(args['agent'] as string | undefined);
      requireArg(args, 'objective');

      const objective = args['objective'] as string;
      const description = (args['description'] as string | undefined) ?? '';
      // labels: pass-through to remote sync; not persisted locally after #179.
      const labels = (args['labels'] as string[] | undefined) ?? [];
      // _spawnFn: test-only injection point; not in inputSchema
      const spawnFn = (args['_spawnFn'] as SpawnFn | undefined) ?? undefined;
      const now = nowISO();

      db.run(
        `INSERT INTO issues (objective, description, status, created_at, updated_at)
         VALUES (?, ?, 'open', ?, ?)`,
        [objective, description, now, now],
      );

      const rowId = db.get<{ id: number }>(
        `SELECT id FROM issues WHERE rowid = last_insert_rowid()`,
      );

      if (!rowId) {
        throw new Error('issue_create: failed to retrieve inserted row');
      }

      const issueId = rowId.id;

      const syncConfigRow = db.get<{ value_json: string }>(
        `SELECT value_json FROM plugin_config WHERE key = 'issue_sync'`,
      );
      const syncConfig: string = syncConfigRow
        ? (JSON.parse(syncConfigRow.value_json) as string)
        : 'off';

      // #2871 — collect any sync diagnostic that the caller (bro) should
      // see inline. The trajectory log alone is invisible to the agent.
      let syncDiagnostic: Record<string, unknown> | undefined;

      if (syncConfig !== 'off') {
        const backend = resolveBackend(syncConfig, !!spawnFn);
        if (backend === null) {
          serverLog({ event: 'issue_sync_skip', reason: 'no_remote_configured', issueId });
        } else if (backend !== 'off') {
          const syncResult = await syncIssueCreate({
            issueId,
            title: objective,
            body: description,
            labels,
            _backend: backend,
            _spawnFn: spawnFn,
            _cwd: resolveSpawnCwd(db, dbPath),
          });
          if (!isSyncFailure(syncResult)) {
            db.run(
              `UPDATE issues SET remote_iid = ?, remote_kind = ?, updated_at = ? WHERE id = ?`,
              [syncResult.remote_iid, syncResult.remote_kind, now, issueId],
            );
          } else {
            serverLog({
              event: 'issue_sync_failed',
              issueId,
              backend,
              reason: syncResult.reason,
              exit_code: syncResult.exit_code,
              stderr: syncResult.stderr?.slice(0, 1024),
              message: syncResult.message,
            });
            syncDiagnostic = {
              sync_failed: true,
              reason: syncResult.reason,
              backend: syncResult.backend,
              exit_code: syncResult.exit_code,
              stderr: syncResult.stderr?.slice(0, 4096),
              stdout: syncResult.stdout?.slice(0, 4096),
              message: syncResult.message,
              hint: 'Try `issue_sync_retry` or run the underlying gh/glab command manually to debug.',
            };
          }
        }
      } else {
        // #2871 Bug 1 — work env had `issue_sync='off'` while origin pointed at
        // GitLab; issues silently never reached the remote. Surface a warning
        // when the project clearly looks remote-tracked (git origin is gh/glab)
        // but sync is disabled, so bro can mention it instead of hiding the drift.
        const preferred = detectPreferred();
        if (preferred !== null) {
          syncDiagnostic = {
            sync_skipped: true,
            reason: 'issue_sync is "off" but origin points at ' + preferred,
            hint: 'If this project should mirror issues to the remote, run `config_set(key="issue_sync", value="auto")`.',
          };
        }
      }

      const row = db.get<IssueRow>('SELECT * FROM issues WHERE id = ?', [issueId]);
      const issue = decodeIssue(row!);
      const redacted = redactIssue(issue, agent, { include_description: true });
      const payload: Record<string, unknown> = { ...(redacted as Record<string, unknown>) };
      if (syncDiagnostic) payload._sync = syncDiagnostic;
      return ok(payload);
    })),

    issue_get: wrapHandler(async (args) => {
      const agent = normalizeAgent(args['agent'] as string | undefined);
      const issueId = requireArg(args, 'issue_id') as string;
      const includeDescription = (args['include_description'] as boolean | undefined) ?? false;

      const row = db.get<IssueRow>('SELECT * FROM issues WHERE id = ?', [issueId]);
      if (!row) {
        throw new Error(`Not found: ${issueId}`);
      }
      const issue = decodeIssue(row);

      return ok(redactIssue(issue, agent, { include_description: includeDescription }));
    }),

    issue_resume: wrapHandler(async (args) => {
      const agent = normalizeAgent(args['agent'] as string | undefined);
      const issueId = requireArg(args, 'issue_id') as string;

      const row = db.get<IssueRow>('SELECT * FROM issues WHERE id = ?', [issueId]);
      if (!row) {
        throw new Error(`Not found: ${issueId}`);
      }
      const issue = decodeIssue(row);

      const task = db.get<Task>(
        `SELECT * FROM tasks
         WHERE issue_id = ? AND status IN ('pending', 'failed')
         ORDER BY branch_id ASC
         LIMIT 1`,
        [issueId],
      );

      return ok({ issue: redactIssue(issue, agent), next_task: task ?? null });
    }),

    issue_close: requireRoles('issue_close', ['bro'], wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const issueId = requireArg(args, 'issue_id') as string;

      const now = nowISO();

      const existing = db.get<IssueRow>('SELECT * FROM issues WHERE id = ?', [issueId]);
      if (!existing) {
        throw new Error(`Not found: ${issueId}`);
      }

      db.run(
        `UPDATE issues
         SET status = 'closed', updated_at = ?, closed_at = COALESCE(closed_at, ?)
         WHERE id = ?`,
        [now, now, issueId],
      );

      const remoteRow = db.get<{ remote_iid: number | null; remote_kind: string | null }>(
        `SELECT remote_iid, remote_kind FROM issues WHERE id = ?`,
        [issueId],
      );
      if (remoteRow?.remote_iid != null && remoteRow.remote_kind != null) {
        const closeResult = await syncIssueClose({
          remote_iid: remoteRow.remote_iid,
          remote_kind: remoteRow.remote_kind as 'github' | 'gitlab',
          _cwd: resolveSpawnCwd(db, dbPath),
        });
        if (!closeResult.ok) {
          serverLog({
            event: 'issue_close_sync_failed',
            issueId,
            remote_iid: remoteRow.remote_iid,
            reason: closeResult.reason,
            exit_code: closeResult.exit_code,
            stderr: closeResult.stderr?.slice(0, 1024),
            message: closeResult.message,
          });
        }
      }

      const updated = db.get<IssueRow>('SELECT * FROM issues WHERE id = ?', [issueId]);
      return ok(decodeIssue(updated!));
    })),

    issue_get_phase: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const issueId = requireArg(args, 'issue_id') as string;

      const issueRow = db.get<IssueRow>('SELECT * FROM issues WHERE id = ?', [issueId]);
      if (!issueRow) {
        throw new Error(`Not found: ${issueId}`);
      }
      const issue = decodeIssue(issueRow);

      const counts = db.get<{
        tasks_total: number;
        tasks_completed: number;
        tasks_failed: number;
      }>(
        `SELECT
           COUNT(*) as tasks_total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as tasks_completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as tasks_failed
         FROM tasks WHERE issue_id = ?`,
        [issueId],
      ) ?? { tasks_total: 0, tasks_completed: 0, tasks_failed: 0 };

      let phase: 'discussion' | 'blueprint' | 'tasks' | 'done' | 'ready_to_close';
      if (issue.status === 'closed') {
        phase = 'done';
      } else if (counts.tasks_total === 0) {
        phase = 'discussion';
      } else if (counts.tasks_completed >= counts.tasks_total) {
        phase = 'ready_to_close';
      } else {
        phase = 'tasks';
      }

      return ok({ phase, counts });
    }),

    issue_list: wrapHandler(async (args) => {
      normalizeAgent(args['agent'] as string | undefined);
      const rawStatus = args['status'] as string | undefined;
      const rawLimit = (args['limit'] as number | undefined) ?? 50;
      const rawOffset = (args['offset'] as number | undefined) ?? 0;
      const limit = Math.min(Math.max(1, rawLimit), 200);
      const offset = Math.max(0, rawOffset);

      const VALID_ISSUE_STATUSES = new Set(['open', 'in_progress', 'closed']);
      if (rawStatus !== undefined && !VALID_ISSUE_STATUSES.has(rawStatus)) {
        return err(
          `Invalid status: "${rawStatus}". Allowed values: ${[...VALID_ISSUE_STATUSES].join(', ')}`,
        );
      }

      let rows: Array<{ id: number; objective: string; status: string; created_at: string; updated_at: string }>;
      if (rawStatus !== undefined) {
        rows = db.all(
          `SELECT id, objective, status, created_at, updated_at FROM issues WHERE status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
          [rawStatus, limit, offset],
        );
      } else {
        rows = db.all(
          `SELECT id, objective, status, created_at, updated_at FROM issues ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
          [limit, offset],
        );
      }
      return ok(rows);
    }),

    issue_update_description: requireRoles('issue_update_description', ['bro'], wrapHandler(async (args) => {
      const issueId = requireArg(args, 'issue_id') as string;
      const description = requireArg(args, 'description') as string;

      const MAX_DESCRIPTION_BYTES = 1024 * 1024; // 1MB
      if (Buffer.byteLength(description, 'utf8') > MAX_DESCRIPTION_BYTES) {
        return err('description exceeds 1MB limit');
      }

      const existing = db.get<{ id: number }>('SELECT id FROM issues WHERE id = ?', [issueId]);
      if (!existing) {
        return err(`not_found: issue ${issueId}`);
      }

      const now = nowISO();
      db.run(
        'UPDATE issues SET description = ?, updated_at = ? WHERE id = ?',
        [description, now, issueId],
      );

      const updated = db.get<IssueRow>('SELECT * FROM issues WHERE id = ?', [issueId]);
      return ok(decodeIssue(updated!));
    })),

    issue_sync_retry: requireRoles('issue_sync_retry', ['bro'], wrapHandler(async (args) => {
      const issueId = requireArg(args, 'issue_id') as string;

      const row = db.get<IssueRow>('SELECT * FROM issues WHERE id = ?', [issueId]);
      if (!row) {
        return err(`not_found: issue ${issueId}`);
      }

      const syncConfigRow = db.get<{ value_json: string }>(
        `SELECT value_json FROM plugin_config WHERE key = 'issue_sync'`,
      );
      const syncConfig: string = syncConfigRow
        ? (JSON.parse(syncConfigRow.value_json) as string)
        : 'off';

      if (syncConfig === 'off') {
        return ok({ skipped: true, reason: 'issue_sync is off' });
      }

      const backend = resolveBackend(syncConfig);
      if (backend === null || backend === 'off') {
        return ok({ skipped: true, reason: 'no remote backend configured' });
      }

      const issue = decodeIssue(row);

      if (row.status === 'closed' && row.remote_iid != null && row.remote_kind != null) {
        const closeResult = await syncIssueClose({
          remote_iid: row.remote_iid,
          remote_kind: row.remote_kind,
        });
        if (closeResult.ok) {
          return ok({ action: 'close', success: true });
        }
        // #2871: surface the diagnostic so bro can see why the close failed
        // instead of just `{success:false}`.
        return ok({
          action: 'close',
          success: false,
          error: {
            reason: closeResult.reason,
            exit_code: closeResult.exit_code,
            stderr: closeResult.stderr?.slice(0, 4096),
            stdout: closeResult.stdout?.slice(0, 4096),
            message: closeResult.message,
          },
        });
      }

      const syncResult = await syncIssueCreate({
        issueId: row.id,
        title: issue.objective,
        body: row.description,
        // Labels are not persisted locally after #179 (always-empty in
        // production). Remote retry can't restore lost labels; pass empty.
        labels: [],
        _backend: backend,
        // #2877: workspace-pattern projects need glab/gh shellouts to run
        // inside one of the discovered repos, not the workspace root which
        // isn't a git repo. resolveSpawnCwd reads tmb_default_repo.
        _cwd: resolveSpawnCwd(db, dbPath),
      });

      if (!isSyncFailure(syncResult)) {
        db.run(
          `UPDATE issues SET remote_iid = ?, remote_kind = ?, updated_at = ? WHERE id = ?`,
          [syncResult.remote_iid, syncResult.remote_kind, nowISO(), issueId],
        );
        return ok({ action: 'create', success: true, remote_iid: syncResult.remote_iid, remote_kind: syncResult.remote_kind });
      }

      // #2871: surface the diagnostic so bro can see why the create failed
      // instead of just `{success:false}` with no clue.
      return ok({
        action: 'create',
        success: false,
        error: {
          reason: syncResult.reason,
          backend: syncResult.backend,
          exit_code: syncResult.exit_code,
          stderr: syncResult.stderr?.slice(0, 4096),
          stdout: syncResult.stdout?.slice(0, 4096),
          message: syncResult.message,
        },
      });
    })),

  };

  return { definitions, handlers };
}
