import { genId, nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
export const BRANCH_ID_RE = /^(feat|fix|refactor|chore|docs|test|perf|build|ci|style|revert)\/[a-z0-9][a-z0-9-]{0,62}$/;
function validateBranchId(branchId) {
    if (!BRANCH_ID_RE.test(branchId)) {
        throw new Error(`Invalid branch_id "${branchId}". Must match git-convention format: <type>/<slug> ` +
            `where <type> is one of feat|fix|refactor|chore|docs|test|perf|build|ci|style|revert ` +
            `and <slug> is lowercase alnum + hyphens (max 63 chars). Examples: feat/user-login, fix/auth-crash.`);
    }
}
const VALID_STATUSES = new Set([
    'pending',
    'running',
    'needs_validation',
    'completed',
    'closed',
    'failed',
    'escalated',
]);
function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function err(message) {
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
    };
}
function requireArg(args, name) {
    if (args[name] === undefined || args[name] === null) {
        throw new Error(`Missing required arg: ${name}`);
    }
    return args[name];
}
function wrapHandler(fn) {
    return async (args) => {
        try {
            return await fn(args);
        }
        catch (e) {
            return err(e.message);
        }
    };
}
export function taskTools(db) {
    const definitions = [
        {
            name: 'task_create_batch',
            description: 'Insert multiple tasks for an issue in a single transaction. branch_id MUST be a git-convention name (feat/foo, fix/bar, refactor/baz, etc.); it doubles as the working git branch.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    issue_id: { type: 'string' },
                    tasks: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                branch_id: { type: 'string' },
                                parent_branch_id: { type: 'string' },
                                title: { type: 'string' },
                                description: { type: 'string' },
                                tools_required: { type: 'array', items: { type: 'string' } },
                                skills_required: { type: 'array', items: { type: 'string' } },
                                success_criteria: { type: 'string' },
                                spec_body: {
                                    type: 'string',
                                    description: 'Full markdown body SWE reads. Required for any task that will be SWE-executed. Max 64000 chars.',
                                },
                            },
                            required: ['branch_id', 'description', 'success_criteria'],
                        },
                    },
                    waive_scope_gate: {
                        type: 'boolean',
                        description: "Set true to bypass the scope-ambiguity gate. Only acceptable for truly trivial changes (typo fix, one-line doc change, etc.) where no Q+A was needed. If false or omitted, the issue MUST have at least one discussion row with kind='question' before tasks can be created.",
                    },
                    waive_scope_gate_reason: {
                        type: 'string',
                        description: "Required when waive_scope_gate=true. Min 10 chars. Explain why this task has no Human-reviewed scope (e.g. 'typo fix in README line 12; no interpretation needed').",
                    },
                },
                required: ['agent', 'issue_id', 'tasks'],
            },
        },
        {
            name: 'task_get',
            description: 'Fetch a single task by ID.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    task_id: { type: 'string' },
                },
                required: ['agent', 'task_id'],
            },
        },
        {
            name: 'task_update_status',
            description: 'Update the status of a task. Optionally records a commit SHA in the same transaction, ensuring status and SHA are persisted atomically.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    task_id: { type: 'string' },
                    status: {
                        type: 'string',
                        enum: ['pending', 'running', 'needs_validation', 'completed', 'closed', 'failed', 'escalated'],
                    },
                    attempts: { type: 'number' },
                    commit_sha: {
                        type: 'string',
                        description: 'Optional git commit SHA (full 40-char or short 7+ char hex). Persisted atomically with the status update.',
                    },
                },
                required: ['agent', 'task_id', 'status'],
            },
        },
        {
            name: 'task_first_actionable',
            description: 'Returns the lex-lowest pending/failed task for an issue (groups by type prefix: chore<ci<docs<feat<...). branch_id ordering is lexicographic over git-convention names.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    issue_id: { type: 'string' },
                },
                required: ['agent', 'issue_id'],
            },
        },
    ];
    const handlers = {
        task_create_batch: requireRoles('task_create_batch', ['bro'], wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const issueId = requireArg(args, 'issue_id');
            requireArg(args, 'tasks');
            const taskInputs = args['tasks'];
            if (!Array.isArray(taskInputs) || taskInputs.length === 0) {
                return ok([]);
            }
            // --- Scope-ambiguity gate (MCP-level enforcement) ---
            // Every task_create_batch must be preceded by at least one
            // discussion row with kind='question' for this issue, UNLESS the
            // caller explicitly waives the gate with a written reason. This
            // stops the LLM from silently bypassing the alignment loop under
            // auto-mode pressure.
            const waived = args['waive_scope_gate'] === true;
            const waiverReason = (args['waive_scope_gate_reason'] ?? '');
            if (waived) {
                if (typeof waiverReason !== 'string' || waiverReason.trim().length < 10) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: "waive_scope_gate_reason must be a string ≥10 chars. Explain why this task has no Human-reviewed scope.",
                                }),
                            },
                        ],
                    };
                }
            }
            else {
                const row = db.get(`SELECT COUNT(*) as c FROM discussions WHERE issue_id = ? AND kind = 'question'`, [issueId]);
                const questionCount = row?.c ?? 0;
                if (questionCount === 0) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: 'scope_gate_violation',
                                    message: `Scope-ambiguity gate: issue ${issueId} has zero kind='question' discussions. ` +
                                        `Before creating tasks, architect must ask the Human at least one clarifying ` +
                                        `question via discussion_append(kind='question') and record their answer via ` +
                                        `discussion_append(kind='answer'). For truly trivial changes (typo fix, one-line ` +
                                        `doc), pass waive_scope_gate=true with waive_scope_gate_reason="<why trivial>".`,
                                    issue_id: issueId,
                                    questions_found: 0,
                                }),
                            },
                        ],
                    };
                }
            }
            const inserted = db.transaction(() => {
                const results = [];
                const now = nowISO();
                for (const t of taskInputs) {
                    if (!t.branch_id)
                        throw new Error('Missing required arg: branch_id');
                    validateBranchId(t.branch_id);
                    if (t.parent_branch_id != null)
                        validateBranchId(t.parent_branch_id);
                    if (!t.description)
                        throw new Error('Missing required arg: description');
                    if (!t.success_criteria)
                        throw new Error('Missing required arg: success_criteria');
                    if (t.spec_body !== undefined) {
                        if (typeof t.spec_body !== 'string') {
                            throw new Error(`spec_body must be a string, got ${typeof t.spec_body}`);
                        }
                        // Hard cap: 8000 chars per task. Architect should cite existing
                        // code/conventions rather than restate them; a spec longer than
                        // ~8k is usually a sign the task should be split. Over-long specs
                        // force SWE to spend tokens reading instead of coding.
                        // See issue #55 (P0: architect over-engineered 55k-char spec
                        // → session hang).
                        if (t.spec_body.length > 8000) {
                            throw new Error(`spec_body exceeds 8000 char limit (actual: ${t.spec_body.length}). ` +
                                `Split into multiple tasks via depends_on, or cite existing code/` +
                                `conventions rather than restating them inline. Very long specs ` +
                                `push SWE cold-start into the minutes range; see issue #55.`);
                        }
                    }
                    void genId('task');
                    db.run(`INSERT INTO tasks
               (issue_id, branch_id, parent_branch_id, title, description,
                tools_required, skills_required, success_criteria,
                status, attempts, spec_body, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`, [
                        issueId,
                        t.branch_id,
                        t.parent_branch_id ?? null,
                        t.title ?? '',
                        t.description,
                        JSON.stringify(t.tools_required ?? []),
                        JSON.stringify(t.skills_required ?? []),
                        t.success_criteria,
                        t.spec_body ?? '',
                        now,
                        now,
                    ]);
                    const row = db.get('SELECT * FROM tasks WHERE rowid = last_insert_rowid()');
                    if (row)
                        results.push(row);
                }
                return results;
            });
            // Audit log for gate waivers so pr-reviewer / human-review can flag
            // tasks that skipped the alignment loop.
            if (waived) {
                const now = nowISO();
                db.run(`INSERT INTO ledger (issue_id, branch_id, from_node, event_type, summary, content, created_at)
           VALUES (?, ?, ?, 'scope_gate_waived', ?, ?, ?)`, [
                    issueId,
                    inserted[0]?.branch_id ?? '',
                    args['agent'],
                    waiverReason.slice(0, 200),
                    JSON.stringify({
                        waive_scope_gate_reason: waiverReason,
                        tasks_created: inserted.length,
                    }),
                    now,
                ]);
            }
            return ok(inserted);
        })),
        task_get: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const taskId = requireArg(args, 'task_id');
            const task = db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
            if (!task) {
                throw new Error(`Not found: ${taskId}`);
            }
            return ok(task);
        }),
        task_update_status: requireRoles('task_update_status', ['bro', 'swe'], wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const taskId = requireArg(args, 'task_id');
            const status = requireArg(args, 'status');
            const rawCommitSha = args['commit_sha'];
            if (!VALID_STATUSES.has(status)) {
                throw new Error(`Invalid status: ${status}. Valid values: ${[...VALID_STATUSES].join(', ')}`);
            }
            if (rawCommitSha !== undefined) {
                if (rawCommitSha.length < 7 || !/^[0-9a-fA-F]+$/.test(rawCommitSha)) {
                    throw new Error(`Invalid commit_sha: "${rawCommitSha}". Must be a hex string of at least 7 characters (short SHA) or 40 characters (full SHA).`);
                }
            }
            const task = db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
            if (!task) {
                throw new Error(`Not found: ${taskId}`);
            }
            const now = nowISO();
            const attempts = args['attempts'] !== undefined ? args['attempts'] : task.attempts;
            const completedAt = status === 'completed' ? now : task.completed_at;
            if (rawCommitSha !== undefined) {
                db.run(`UPDATE tasks SET status = ?, attempts = ?, updated_at = ?, completed_at = ?, commit_sha = ? WHERE id = ?`, [status, attempts, now, completedAt, rawCommitSha, taskId]);
            }
            else {
                db.run(`UPDATE tasks SET status = ?, attempts = ?, updated_at = ?, completed_at = ? WHERE id = ?`, [status, attempts, now, completedAt, taskId]);
            }
            const updated = db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
            return ok(updated);
        })),
        task_first_actionable: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const issueId = requireArg(args, 'issue_id');
            const task = db.get(`SELECT * FROM tasks
         WHERE issue_id = ? AND status IN ('pending', 'failed')
         ORDER BY branch_id ASC
         LIMIT 1`, [issueId]);
            return ok(task ?? null);
        }),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=tasks.js.map