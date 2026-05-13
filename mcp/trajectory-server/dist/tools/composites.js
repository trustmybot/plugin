import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { resolveDefaultRepo } from '../utils/repo-paths.js';
import { BRANCH_ID_RE } from './tasks.js';
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
function md5OfBuffer(buf) {
    return createHash('md5').update(buf).digest('hex');
}
export function compositeTools(db, dbPath) {
    const definitions = [
        {
            name: 'branch_id_propose',
            description: 'Heuristic-only branch_id derivation: takes free-text intent + objective, returns ' +
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
            description: "Retry composite — collapses the prior 5-call retry recipe (read failure, append " +
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
                        description: "Branch_id for the retry (must be different from the failed task's branch_id; same conventional format).",
                    },
                    corrected_spec_body: { type: 'string', description: 'The new spec_body — ≤8000 chars.' },
                    retry_rationale: {
                        type: 'string',
                        description: "≤200 chars — the root cause and corrected approach. Persisted as discussion(kind='decision').",
                    },
                    title: { type: 'string' },
                    description: { type: 'string' },
                    success_criteria: { type: 'string' },
                },
                required: [
                    'agent',
                    'failed_task_id',
                    'new_branch_id',
                    'corrected_spec_body',
                    'retry_rationale',
                    'description',
                    'success_criteria',
                ],
            },
        },
        {
            name: 'bro_atomic_close',
            description: 'Bro task-close composite — collapses the V3 four-call batch (audit, summaries, ' +
                'task close, optional issue close) into one DB transaction. Server-side enforcement of ' +
                'the close-step ordering eliminates the L5 close-drift failure mode. Hooks downstream of ' +
                '`task_update_status` still fire (cleanup-worktree, audit log).',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    task_id: { type: 'string' },
                    commit_sha: { type: 'string' },
                    file_summaries: {
                        type: 'array',
                        description: 'Per-touched-path summaries that bro authored after V1/V2 verification. ' +
                            "Server md5's each path against the commit_sha so the registry stays truthful.",
                        items: {
                            type: 'object',
                            properties: {
                                path: { type: 'string' },
                                summary: { type: 'string' },
                                repo: {
                                    type: 'string',
                                    description: 'Optional repo name from repos table. Defaults to tasks.repo, then tmb_default_repo. Required for workspace-pattern projects so paths resolve against the right inner repo.',
                                },
                            },
                            required: ['path', 'summary'],
                        },
                    },
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
                required: ['agent', 'task_id', 'commit_sha', 'file_summaries', 'verification_summary'],
            },
        },
    ];
    const handlers = {
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
            const successCriteria = args['success_criteria'];
            const title = args['title'] ?? '';
            if (!BRANCH_ID_RE.test(newBranchId)) {
                return err(`Invalid new_branch_id "${newBranchId}" — does not match conventional format.`);
            }
            if (!spec || spec.length > 8000) {
                return err('corrected_spec_body must be 1..8000 chars.');
            }
            if (!rationale || rationale.length > 200) {
                return err('retry_rationale must be 1..200 chars.');
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
                    failed.repo,
                    now,
                    now,
                ]);
                const newTask = db.get('SELECT id, branch_id FROM tasks WHERE rowid = last_insert_rowid()');
                if (!newTask)
                    throw new Error('insert succeeded but row lookup failed');
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
        bro_atomic_close: requireRoles('bro_atomic_close', ['bro'], wrap(async (args) => {
            const taskId = args['task_id'];
            const commitSha = args['commit_sha'];
            const summaries = args['file_summaries'];
            const verificationSummary = args['verification_summary'];
            const closeIssueIfLast = args['close_issue_if_last_task'] === true;
            if (!commitSha || !/^[0-9a-f]{7,40}$/i.test(commitSha)) {
                return err('commit_sha must be a 7..40-char hex SHA.');
            }
            if (!Array.isArray(summaries) || summaries.length === 0) {
                return err('file_summaries must be a non-empty array of { path, summary }.');
            }
            for (const s of summaries) {
                if (!s || typeof s.path !== 'string' || typeof s.summary !== 'string') {
                    return err('each file_summaries entry must have string { path, summary }.');
                }
            }
            const task = db.get('SELECT id, issue_id, branch_id, status, repo FROM tasks WHERE id = ? LIMIT 1', [taskId]);
            if (!task)
                return err(`No task with id=${taskId}`);
            if (task.status !== 'completed' && task.status !== 'needs_validation') {
                return err(`Task ${taskId} status is "${task.status}", expected "completed" or "needs_validation". ` +
                    `bro_atomic_close runs after SWE flips status to completed.`);
            }
            const now = nowISO();
            const result = db.transaction(() => {
                // 1. bro_verification_pass audit row.
                db.run(`INSERT INTO audit
               (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (?, ?, 'bro', 'bro_verification_pass', ?, ?, ?)`, [
                    task.issue_id,
                    task.branch_id,
                    verificationSummary.slice(0, 200),
                    JSON.stringify({ task_id: task.id, commit_sha: commitSha, file_count: summaries.length }),
                    now,
                ]);
                // 2. file_registry summaries — per-update repo resolution + md5 each
                // path against the commit. Multi-repo workspace pattern requires
                // resolving paths under the right inner repo, not the workspace root.
                // Resolution order (per #2885 sibling fix): explicit s.repo → task.repo
                // → tmb_default_repo → error mentioning all three.
                const summaryErrors = [];
                let summarized = 0;
                const defaultRepo = resolveDefaultRepo(db, dbPath);
                for (const s of summaries) {
                    const explicit = typeof s.repo === 'string' && s.repo.length > 0 ? s.repo : null;
                    const repoName = explicit ?? task.repo ?? defaultRepo?.name ?? null;
                    if (!repoName) {
                        summaryErrors.push({
                            path: s.path,
                            error: 'no repo specified, task.repo unset, and tmb_default_repo not set — ' +
                                'pass `repo` on the file_summaries entry, or set task.repo via task_create_batch, ' +
                                'or run /scan to populate tmb_default_repo',
                        });
                        continue;
                    }
                    const repoRow = db.get(`SELECT path FROM repos WHERE name = ?`, [repoName]);
                    if (!repoRow?.path) {
                        summaryErrors.push({
                            path: s.path,
                            error: `repo '${repoName}' not found in repos table — run /scan first`,
                        });
                        continue;
                    }
                    const repoRoot = repoRow.path;
                    let md5 = null;
                    const abs = isAbsolute(s.path) ? s.path : resolve(repoRoot, s.path);
                    if (existsSync(abs)) {
                        try {
                            md5 = md5OfBuffer(readFileSync(abs));
                        }
                        catch {
                            /* fallthrough */
                        }
                    }
                    if (md5 === null) {
                        try {
                            const buf = execFileSync('git', ['show', `${commitSha}:${s.path}`], {
                                cwd: repoRoot,
                                stdio: ['ignore', 'pipe', 'ignore'],
                                maxBuffer: 64 * 1024 * 1024,
                            });
                            md5 = md5OfBuffer(buf);
                        }
                        catch {
                            summaryErrors.push({
                                path: s.path,
                                error: `not on disk at ${abs} and not in commit ${commitSha} of ${repoName}`,
                            });
                            continue;
                        }
                    }
                    db.run(`INSERT INTO file_registry (repo, path, type, content_md5, summary, summary_updated_at)
               VALUES (?, ?, 'unknown', ?, ?, ?)
               ON CONFLICT(repo, path) DO UPDATE SET
                 content_md5        = excluded.content_md5,
                 summary            = excluded.summary,
                 summary_updated_at = excluded.summary_updated_at`, [repoName, s.path, md5, s.summary, now]);
                    summarized += 1;
                }
                if (summaryErrors.length > 0) {
                    throw new Error(`bro_atomic_close: ${summaryErrors.length} file(s) failed summary md5 (` +
                        summaryErrors.map((e) => `${e.path}: ${e.error}`).join('; ') +
                        `). Aborted before status flip.`);
                }
                // Advance last_verified_sha — invariant the close-gate hook checks.
                db.run(`INSERT INTO plugin_config (key, value_json)
             VALUES ('last_verified_sha', ?)
             ON CONFLICT(key) DO UPDATE SET
               value_json = excluded.value_json`, [JSON.stringify(commitSha)]);
                // 3. flip task to closed.
                db.run(`UPDATE tasks
                SET status='closed', commit_sha=?, completed_at=COALESCE(completed_at, ?), updated_at=?
              WHERE id=?`, [commitSha, now, now, task.id]);
                // 4. optional issue_close — only when this was the last open/active task.
                let issueClosed = false;
                if (closeIssueIfLast) {
                    const remaining = db.get(`SELECT COUNT(*) AS c FROM tasks
                WHERE issue_id = ?
                  AND status NOT IN ('closed', 'failed', 'escalated')`, [task.issue_id]);
                    if ((remaining?.c ?? 0) === 0) {
                        db.run(`UPDATE issues SET status='closed', updated_at=? WHERE id=? AND status != 'closed'`, [now, task.issue_id]);
                        issueClosed = true;
                    }
                }
                return { task_id: task.id, summarized, issue_closed: issueClosed };
            });
            return ok(result);
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=composites.js.map