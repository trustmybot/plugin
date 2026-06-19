import { execFileSync } from 'node:child_process';
import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { BRANCH_ID_RE, SPEC_BODY_MAX_BYTES } from './tasks.js';
import { syncIssueCloseRemotes, resolveDefaultMilestone } from './issues.js';
import { resolveDefaultIssueId } from './discussions.js';
import { resolveDefaultRepo, resolveRepoForSync } from '../utils/repo-paths.js';
const WORKTREE_TIMEOUT_MS = 60_000;
// Extract the unique directories implied by a task's typed `files[]` array. Each
// entry is a path; its dirname is the directory ('' = repo root). task_brief
// resolves these against the world model. (#300)
export function filesToDirs(files) {
    const dirs = new Set();
    for (const path of files) {
        const slash = path.lastIndexOf('/');
        dirs.add(slash >= 0 ? path.slice(0, slash) : '');
    }
    return [...dirs];
}
// Parse the tasks.files JSON column into a string[] (empty on null/malformed).
export function parseTaskFiles(filesJson) {
    if (!filesJson)
        return [];
    try {
        const parsed = JSON.parse(filesJson);
        return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : [];
    }
    catch {
        return [];
    }
}
function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function err(message) {
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
    };
}
function wrap(fn) {
    return async (args) => {
        try {
            return await fn(args);
        }
        catch (e) {
            return err(e.message);
        }
    };
}
// Slug → kebab-case, alphanumeric + hyphens, ≤63 chars. Reused by
// branch_id_propose. Strips diacritics and collapses repeated hyphens.
function slugify(s) {
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
function intentToType(text) {
    const lower = text.toLowerCase();
    const rules = [
        { prefix: 'fix', patterns: [/\bfix\b/, /\bbug\b/, /\bbroken\b/, /\bcrash\b/, /\bregression\b/] },
        { prefix: 'feat', patterns: [/\badd\b/, /\bnew\b/, /\bimplement\b/, /\bintroduce\b/] },
        { prefix: 'refactor', patterns: [/\brename\b/, /\bextract\b/, /\brestructure\b/, /\bclean[\s-]?up\b/, /\brefactor\b/] },
        { prefix: 'docs', patterns: [/\bdocs?\b/, /\breadme\b/, /\bcomment(s|ing)?\b/] },
        { prefix: 'test', patterns: [/\btest(s|ing)?\b/, /\bcoverage\b/] },
        { prefix: 'perf', patterns: [/\bperf(ormance)?\b/, /\bspeed up\b/, /\boptimi[sz]e\b/, /\blatency\b/] },
        { prefix: 'build', patterns: [/\bbuild script\b/, /\bdependency\b/, /\bdep(s|endency) bump\b/] },
        { prefix: 'ci', patterns: [/\bci\b/, /\bpipeline\b/, /\bgithub action\b/] },
        { prefix: 'chore', patterns: [/\bchore\b/, /\bhousekeeping\b/, /\bcleanup\b/] },
        { prefix: 'style', patterns: [/\bformat(ting)?\b/, /\bwhitespace\b/, /\blint\b/] },
        { prefix: 'revert', patterns: [/\brevert\b/, /\broll back\b/] },
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
function insertIntentAndNote(db, issueId, intentVerbatim, noteLine, now) {
    const existing = db.get(`SELECT id FROM discussions
      WHERE issue_id = ? AND kind = 'intent' AND body = ?
      LIMIT 1`, [issueId, `Human intent verbatim: "${intentVerbatim}"`]);
    db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
     VALUES (?, 'bro', 'note', ?, ?)`, [issueId, noteLine, now]);
    const written = ['note'];
    if (!existing) {
        db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
       VALUES (?, 'bro', 'intent', ?, ?)`, [issueId, `Human intent verbatim: "${intentVerbatim}"`, now]);
        written.push('intent');
    }
    return written;
}
// Shared close path for bro_atomic_close + task_recover: in the caller's
// transaction, advance a task to closed (writing bro_verification_pass +
// finalizing the bro agent_run row) and optionally close the parent issue when
// this was its last open task. Returns whether the issue was closed so the
// caller can mirror the close to the remote after the transaction commits.
function closeTaskInTx(db, task, commitSha, verificationSummary, now, closeIssueIfLast) {
    // 1. bro_verification_pass audit row.
    db.run(`INSERT INTO audit
       (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
     VALUES (?, ?, 'bro', 'bro_verification_pass', ?, ?, ?)`, [
        task.issue_id,
        task.branch_id,
        verificationSummary.slice(0, 200),
        JSON.stringify({ task_id: task.id, commit_sha: commitSha }),
        now,
    ]);
    // 2. flip task to closed.
    db.run(`UPDATE tasks
        SET status='closed', commit_sha=?, completed_at=COALESCE(completed_at, ?), updated_at=?
      WHERE id=?`, [commitSha, now, now, task.id]);
    // 3. Bro-as-agent_run (#2886): finalize the bro row opened by
    // task_create_batch. Only update the row that hasn't been completed yet
    // (idempotent on re-close).
    db.run(`UPDATE agent_runs
        SET completed_at = ?,
            duration_ms = COALESCE(
              (strftime('%s', ?) - strftime('%s', started_at)) * 1000,
              0
            )
      WHERE task_id = ?
        AND agent_type = 'bro'
        AND completed_at IS NULL`, [now, now, task.id]);
    // 4. optional issue_close — only when this was the last open/active task.
    let issueClosed = false;
    if (closeIssueIfLast) {
        const remaining = db.get(`SELECT COUNT(*) AS c FROM tasks
        WHERE issue_id = ?
          AND status NOT IN ('closed', 'failed', 'escalated')`, [task.issue_id]);
        if ((remaining?.c ?? 0) === 0) {
            db.run(`UPDATE issues SET status='closed', closed_at=COALESCE(closed_at,?), updated_at=? WHERE id=? AND status != 'closed'`, [now, now, task.issue_id]);
            issueClosed = true;
        }
    }
    return { issue_closed: issueClosed };
}
export function compositeTools(db, dbPath, graph = null) {
    const definitions = [
        {
            name: 'branch_id_propose',
            description: 'Heuristic-only branch_id derivation from free-text intent + objective, returning { branch_id, confidence }; pure, no DB writes.',
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
            description: "Retry composite — one transaction: reads the failed task, appends rationale, creates a " +
                "new task inheriting issue_id/parent_branch_id/repo (overridable). Returns the new task row.",
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    failed_task_id: { type: 'string' },
                    new_branch_id: {
                        type: 'string',
                        description: "Branch_id for the retry (must be different from the failed task's branch_id; same conventional format).",
                    },
                    corrected_spec_body: { type: 'string', description: `The new spec_body — ≤${SPEC_BODY_MAX_BYTES} chars (override via TMB_SPEC_BODY_MAX_BYTES).` },
                    retry_rationale: {
                        type: 'string',
                        description: "≤200 chars — the root cause and corrected approach. Persisted as discussion(kind='decision').",
                    },
                    repo: {
                        type: 'string',
                        description: 'Optional repo override — replaces the repo inherited from the failed task. ' +
                            'Must not contain ".." or start with "/". Omit to inherit.',
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
            description: 'Headless fast-path composite — atomically writes the headless_fallback audit_log + fallback note + intent discussion that follow issue_create in headless mode.',
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
            name: 'intent_start',
            description: 'Interactive planning composite — atomically runs issue_create + discussion_append(intent) + ' +
                'discussion_append(note) + audit_log(branch_id_proposed). Git branch creation stays caller-side. ' +
                'Returns {issue_id, branch_id}.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    objective: { type: 'string', description: 'Short one-liner issue objective.' },
                    intent_verbatim: { type: 'string', description: 'Human intent verbatim — stored as kind=intent discussion.' },
                    branch_id: { type: 'string', description: 'Confirmed branch_id (from branch_id_propose + Human confirm).' },
                },
                required: ['agent', 'objective', 'intent_verbatim', 'branch_id'],
            },
        },
        {
            name: 'headless_fallback_record',
            description: 'Headless fallback composite — atomically writes audit_log(headless_fallback) + discussion_append(note); issue_id defaults to the most recent open issue or -1.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    question: { type: 'string', description: 'The AskUserQuestion prompt that was skipped in headless mode.' },
                    chosen_default: { type: 'string', description: 'The default value that was applied.' },
                    skill: { type: 'string', description: 'Which tmb_* skill triggered this fallback.' },
                    issue_id: { type: 'number', description: 'Optional override. Defaults to most recent open issue or -1.' },
                },
                required: ['agent', 'question', 'chosen_default', 'skill'],
            },
        },
        {
            name: 'bro_verification_fail_record',
            description: 'V3-fail composite — atomically writes the audit_log + discussion_append that bro emits when a verification check fails.',
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
            description: 'PR-review worktree composite — creates a per-SHA worktree at /tmp/pr-review-<sha>, runs a caller-supplied command inside it, then removes the worktree atomically.',
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
            description: 'Commit-reap composite — fetches each task\'s worktree HEAD into the main checkout under branch_id, returning { task_id, branch_id, commit_sha }[] ready for pr-reviewer spawn.',
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
            description: 'Bro task-close composite — writes bro_verification_pass, advances the task to closed, and optionally closes the parent issue, all in one DB transaction. ' +
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
                        description: 'When true and this is the issue\'s last open task, also close the issue in the ' +
                            'same transaction.',
                    },
                },
                required: ['agent', 'task_id', 'commit_sha', 'verification_summary'],
            },
        },
        {
            name: 'task_recover',
            description: 'Bro task-recovery composite — deterministically recovers a SWE task left stuck pending/completed after the executor died: with a commit_sha it closes the task (and optionally the issue), without one it returns a re-dispatch directive, and a non-recoverable status is an idempotent no-op.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    task_id: { type: 'string' },
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
                        description: 'When true and this is the issue\'s last open task, also close the issue in the ' +
                            'same transaction.',
                    },
                },
                required: ['agent', 'task_id'],
            },
        },
        {
            name: 'task_brief',
            description: "Full context bundle for one task in a single call — swe's only context read; joins the trajectory DB (task row, spec_body, the issue's discussion thread) with the kuzu world model for each directory the task's files[] touch.",
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
    const handlers = {
        task_brief: requireRoles('task_brief', ['bro', 'swe', 'pr-reviewer'], wrap(async (args) => {
            const taskId = args['task_id'];
            if (taskId === undefined || taskId === null)
                return err('task_id is required');
            const task = db.get(`SELECT t.id, t.issue_id, t.branch_id, t.title, t.status, t.spec_body, t.files, t.commit_sha, t.repo,
                  i.objective
             FROM tasks t JOIN issues i ON i.id = t.issue_id
            WHERE t.id = ? LIMIT 1`, [taskId]);
            if (!task)
                return err(`No task with id=${taskId}`);
            // Resolve repo: task.repo, else the single-repo fallback (path-keyed
            // resolution — empty in multi-repo projects, which scope by task.repo).
            let repo = task.repo ?? '';
            if (!repo) {
                repo = resolveDefaultRepo(db)?.name ?? '';
            }
            // Scope: the dirs the task's typed files[] touch, resolved in the world model.
            const dirs = filesToDirs(parseTaskFiles(task.files));
            let scope_world_model = [];
            let world_model_warning;
            if (!graph) {
                world_model_warning = 'world-model-unavailable';
            }
            else {
                const nodes = graph.allDirectoriesForRepo(repo);
                if (nodes.length === 0) {
                    world_model_warning = 'world-model-empty';
                }
                else {
                    const byPath = new Map(nodes.map((n) => [n.path, n]));
                    const childrenByParent = new Map();
                    for (const n of nodes) {
                        const key = n.parent_path ?? '';
                        if (!childrenByParent.has(key))
                            childrenByParent.set(key, []);
                        childrenByParent.get(key).push(n);
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
            const raw = db.all(`SELECT author, kind, body, created_at FROM discussions
            WHERE issue_id = ? ORDER BY created_at ASC LIMIT 200`, [task.issue_id]);
            const FULL_KINDS = new Set(['decision', 'intent']);
            const NOTE_CAP = 500;
            const OTHER_ROW_CAP = 8;
            const full = raw.filter((d) => FULL_KINDS.has(d.kind));
            const other = raw.filter((d) => !FULL_KINDS.has(d.kind)).slice(-OTHER_ROW_CAP);
            const task_discussions = raw
                .filter((d) => full.includes(d) || other.includes(d))
                .map((d) => {
                if (FULL_KINDS.has(d.kind) || d.body.length <= NOTE_CAP)
                    return d;
                return {
                    ...d,
                    body: d.body.slice(0, NOTE_CAP) +
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
                scope_world_model,
                ...(world_model_warning ? { world_model_warning } : {}),
                task_discussions,
            });
        })),
        branch_id_propose: requireRoles('branch_id_propose', ['bro'], wrap(async (args) => {
            const intent = args['intent'];
            if (typeof intent !== 'string' || intent.trim().length === 0) {
                return err('intent must be a non-empty string');
            }
            const objective = args['objective'] ?? intent;
            const { prefix, confidence } = intentToType(intent);
            const slug = slugify(objective) || slugify(intent) || 'task';
            const branchId = `${prefix}/${slug}`;
            if (!BRANCH_ID_RE.test(branchId)) {
                return err(`Derived branch_id "${branchId}" does not match the conventional regex. ` +
                    `Pick a clearer objective and re-call.`);
            }
            return ok({ branch_id: branchId, confidence });
        })),
        task_retry_batch: requireRoles('task_retry_batch', ['bro'], wrap(async (args) => {
            const failedTaskId = args['failed_task_id'];
            const newBranchId = args['new_branch_id'];
            const spec = args['corrected_spec_body'];
            const rationale = args['retry_rationale'];
            const description = args['description'];
            const title = args['title'] ?? '';
            const repoOverride = args['repo'] ?? null;
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
            const failed = db.get(`SELECT id, issue_id, branch_id, parent_branch_id, repo, status
             FROM tasks WHERE id = ? LIMIT 1`, [failedTaskId]);
            if (!failed)
                return err(`No task with id=${failedTaskId}`);
            if (failed.status !== 'failed' && failed.status !== 'escalated') {
                return err(`Task ${failedTaskId} status is "${failed.status}", expected "failed" or "escalated". ` +
                    `task_retry_batch only operates on terminally-failed tasks.`);
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
                    const row = db.get(`SELECT content_json FROM audit
                WHERE event_type = 'task_retry_attempted'
                  AND json_extract(content_json, '$.new_task_id') = ?
                LIMIT 1`, [currentTaskId]);
                    if (!row)
                        break;
                    const parsed = JSON.parse(row.content_json);
                    currentTaskId = parsed.failed_task_id;
                    depth++;
                }
                if (depth >= RETRY_CAP) {
                    return err(`retry limit reached (3) — escalate to Human. ` +
                        `Task ${failedTaskId} already has ${depth} prior attempt(s) in its retry lineage. ` +
                        `Use discussion_append(kind='question') to involve the Human before retrying further.`);
                }
            }
            const now = nowISO();
            const result = db.transaction(() => {
                db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
             VALUES (?, 'bro', 'decision', ?, ?)`, [failed.issue_id, `Retry rationale (failed task ${failedTaskId}): ${rationale}`, now]);
                db.run(`INSERT INTO tasks
               (issue_id, branch_id, parent_branch_id, title, description,
                status, attempts, spec_body, repo, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`, [
                    failed.issue_id,
                    newBranchId,
                    failed.parent_branch_id ?? failed.branch_id,
                    title,
                    description,
                    spec,
                    repoOverride ?? failed.repo,
                    now,
                    now,
                ]);
                const newTask = db.get('SELECT id, branch_id FROM tasks WHERE rowid = last_insert_rowid()');
                if (!newTask)
                    throw new Error('insert succeeded but row lookup failed');
                // Bro-as-agent_run (#2886): open a bro row for the retry task,
                // mirror of the task_create_batch case.
                db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at)
             VALUES (?, ?, 'bro', ?)`, [newTask.id, failed.issue_id, now]);
                db.run(`INSERT INTO audit
               (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (?, ?, 'bro', 'task_retry_attempted', ?, ?, ?)`, [
                    failed.issue_id,
                    newBranchId,
                    `Retry of failed task ${failedTaskId}: ${rationale.slice(0, 120)}`,
                    JSON.stringify({
                        failed_task_id: failed.id,
                        new_task_id: newTask.id,
                        new_branch_id: newBranchId,
                    }),
                    now,
                ]);
                return newTask;
            });
            return ok({ task_id: result.id, branch_id: result.branch_id });
        })),
        headless_intent_start: requireRoles('headless_intent_start', ['bro'], wrap(async (args) => {
            const issueId = args['issue_id'];
            const branchId = args['branch_id'];
            const intentVerbatim = args['intent_verbatim'];
            const fallbackSummary = args['fallback_summary'] ??
                'headless mode: defaults applied';
            if (!issueId || typeof issueId !== 'number') {
                return err('issue_id must be a number');
            }
            if (!intentVerbatim || intentVerbatim.trim().length === 0) {
                return err('intent_verbatim must be a non-empty string');
            }
            const now = nowISO();
            let written = [];
            db.transaction(() => {
                db.run(`INSERT INTO audit
               (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (?, ?, 'bro', 'headless_fallback', ?, ?, ?)`, [
                    issueId,
                    branchId,
                    `tmb_planning headless: branch_id confirm → Yes, proceed; cold-start → lazy fill; defaults applied`,
                    JSON.stringify({ fallback_summary: fallbackSummary }),
                    now,
                ]);
                written = insertIntentAndNote(db, issueId, intentVerbatim, 'Headless fallback: no Human in loop; defaults applied.', now);
            });
            return ok({ issue_id: issueId, branch_id: branchId, written: ['audit', ...written] });
        })),
        intent_start: requireRoles('intent_start', ['bro'], wrap(async (args) => {
            const objective = args['objective'];
            const intentVerbatim = args['intent_verbatim'];
            const branchId = args['branch_id'];
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
            const now = nowISO();
            // Default the milestone from `tmb_active_milestone` (#154), mirroring
            // issue_create. Resolve the sole-repo first so the FK milestones row is
            // upserted under the right repo before the issues insert.
            const issueRepo = resolveRepoForSync(db, null)?.name ?? null;
            const milestone = resolveDefaultMilestone(db, null, issueRepo);
            const result = db.transaction(() => {
                db.run(`INSERT INTO issues (objective, description, status, created_at, updated_at, milestone, repo)
             VALUES (?, '', 'open', ?, ?, ?, ?)`, [objective, now, now, milestone, issueRepo]);
                const row = db.get(`SELECT id FROM issues WHERE rowid = last_insert_rowid()`);
                if (!row)
                    throw new Error('intent_start: failed to retrieve inserted issue');
                const issueId = row.id;
                insertIntentAndNote(db, issueId, intentVerbatim, `Beginning planning on ${branchId}.`, now);
                db.run(`INSERT INTO audit
               (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (?, ?, 'bro', 'branch_id_proposed', ?, ?, ?)`, [
                    issueId,
                    branchId,
                    `branch_id proposed: ${branchId} for "${objective.slice(0, 80)}"`,
                    JSON.stringify({ branch_id: branchId, objective }),
                    now,
                ]);
                return { issue_id: issueId, branch_id: branchId };
            });
            return ok(result);
        })),
        headless_fallback_record: requireRoles('headless_fallback_record', ['bro'], wrap(async (args) => {
            const question = args['question'];
            const chosenDefault = args['chosen_default'];
            const skill = args['skill'];
            if (!question || question.trim().length === 0) {
                return err('question must be a non-empty string');
            }
            if (!chosenDefault || chosenDefault.trim().length === 0) {
                return err('chosen_default must be a non-empty string');
            }
            if (!skill || skill.trim().length === 0) {
                return err('skill must be a non-empty string');
            }
            let issueId = args['issue_id'] ?? null;
            if (issueId === null) {
                issueId = resolveDefaultIssueId(db);
            }
            const now = nowISO();
            const noteBody = `Headless fallback (${skill}): question skipped — applied default "${chosenDefault}".`;
            db.transaction(() => {
                db.run(`INSERT INTO audit
               (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (?, NULL, 'bro', 'headless_fallback', ?, ?, ?)`, [
                    issueId,
                    `${skill}: "${question.slice(0, 120)}" → default: "${chosenDefault.slice(0, 80)}"`,
                    JSON.stringify({ skill, question, chosen_default: chosenDefault }),
                    now,
                ]);
                db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
             VALUES (?, 'bro', 'note', ?, ?)`, [issueId, noteBody, now]);
            });
            return ok({ issue_id: issueId, written: ['audit', 'note'] });
        })),
        bro_verification_fail_record: requireRoles('bro_verification_fail_record', ['bro'], wrap(async (args) => {
            const taskId = args['task_id'];
            const whichCheck = args['which_check'];
            const details = args['details'];
            if (!taskId)
                return err('task_id is required');
            if (!whichCheck || whichCheck.trim().length === 0) {
                return err('which_check must be a non-empty string');
            }
            if (!details || details.trim().length === 0) {
                return err('details must be a non-empty string');
            }
            if (details.length > 500) {
                return err('details must be ≤500 chars');
            }
            const task = db.get('SELECT id, issue_id, branch_id FROM tasks WHERE id = ? LIMIT 1', [taskId]);
            if (!task)
                return err(`No task with id=${taskId}`);
            const summary = `${whichCheck} — ${details.slice(0, 160)}`;
            const now = nowISO();
            db.transaction(() => {
                db.run(`INSERT INTO audit
               (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (?, ?, 'bro', 'bro_verification_fail', ?, ?, ?)`, [
                    task.issue_id,
                    task.branch_id,
                    summary,
                    JSON.stringify({ task_id: task.id, which_check: whichCheck, details }),
                    now,
                ]);
                db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
             VALUES (?, 'bro', 'note', ?, ?)`, [task.issue_id, `Verification fail: ${summary}`, now]);
            });
            return ok({ task_id: task.id, which_check: whichCheck, written: ['audit', 'note'] });
        })),
        pr_monitor_worktree: requireRoles('pr_monitor_worktree', ['pr-reviewer'], wrap(async (args) => {
            const commitSha = (args['commit_sha'] ?? '').toLowerCase();
            const repoPath = args['repo_path'];
            const command = args['command'];
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
                    timeout: WORKTREE_TIMEOUT_MS,
                });
            }
            catch (e) {
                return err(`worktree add failed: ${e.message}`);
            }
            try {
                const result = execFileSync('bash', ['-c', command], {
                    cwd: wtPath,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    timeout: 60_000,
                });
                stdout = result.toString('utf8');
            }
            catch (e) {
                const spawnErr = e;
                stdout = spawnErr.stdout?.toString('utf8') ?? '';
                stderr = spawnErr.stderr?.toString('utf8') ?? spawnErr.message ?? '';
                exitCode = spawnErr.status ?? 1;
            }
            finally {
                try {
                    execFileSync('git', ['-C', repoPath, 'worktree', 'remove', '--force', wtPath], {
                        stdio: 'ignore',
                        timeout: WORKTREE_TIMEOUT_MS,
                    });
                }
                catch {
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
        })),
        reap_and_review_prep: requireRoles('reap_and_review_prep', ['bro'], wrap(async (args) => {
            const taskIds = args['task_ids'];
            const repoPath = args['repo_path'];
            if (!Array.isArray(taskIds) || taskIds.length === 0) {
                return err('task_ids must be a non-empty array');
            }
            if (!repoPath || !repoPath.startsWith('/')) {
                return err('repo_path must be an absolute path');
            }
            const results = [];
            for (const tid of taskIds) {
                const task = db.get('SELECT id, branch_id, commit_sha FROM tasks WHERE id = ? LIMIT 1', [tid]);
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
                        const refSha = execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', `refs/heads/${task.branch_id}`], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
                            .toString()
                            .trim();
                        if (refSha.toLowerCase().startsWith(task.commit_sha.toLowerCase())) {
                            results.push({ task_id: task.id, branch_id: task.branch_id, slug, commit_sha: task.commit_sha, reaped: true });
                            continue;
                        }
                    }
                    catch {
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
                        targetSha = execFileSync('git', ['-C', wtPath, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
                            .toString()
                            .trim();
                    }
                    execFileSync('git', ['-C', repoPath, 'update-ref', `refs/heads/${task.branch_id}`, targetSha], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
                    results.push({ task_id: task.id, branch_id: task.branch_id, slug, commit_sha: task.commit_sha ?? targetSha, reaped: true });
                }
                catch (e) {
                    results.push({ task_id: task.id, branch_id: task.branch_id, slug, commit_sha: task.commit_sha, reaped: false, error: e.message });
                }
            }
            const anyFailed = results.some((r) => !r.reaped);
            const allReaped = results.length > 0 && !anyFailed;
            return {
                content: [{ type: 'text', text: JSON.stringify({ reaped: results, all_reaped: allReaped }) }],
                isError: anyFailed,
            };
        })),
        bro_atomic_close: requireRoles('bro_atomic_close', ['bro'], wrap(async (args) => {
            const taskId = args['task_id'];
            if (!taskId)
                return err('Missing required arg: task_id');
            const commitSha = (args['commit_sha'] ?? '').toLowerCase();
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
            const task = db.get('SELECT id, issue_id, branch_id, status, repo FROM tasks WHERE id = ? LIMIT 1', [taskId]);
            if (!task)
                return err(`No task with id=${taskId}`);
            if (task.status !== 'completed' && task.status !== 'needs_validation') {
                return err(`Task ${taskId} status is "${task.status}", expected "completed" or "needs_validation". ` +
                    `bro_atomic_close runs after SWE flips status to completed.`);
            }
            const now = nowISO();
            const result = db.transaction(() => {
                const { issue_closed } = closeTaskInTx(db, task, commitSha, verificationSummary, now, closeIssueIfLast);
                return { task_id: task.id, issue_closed };
            });
            // Mirror the close to the linked remote(s) — same path issue_close
            // uses — so closing the last task via the composite doesn't leave the
            // GitHub/GitLab issue open (#277). Runs after the local transaction
            // commits because the sync spawns gh/glab (async, can't sit inside the
            // synchronous db.transaction).
            if (result.issue_closed) {
                await syncIssueCloseRemotes(db, dbPath, task.issue_id, args['_spawnFn']);
            }
            return ok(result);
        })),
        task_recover: requireRoles('task_recover', ['bro'], wrap(async (args) => {
            const taskId = args['task_id'];
            if (!taskId)
                return err('Missing required arg: task_id');
            const commitArg = args['commit_sha'];
            let commitSha = null;
            if (commitArg !== undefined && commitArg !== null && commitArg !== '') {
                if (typeof commitArg !== 'string')
                    return err('commit_sha must be a string');
                const lowered = commitArg.toLowerCase();
                if (!/^[0-9a-f]{7,40}$/.test(lowered)) {
                    return err('commit_sha must be a 7..40-char hex SHA.');
                }
                commitSha = lowered;
            }
            const verificationSummary = typeof args['verification_summary'] === 'string'
                ? args['verification_summary']
                : `task_recover: stuck-pending recovery for task ${taskId}`;
            const closeIssueIfLast = args['close_issue_if_last_task'] === true;
            const task = db.get('SELECT id, issue_id, branch_id, status FROM tasks WHERE id = ? LIMIT 1', [taskId]);
            if (!task)
                return err(`No task with id=${taskId}`);
            // Idempotent: already-closed (or any non-recoverable status) → no-op
            // naming the status. Never throws on an already-recovered task.
            if (task.status !== 'pending' && task.status !== 'completed') {
                return ok({
                    recovered: false,
                    action: 'noop',
                    task_id: task.id,
                    status: task.status,
                    reason: `task is "${task.status}" — not in a recoverable (pending/completed) state`,
                });
            }
            // Pending with no commit: the work isn't there to recover — directive.
            if (!commitSha) {
                return ok({
                    recovered: false,
                    action: 're-dispatch',
                    task_id: task.id,
                    reason: 'no commit on a pending task — re-dispatch SWE',
                });
            }
            const now = nowISO();
            const result = db.transaction(() => {
                // task_recovered audit row — records the deterministic recovery.
                db.run(`INSERT INTO audit
               (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (?, ?, 'bro', 'task_recovered', ?, ?, ?)`, [
                    task.issue_id,
                    task.branch_id,
                    `Recovered stuck-${task.status} task ${task.id} at ${commitSha}`,
                    JSON.stringify({ task_id: task.id, commit_sha: commitSha, prior_status: task.status }),
                    now,
                ]);
                const { issue_closed } = closeTaskInTx(db, task, commitSha, verificationSummary, now, closeIssueIfLast);
                return { task_id: task.id, issue_closed };
            });
            if (result.issue_closed) {
                await syncIssueCloseRemotes(db, dbPath, task.issue_id, args['_spawnFn']);
            }
            return ok({
                recovered: true,
                action: 'closed',
                task_id: task.id,
                commit_sha: commitSha,
                issue_closed: result.issue_closed,
            });
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=composites.js.map