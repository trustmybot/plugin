import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
export function reportTools(db) {
    const definitions = [
        {
            name: 'issue_report_md',
            description: 'Assemble a markdown narrative for an issue including tasks, validation, and audit event timeline.',
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
            name: 'issue_snapshot_md',
            description: 'Generate a read-only markdown snapshot of an issue (header, discussions, tasks) to docs/trustmybot/snapshots/<issue_id>.md (default) or an explicit output_path. Used by PR reviewer for in-flight review handoff. Rejects paths outside docs/trustmybot/.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    issue_id: { type: 'string' },
                    output_path: {
                        type: 'string',
                        description: 'Optional override path. Must start with docs/trustmybot/. Default: docs/trustmybot/snapshots/<issue_id>.md',
                    },
                },
                required: ['agent', 'issue_id'],
            },
        },
    ];
    const handlers = {
        issue_report_md: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const issueId = requireArg(args, 'issue_id');
            const issue = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            if (!issue) {
                throw new Error(`Not found: ${issueId}`);
            }
            const tasks = db.all(`SELECT * FROM tasks WHERE issue_id = ? ORDER BY branch_id ASC`, [issueId]);
            const taskIds = tasks.map((t) => String(t.id));
            let validationAttempts = [];
            if (taskIds.length > 0) {
                const placeholders = taskIds.map(() => '?').join(', ');
                validationAttempts = db.all(`SELECT * FROM validation_attempts WHERE task_id IN (${placeholders}) ORDER BY task_id ASC, attempt_n ASC`, taskIds);
            }
            const auditEntries = db.all(`SELECT * FROM audit WHERE issue_id = ? AND kind = 'event' ORDER BY id ASC`, [issueId]);
            const skillsUsed = db.all(`SELECT name as skill_name, uses, successes, effectiveness FROM skills WHERE uses > 0`);
            const lines = [];
            lines.push(`# Issue Report: ${issue.id}`);
            lines.push('');
            lines.push('## Objective + Status');
            lines.push('');
            lines.push(`**Objective:** ${issue.objective}`);
            lines.push(`**Status:** ${issue.status}`);
            lines.push(`**Created:** ${issue.created_at}`);
            if (issue.closed_at) {
                lines.push(`**Closed:** ${issue.closed_at}`);
            }
            lines.push('');
            lines.push('## Tasks');
            lines.push('');
            if (tasks.length === 0) {
                lines.push('_No tasks._');
            }
            else {
                lines.push('| Branch | Title | Status | Attempts |');
                lines.push('|--------|-------|--------|----------|');
                for (const t of tasks) {
                    const title = t.title || t.description.slice(0, 60);
                    lines.push(`| ${t.branch_id} | ${title} | ${t.status} | ${t.attempts} |`);
                }
            }
            lines.push('');
            lines.push('## Validation History');
            lines.push('');
            if (validationAttempts.length === 0) {
                lines.push('_No validation attempts._');
            }
            else {
                lines.push('| Task ID | Attempt | Verdict |');
                lines.push('|---------|---------|---------|');
                for (const v of validationAttempts) {
                    lines.push(`| ${v.task_id} | ${v.attempt_n} | ${v.verdict} |`);
                }
            }
            lines.push('');
            lines.push('## Audit Event Timeline');
            lines.push('');
            if (auditEntries.length === 0) {
                lines.push('_No audit events._');
            }
            else {
                for (const e of auditEntries) {
                    lines.push(`- **${e.created_at}** [${e.event_type}] \`${e.from_node}\`: ${e.summary}`);
                }
            }
            lines.push('');
            lines.push('## Skill Usage Summary');
            lines.push('');
            if (skillsUsed.length === 0) {
                lines.push('_No skill usage recorded._');
            }
            else {
                lines.push('| Skill | Uses | Successes | Effectiveness |');
                lines.push('|-------|------|-----------|---------------|');
                for (const s of skillsUsed) {
                    const eff = s.effectiveness !== null ? s.effectiveness.toFixed(2) : '—';
                    lines.push(`| ${s.skill_name} | ${s.uses} | ${s.successes} | ${eff} |`);
                }
            }
            return ok({ markdown: lines.join('\n') });
        }),
        issue_snapshot_md: requireRoles('issue_snapshot_md', ['bro', 'pr-reviewer'], wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const issueId = requireArg(args, 'issue_id');
            const rawOutputPath = args['output_path'];
            const issue = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            if (!issue) {
                throw new Error(`Not found: ${issueId}`);
            }
            const defaultOutputPath = `docs/trustmybot/snapshots/${issueId}.md`;
            const relOutputPath = rawOutputPath ?? defaultOutputPath;
            if (!relOutputPath.startsWith('docs/trustmybot/')) {
                throw new Error(`output_path must start with "docs/trustmybot/". Got: "${relOutputPath}"`);
            }
            const discussions = db.all(`SELECT * FROM discussions WHERE issue_id = ? ORDER BY created_at ASC`, [issueId]);
            const tasks = db.all(`SELECT * FROM tasks WHERE issue_id = ? ORDER BY branch_id ASC`, [issueId]);
            const now = new Date().toISOString();
            const lines = [];
            lines.push(`<!-- Generated by issue_snapshot_md. Do not edit; rebuild via issue_snapshot_md. -->`);
            lines.push(`<!-- GENERATED: ${now} -->`);
            lines.push('');
            lines.push(`# Issue Snapshot: ${issue.id}`);
            lines.push('');
            lines.push('## Header');
            lines.push('');
            lines.push(`**Objective:** ${issue.objective}`);
            lines.push(`**Status:** ${issue.status}`);
            lines.push(`**Created:** ${issue.created_at}`);
            lines.push(`**Updated:** ${issue.updated_at}`);
            // current_task_id was retired in #179 (always-null in production); the
            // open-tasks list below provides the same signal more reliably.
            if (issue.closed_at) {
                lines.push(`**Closed:** ${issue.closed_at}`);
            }
            lines.push('');
            lines.push('## Discussions');
            lines.push('');
            if (discussions.length === 0) {
                lines.push('_No discussion entries._');
            }
            else {
                for (const d of discussions) {
                    lines.push(`### [${d.created_at}] ${d.author} (${d.kind})`);
                    lines.push('');
                    lines.push(d.body);
                    lines.push('');
                }
            }
            lines.push('## Tasks');
            lines.push('');
            if (tasks.length === 0) {
                lines.push('_No tasks._');
            }
            else {
                lines.push('| Branch | Title | Status | Commit SHA |');
                lines.push('|--------|-------|--------|------------|');
                for (const t of tasks) {
                    const title = t.title || t.description.slice(0, 60);
                    const sha = t.commit_sha || '—';
                    lines.push(`| ${t.branch_id} | ${title} | ${t.status} | ${sha} |`);
                }
                lines.push('');
                lines.push('## Per-task snapshot');
                lines.push('');
                for (const t of tasks) {
                    const title = t.title || t.branch_id;
                    lines.push(`### ${t.branch_id}: ${title}`);
                    lines.push('');
                    if (t.spec_body) {
                        const truncated = t.spec_body.length > 400;
                        const preview = truncated ? t.spec_body.slice(0, 400) + ' …' : t.spec_body;
                        lines.push('**Spec body:**');
                        lines.push('');
                        lines.push(preview);
                    }
                    else {
                        lines.push('_No spec body recorded._');
                    }
                    lines.push('');
                }
            }
            const markdown = lines.join('\n');
            const absPath = join(process.cwd(), relOutputPath);
            mkdirSync(dirname(absPath), { recursive: true });
            writeFileSync(absPath, markdown, 'utf8');
            return ok({ path: relOutputPath, bytes_written: Buffer.byteLength(markdown, 'utf8') });
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=reports.js.map