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
            description: 'Assemble a markdown summary scoped to a single (issue_id, branch_id) pair: tasks, audit events, validation attempts, and file_registry entries touched on that branch.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    issue_id: { type: 'string', description: 'Integer issue ID as a string.' },
                    branch_id: { type: 'string', description: 'Git branch name, e.g. feat/my-feature.' },
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
            const taskIds = tasks.map((t) => String(t.id));
            const placeholders = taskIds.map(() => '?').join(', ');
            const validationAttempts = db.all(`SELECT * FROM validation_attempts WHERE task_id IN (${placeholders}) ORDER BY task_id ASC, attempt_n ASC`, taskIds);
            const ledgerEntries = db.all(`SELECT * FROM audit WHERE issue_id = ? AND branch_id = ? AND kind = 'event' ORDER BY id ASC`, [issueId, branchId]);
            const commitShas = tasks
                .map((t) => t.commit_sha)
                .filter((sha) => sha !== null && sha !== '');
            let fileRegistryRows = [];
            if (commitShas.length > 0) {
                const shaPlaceholders = commitShas.map(() => '?').join(', ');
                fileRegistryRows = db.all(`SELECT path, last_commit_sha, summary FROM file_registry WHERE last_commit_sha IN (${shaPlaceholders}) ORDER BY path ASC`, commitShas);
            }
            const lines = [];
            lines.push(`# Branch Report — ${branchId} (issue #${issueId})`);
            lines.push('');
            lines.push(`**Issue objective:** ${issue.objective}`);
            lines.push('');
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
            if (ledgerEntries.length === 0) {
                lines.push('_No audit events._');
            }
            else {
                lines.push('| Time | Event | From | Summary |');
                lines.push('|---|---|---|---|');
                for (const e of ledgerEntries) {
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
            lines.push('');
            lines.push('## file_registry entries touched on this branch');
            lines.push('');
            if (fileRegistryRows.length === 0) {
                lines.push('_No file_registry entries found for this branch._');
            }
            else {
                lines.push('| Path | Last commit_sha | Summary |');
                lines.push('|---|---|---|');
                for (const f of fileRegistryRows) {
                    const sha = f.last_commit_sha || '—';
                    const summary = f.summary || '—';
                    lines.push(`| ${f.path} | ${sha} | ${summary} |`);
                }
            }
            return ok({ markdown: lines.join('\n') });
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=branch_report_md.js.map