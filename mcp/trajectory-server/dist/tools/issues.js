import { nowISO } from '../db.js';
import { normalizeAgent, redactIssue, requireRoles } from '../middleware/agent-scope.js';
import { decodeLabels } from './labels.js';
function decodeIssue(row) {
    const labels = decodeLabels(row.labels);
    return {
        ...row,
        labels: labels.length > 0 ? labels : undefined,
    };
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
export function issueTools(db) {
    const definitions = [
        {
            name: 'issue_create',
            description: 'Create a new issue with an objective and an optional full markdown description.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string', description: 'Caller agent name' },
                    objective: { type: 'string', description: 'Short one-liner summary' },
                    description: { type: 'string', description: 'Full issue description: requirements, context, acceptance criteria. Markdown. Gated from SWE for info isolation.' },
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
                    post_git_sha: { type: 'string', description: 'Git SHA after issue work is done' },
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
    ];
    const handlers = {
        issue_create: requireRoles('issue_create', ['bro'], wrapHandler(async (args) => {
            const agent = normalizeAgent(args['agent']);
            requireArg(args, 'objective');
            const objective = args['objective'];
            const description = args['description'] ?? '';
            const now = nowISO();
            const preGitSha = process.env['PRE_GIT_SHA'] ?? '';
            db.run(`INSERT INTO issues (objective, description, pre_commit_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, 'open', ?, ?)`, [objective, description, preGitSha, now, now]);
            const rowId = db.get(`SELECT id FROM issues WHERE rowid = last_insert_rowid()`);
            if (!rowId) {
                throw new Error('issue_create: failed to retrieve inserted row');
            }
            const row = db.get('SELECT * FROM issues WHERE id = ?', [rowId.id]);
            const issue = decodeIssue(row);
            const redacted = redactIssue(issue, agent, { include_description: true });
            return ok(redacted);
        })),
        issue_get: wrapHandler(async (args) => {
            const agent = normalizeAgent(args['agent']);
            const issueId = requireArg(args, 'issue_id');
            const includeDescription = args['include_description'] ?? false;
            const row = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            if (!row) {
                throw new Error(`Not found: ${issueId}`);
            }
            const issue = decodeIssue(row);
            return ok(redactIssue(issue, agent, { include_description: includeDescription }));
        }),
        issue_resume: wrapHandler(async (args) => {
            const agent = normalizeAgent(args['agent']);
            const issueId = requireArg(args, 'issue_id');
            const row = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            if (!row) {
                throw new Error(`Not found: ${issueId}`);
            }
            const issue = decodeIssue(row);
            const task = db.get(`SELECT * FROM tasks
         WHERE issue_id = ? AND status IN ('pending', 'failed')
         ORDER BY branch_id ASC
         LIMIT 1`, [issueId]);
            return ok({ issue: redactIssue(issue, agent), next_task: task ?? null });
        }),
        issue_close: requireRoles('issue_close', ['bro'], wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const issueId = requireArg(args, 'issue_id');
            const postGitSha = args['post_git_sha'] ?? null;
            const now = nowISO();
            const existing = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            if (!existing) {
                throw new Error(`Not found: ${issueId}`);
            }
            if (postGitSha !== null) {
                db.run(`UPDATE issues
           SET status = 'closed', updated_at = ?, closed_at = COALESCE(closed_at, ?), post_commit_hash = ?
           WHERE id = ?`, [now, now, postGitSha, issueId]);
            }
            else {
                db.run(`UPDATE issues
           SET status = 'closed', updated_at = ?, closed_at = COALESCE(closed_at, ?)
           WHERE id = ?`, [now, now, issueId]);
            }
            const updated = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            return ok(decodeIssue(updated));
        })),
        issue_get_phase: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const issueId = requireArg(args, 'issue_id');
            const issueRow = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            if (!issueRow) {
                throw new Error(`Not found: ${issueId}`);
            }
            const issue = decodeIssue(issueRow);
            const counts = db.get(`SELECT
           COUNT(*) as tasks_total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as tasks_completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as tasks_failed
         FROM tasks WHERE issue_id = ?`, [issueId]) ?? { tasks_total: 0, tasks_completed: 0, tasks_failed: 0 };
            let phase;
            if (issue.status === 'closed') {
                phase = 'done';
            }
            else if (counts.tasks_total === 0) {
                phase = 'discussion';
            }
            else if (counts.tasks_completed < counts.tasks_total) {
                phase = 'tasks';
            }
            else {
                phase = 'blueprint';
            }
            return ok({ phase, counts });
        }),
        issue_list: wrapHandler(async (args) => {
            normalizeAgent(args['agent']);
            const rawStatus = args['status'];
            const rawLimit = args['limit'] ?? 50;
            const rawOffset = args['offset'] ?? 0;
            const limit = Math.min(Math.max(1, rawLimit), 200);
            const offset = Math.max(0, rawOffset);
            const VALID_ISSUE_STATUSES = new Set(['open', 'in_progress', 'closed']);
            if (rawStatus !== undefined && !VALID_ISSUE_STATUSES.has(rawStatus)) {
                return err(`Invalid status: "${rawStatus}". Allowed values: ${[...VALID_ISSUE_STATUSES].join(', ')}`);
            }
            let rows;
            if (rawStatus !== undefined) {
                rows = db.all(`SELECT id, objective, status, labels, created_at, updated_at FROM issues WHERE status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`, [rawStatus, limit, offset]);
            }
            else {
                rows = db.all(`SELECT id, objective, status, labels, created_at, updated_at FROM issues ORDER BY updated_at DESC LIMIT ? OFFSET ?`, [limit, offset]);
            }
            const decoded = rows.map((r) => {
                const labels = decodeLabels(r.labels);
                const { labels: _raw, ...rest } = r;
                void _raw;
                return labels.length > 0 ? { ...rest, labels } : rest;
            });
            return ok(decoded);
        }),
        issue_update_description: requireRoles('issue_update_description', ['bro'], wrapHandler(async (args) => {
            const issueId = requireArg(args, 'issue_id');
            const description = requireArg(args, 'description');
            const MAX_DESCRIPTION_BYTES = 1024 * 1024; // 1MB
            if (Buffer.byteLength(description, 'utf8') > MAX_DESCRIPTION_BYTES) {
                return err('description exceeds 1MB limit');
            }
            const existing = db.get('SELECT id FROM issues WHERE id = ?', [issueId]);
            if (!existing) {
                return err(`not_found: issue ${issueId}`);
            }
            const now = nowISO();
            db.run('UPDATE issues SET description = ?, updated_at = ? WHERE id = ?', [description, now, issueId]);
            const updated = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            return ok(decodeIssue(updated));
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=issues.js.map