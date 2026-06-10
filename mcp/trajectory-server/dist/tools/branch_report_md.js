import { requireRoles } from '../middleware/agent-scope.js';
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
export function branchReportMdTools(db) {
    const definitions = [
        {
            name: 'branch_report_md',
            description: 'Assemble a markdown report scoped to a single (issue_id, branch_id) pair. mode="summary" (default) returns task status + counts + last 5 audit events (~500 tokens). mode="detail" returns full tasks, all audit events, and all validation attempts.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    issue_id: { type: 'string', description: 'Integer issue ID as a string.' },
                    branch_id: { type: 'string', description: 'Git branch name, e.g. feat/my-feature.' },
                    mode: {
                        type: 'string',
                        enum: ['summary', 'detail'],
                        description: 'Report depth. Default: summary (~500 tokens). Use detail for full narrative.',
                    },
                },
                required: ['agent', 'issue_id', 'branch_id'],
            },
        },
    ];
    const handlers = {
        branch_report_md: requireRoles('branch_report_md', ['bro', 'swe', 'pr-reviewer', 'consultant'], wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const issueId = requireArg(args, 'issue_id');
            const branchId = requireArg(args, 'branch_id');
            const mode = args['mode'] ?? 'summary';
            if (mode !== 'summary' && mode !== 'detail') {
                throw new Error(`Invalid mode: "${mode}". Allowed: summary, detail`);
            }
            if (!/^\d+$/.test(issueId)) {
                throw new Error(`issue_id must be a positive integer string. Got: "${issueId}"`);
            }
            const issue = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            if (!issue) {
                throw new Error(`issue_id ${issueId} not found.`);
            }
            const tasks = db.all('SELECT * FROM tasks WHERE issue_id = ? AND branch_id = ? ORDER BY id ASC', [issueId, branchId]);
            if (tasks.length === 0) {
                throw new Error(`No tasks found for issue_id=${issueId} branch_id="${branchId}". ` +
                    'Verify the branch_id matches an existing task on that issue.');
            }
            const lines = [];
            lines.push(`# Branch Report — ${branchId} (issue #${issueId})`);
            lines.push('');
            lines.push(`**Issue objective:** ${issue.objective}`);
            lines.push('');
            if (mode === 'summary') {
                lines.push('## Tasks on this branch');
                lines.push('');
                lines.push('| ID | Title | Status | Commit |');
                lines.push('|---|---|---|---|');
                for (const t of tasks) {
                    const title = t.title || t.description.slice(0, 60);
                    const commit = t.commit_sha || '—';
                    lines.push(`| ${t.id} | ${title} | ${t.status} | ${commit} |`);
                }
                lines.push('');
                const auditCount = (db.get('SELECT COUNT(*) AS n FROM audit WHERE issue_id = ? AND branch_id = ?', [issueId, branchId]))?.n ?? 0;
                lines.push(`**Audit events:** ${auditCount}`);
                lines.push('');
                lines.push('## Last 5 Audit Events');
                lines.push('');
                const recentAudit = db.all('SELECT * FROM audit WHERE issue_id = ? AND branch_id = ? ORDER BY id DESC LIMIT 5', [issueId, branchId]);
                if (recentAudit.length === 0) {
                    lines.push('_No audit events._');
                }
                else {
                    lines.push('| Time | Event | From | Summary |');
                    lines.push('|---|---|---|---|');
                    for (const e of recentAudit.reverse()) {
                        lines.push(`| ${e.created_at} | ${e.event_type} | ${e.from_node} | ${e.summary} |`);
                    }
                }
                return ok({ markdown: lines.join('\n'), mode: 'summary' });
            }
            // detail mode
            const taskIds = tasks.map((t) => String(t.id));
            const placeholders = taskIds.map(() => '?').join(', ');
            const validationAttempts = db.all('SELECT * FROM validation_attempts WHERE task_id IN (' + placeholders + ') ORDER BY task_id ASC, attempt_n ASC', taskIds);
            const auditEntries = db.all('SELECT * FROM audit WHERE issue_id = ? AND branch_id = ? ORDER BY id ASC', [issueId, branchId]);
            lines.push('## Tasks on this branch');
            lines.push('');
            lines.push('| ID | Title | Status | Commit | Created | Closed |');
            lines.push('|---|---|---|---|---|---|');
            for (const t of tasks) {
                const title = t.title || t.description.slice(0, 60);
                const commit = t.commit_sha || '—';
                const closed = t.completed_at || '—';
                lines.push(`| ${t.id} | ${title} | ${t.status} | ${commit} | ${t.created_at} | ${closed} |`);
            }
            lines.push('');
            lines.push('## Audit events');
            lines.push('');
            if (auditEntries.length === 0) {
                lines.push('_No audit events._');
            }
            else {
                lines.push('| Time | Event | From | Summary |');
                lines.push('|---|---|---|---|');
                for (const e of auditEntries) {
                    lines.push(`| ${e.created_at} | ${e.event_type} | ${e.from_node} | ${e.summary} |`);
                }
            }
            lines.push('');
            lines.push('## Validation attempts');
            lines.push('');
            if (validationAttempts.length === 0) {
                lines.push('_No validation attempts._');
            }
            else {
                lines.push('| Task | Attempt | Agent | Verdict | When |');
                lines.push('|---|---|---|---|---|');
                for (const v of validationAttempts) {
                    lines.push(`| ${v.task_id} | ${v.attempt_n} | ${v.agent} | ${v.verdict} | ${v.created_at} |`);
                }
            }
            return ok({ markdown: lines.join('\n'), mode: 'detail' });
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=branch_report_md.js.map