import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { execFileSync } from 'node:child_process';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { BRANCH_ID_RE, SPEC_BODY_MAX_BYTES } from './tasks.js';

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

export function compositeTools(
  db: TrajectoryDB,
  _dbPath: string,
): { definitions: Tool[]; handlers: Record<string, Fn> } {
  const definitions: Tool[] = [
    {
      name: 'branch_id_propose',
      description:
        'Heuristic-only branch_id derivation: takes free-text intent + objective, returns ' +
        '{ branch_id, confidence }. Pure function — no DB writes. Bro confirms with ' +
        'Human via AskUserQuestion before persisting.',
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
      name: 'task_retry_batch',
      description:
        "Retry composite — collapses the prior 5-call retry recipe (read failure, append " +
        "rationale, create new task, log audit) into one transaction. Caller passes the " +
        "failed task_id, the corrected spec_body, and the rationale. Server inherits issue_id, " +
        "parent_branch_id, and repo from the failed task. Returns the new task row.",
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
          title: { type: 'string' },
          description: { type: 'string' },
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
      name: 'headless_intent_start',
      description:
        'Headless fast-path composite — collapses the 3-call sequence that always follows ' +
        'issue_create in headless mode (headless_fallback audit_log + fallback note + intent ' +
        'discussion_append) into one atomic DB write. Eliminates compound-failure risk on the ' +
        'headless path where AUQ errors are impossible to recover from interactively.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          issue_id: { type: 'number', description: 'Issue ID returned by issue_create.' },
          branch_id: { type: 'string', description: 'Proposed branch_id (from branch_id_propose).' },
          intent_verbatim: { type: 'string', description: 'Human intent verbatim — stored as kind=intent discussion.' },
          fallback_summary: {
            type: 'string',
            description: 'One-line summary of what defaults were applied. Stored in audit row.',
          },
        },
        required: ['agent', 'issue_id', 'branch_id', 'intent_verbatim'],
      },
    },
    {
      name: 'bro_verification_fail_record',
      description:
        'V3-fail composite — collapses the 2-call sequence (audit_log + discussion_append) ' +
        'that bro must emit when a verification check fails into one atomic DB write. ' +
        'Prevents the common drop-last-call failure mode where the note lands but the audit ' +
        'row is skipped (or vice versa), leaving the trajectory in a partial state.',
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
      name: 'pr_review_worktree',
      description:
        'PR-review worktree composite — creates a per-SHA worktree at /tmp/pr-review-<sha>, ' +
        'runs a caller-supplied verification command inside it, then removes the worktree ' +
        'atomically. Collapses the 4-step setup/verify/teardown sequence from §A of tmb_review ' +
        'into one call, eliminating the compound-failure risk of stranded worktrees.',
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
      name: 'reap_and_review_prep',
      description:
        'Commit-reap composite — for each unsigned task, fetches the detached HEAD from ' +
        'the per-task worktree into the main checkout under the task\'s branch_id. ' +
        'Returns a list of { task_id, branch_id, commit_sha } ready for pr-reviewer spawn. ' +
        'Collapses the per-task `git fetch ./.claude/worktrees/<slug> HEAD:<branch_id>` loop ' +
        'from §B of tmb_review into one call.',
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
        'Bro task-close composite — writes the bro_verification_pass audit row, advances ' +
        'last_verified_sha, flips the task to closed, and optionally closes the parent issue, ' +
        'all in one DB transaction. Hooks downstream of `task_update_status` still fire ' +
        '(cleanup-worktree, post-task-close-rescan, audit log).',
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
              'When true and this is the issue\'s last open task, also close the issue in the ' +
              'same transaction.',
          },
        },
        required: ['agent', 'task_id', 'commit_sha', 'verification_summary'],
      },
    },
  ];

  const handlers: Record<string, Fn> = {
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

    task_retry_batch: requireRoles(
      'task_retry_batch',
      ['bro'],
      wrap(async (args) => {
        const failedTaskId = args['failed_task_id'] as string;
        const newBranchId = args['new_branch_id'] as string;
        const spec = args['corrected_spec_body'] as string;
        const rationale = args['retry_rationale'] as string;
        const description = args['description'] as string;
        const title = (args['title'] as string | undefined) ?? '';

        if (!BRANCH_ID_RE.test(newBranchId)) {
          return err(`Invalid new_branch_id "${newBranchId}" — does not match conventional format.`);
        }
        if (!spec || spec.length > SPEC_BODY_MAX_BYTES) {
          return err(`corrected_spec_body must be 1..${SPEC_BODY_MAX_BYTES} chars (override via TMB_SPEC_BODY_MAX_BYTES).`);
        }
        if (!rationale || rationale.length > 200) {
          return err('retry_rationale must be 1..200 chars.');
        }

        const failed = db.get<{
          id: number;
          issue_id: number;
          branch_id: string;
          parent_branch_id: string | null;
          repo: string | null;
          status: string;
        }>(
          `SELECT id, issue_id, branch_id, parent_branch_id, repo, status
             FROM tasks WHERE id = ? LIMIT 1`,
          [failedTaskId],
        );
        if (!failed) return err(`No task with id=${failedTaskId}`);
        if (failed.status !== 'failed' && failed.status !== 'escalated') {
          return err(
            `Task ${failedTaskId} status is "${failed.status}", expected "failed" or "escalated". ` +
              `task_retry_batch only operates on terminally-failed tasks.`,
          );
        }
        if (failed.branch_id === newBranchId) {
          return err('new_branch_id must differ from the failed task\'s branch_id.');
        }

        const now = nowISO();
        const result = db.transaction(() => {
          db.run(
            `INSERT INTO discussions (issue_id, author, kind, body, created_at)
             VALUES (?, 'bro', 'decision', ?, ?)`,
            [failed.issue_id, `Retry rationale (failed task ${failedTaskId}): ${rationale}`, now],
          );

          db.run(
            `INSERT INTO tasks
               (issue_id, branch_id, parent_branch_id, title, description,
                status, attempts, spec_body, repo, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
            [
              failed.issue_id,
              newBranchId,
              failed.parent_branch_id ?? failed.branch_id,
              title,
              description,
              spec,
              failed.repo,
              now,
              now,
            ],
          );

          const newTask = db.get<{ id: number; branch_id: string }>(
            'SELECT id, branch_id FROM tasks WHERE rowid = last_insert_rowid()',
          );
          if (!newTask) throw new Error('insert succeeded but row lookup failed');

          // Bro-as-agent_run (#2886): open a bro row for the retry task,
          // mirror of the task_create_batch case.
          db.run(
            `INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at)
             VALUES (?, ?, 'bro', ?)`,
            [newTask.id, failed.issue_id, now],
          );

          db.run(
            `INSERT INTO audit
               (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (?, ?, 'bro', 'task_retry_attempted', ?, ?, ?)`,
            [
              failed.issue_id,
              newBranchId,
              `Retry of failed task ${failedTaskId}: ${rationale.slice(0, 120)}`,
              JSON.stringify({
                failed_task_id: failed.id,
                new_task_id: newTask.id,
                new_branch_id: newBranchId,
              }),
              now,
            ],
          );

          return newTask;
        });

        return ok({ task_id: result.id, branch_id: result.branch_id });
      }),
    ),

    headless_intent_start: requireRoles(
      'headless_intent_start',
      ['bro'],
      wrap(async (args) => {
        const issueId = args['issue_id'] as number;
        const branchId = args['branch_id'] as string;
        const intentVerbatim = args['intent_verbatim'] as string;
        const fallbackSummary =
          (args['fallback_summary'] as string | undefined) ??
          'headless mode: defaults applied';

        if (!issueId || typeof issueId !== 'number') {
          return err('issue_id must be a number');
        }
        if (!intentVerbatim || intentVerbatim.trim().length === 0) {
          return err('intent_verbatim must be a non-empty string');
        }

        const now = nowISO();
        db.transaction(() => {
          db.run(
            `INSERT INTO audit
               (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (?, ?, 'bro', 'headless_fallback', ?, ?, ?)`,
            [
              issueId,
              branchId,
              `tmb_planning headless: branch_id confirm → Yes, proceed; cold-start → lazy fill; defaults applied`,
              JSON.stringify({ fallback_summary: fallbackSummary }),
              now,
            ],
          );
          db.run(
            `INSERT INTO discussions (issue_id, author, kind, body, created_at)
             VALUES (?, 'bro', 'note', ?, ?)`,
            [issueId, 'Headless fallback: no Human in loop; defaults applied.', now],
          );
          db.run(
            `INSERT INTO discussions (issue_id, author, kind, body, created_at)
             VALUES (?, 'bro', 'intent', ?, ?)`,
            [issueId, `Human intent verbatim: "${intentVerbatim}"`, now],
          );
        });

        return ok({ issue_id: issueId, branch_id: branchId, written: ['audit', 'note', 'intent'] });
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
          db.run(
            `INSERT INTO audit
               (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (?, ?, 'bro', 'bro_verification_fail', ?, ?, ?)`,
            [
              task.issue_id,
              task.branch_id,
              summary,
              JSON.stringify({ task_id: task.id, which_check: whichCheck, details }),
              now,
            ],
          );
          db.run(
            `INSERT INTO discussions (issue_id, author, kind, body, created_at)
             VALUES (?, 'bro', 'note', ?, ?)`,
            [task.issue_id, `Verification fail: ${summary}`, now],
          );
        });

        return ok({ task_id: task.id, which_check: whichCheck, written: ['audit', 'note'] });
      }),
    ),

    pr_review_worktree: requireRoles(
      'pr_review_worktree',
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

        const wtPath = `/tmp/pr-review-${commitSha}`;
        let stdout = '';
        let stderr = '';
        let exitCode = 0;

        try {
          execFileSync('git', ['-C', repoPath, 'worktree', 'add', wtPath, commitSha], {
            stdio: ['ignore', 'pipe', 'pipe'],
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
            });
          } catch {
            // best-effort cleanup; don't override the command result
          }
        }

        return ok({ worktree: wtPath, exit_code: exitCode, stdout: stdout.slice(0, 4096), stderr: stderr.slice(0, 2048) });
      }),
    ),

    reap_and_review_prep: requireRoles(
      'reap_and_review_prep',
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

        const results: Array<{ task_id: number; branch_id: string; slug: string; commit_sha: string | null; reaped: boolean; error?: string }> = [];

        for (const tid of taskIds) {
          const task = db.get<{ id: number; branch_id: string; commit_sha: string | null }>(
            'SELECT id, branch_id, commit_sha FROM tasks WHERE id = ? LIMIT 1',
            [tid],
          );
          if (!task) {
            results.push({ task_id: Number(tid), branch_id: '', slug: '', commit_sha: null, reaped: false, error: `No task with id=${tid}` });
            continue;
          }
          const slug = task.branch_id.replace(/^[^/]+\//, '');
          const wtPath = `${repoPath}/.claude/worktrees/${slug}`;

          try {
            execFileSync(
              'git',
              ['-C', repoPath, 'fetch', wtPath, `HEAD:${task.branch_id}`],
              { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
            );
            results.push({ task_id: task.id, branch_id: task.branch_id, slug, commit_sha: task.commit_sha, reaped: true });
          } catch (e) {
            results.push({ task_id: task.id, branch_id: task.branch_id, slug, commit_sha: task.commit_sha, reaped: false, error: (e as Error).message });
          }
        }

        return ok({ reaped: results });
      }),
    ),

    bro_atomic_close: requireRoles(
      'bro_atomic_close',
      ['bro'],
      wrap(async (args) => {
        const taskId = args['task_id'] as string;
        const commitSha = ((args['commit_sha'] as string) ?? '').toLowerCase();
        const verificationSummary = args['verification_summary'] as string;
        const closeIssueIfLast = args['close_issue_if_last_task'] === true;

        if (!commitSha || !/^[0-9a-f]{7,40}$/.test(commitSha)) {
          return err('commit_sha must be a 7..40-char hex SHA.');
        }

        const task = db.get<{
          id: number;
          issue_id: number;
          branch_id: string;
          status: string;
          repo: string | null;
        }>(
          'SELECT id, issue_id, branch_id, status, repo FROM tasks WHERE id = ? LIMIT 1',
          [taskId],
        );
        if (!task) return err(`No task with id=${taskId}`);
        if (task.status !== 'completed' && task.status !== 'needs_validation') {
          return err(
            `Task ${taskId} status is "${task.status}", expected "completed" or "needs_validation". ` +
              `bro_atomic_close runs after SWE flips status to completed.`,
          );
        }

        const now = nowISO();
        const summarized = 0;

        const result = db.transaction(() => {
          // 1. bro_verification_pass audit row.
          db.run(
            `INSERT INTO audit
               (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (?, ?, 'bro', 'bro_verification_pass', ?, ?, ?)`,
            [
              task.issue_id,
              task.branch_id,
              verificationSummary.slice(0, 200),
              JSON.stringify({ task_id: task.id, commit_sha: commitSha }),
              now,
            ],
          );

          // Advance last_verified_sha — invariant the close-gate hook checks.
          db.run(
            `INSERT INTO plugin_config (key, value_json)
             VALUES ('last_verified_sha', ?)
             ON CONFLICT(key) DO UPDATE SET
               value_json = excluded.value_json`,
            [JSON.stringify(commitSha)],
          );

          // 3. flip task to closed.
          db.run(
            `UPDATE tasks
                SET status='closed', commit_sha=?, completed_at=COALESCE(completed_at, ?), updated_at=?
              WHERE id=?`,
            [commitSha, now, now, task.id],
          );

          // 3b. Bro-as-agent_run (#2886): finalize the bro row opened by
          // task_create_batch. duration_ms is the wall-clock between started_at
          // and now; tokens stay at 0 here — a follow-up hook will accumulate
          // them from the transcript_path. Only update the row that hasn't
          // been completed yet (idempotent on re-close).
          db.run(
            `UPDATE agent_runs
                SET completed_at = ?,
                    duration_ms = COALESCE(
                      (strftime('%s', ?) - strftime('%s', started_at)) * 1000,
                      0
                    )
              WHERE task_id = ?
                AND agent_type = 'bro'
                AND completed_at IS NULL`,
            [now, now, task.id],
          );

          // 4. optional issue_close — only when this was the last open/active task.
          let issueClosed = false;
          if (closeIssueIfLast) {
            const remaining = db.get<{ c: number }>(
              `SELECT COUNT(*) AS c FROM tasks
                WHERE issue_id = ?
                  AND status NOT IN ('closed', 'failed', 'escalated')`,
              [task.issue_id],
            );
            if ((remaining?.c ?? 0) === 0) {
              db.run(
                `UPDATE issues SET status='closed', closed_at=COALESCE(closed_at,?), updated_at=? WHERE id=? AND status != 'closed'`,
                [now, now, task.issue_id],
              );
              issueClosed = true;
            }
          }

          return { task_id: task.id, summarized, issue_closed: issueClosed };
        });

        return ok(result);
      }),
    ),
  };

  return { definitions, handlers };
}
