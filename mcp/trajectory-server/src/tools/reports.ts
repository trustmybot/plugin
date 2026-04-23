import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import type { Discussion, Issue, Task, LedgerEntry } from '../types.js';
import { requireRoles } from '../middleware/agent-scope.js';

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

interface ValidationAttempt {
  id: number;
  task_id: number;
  attempt_n: number;
  agent: string;
  verdict: string;
  feedback_md: string;
  reviewer_verdict: string | null;
  created_at: string;
}

interface SkillUsage {
  skill_name: string;
  uses: number;
  successes: number;
  effectiveness: number | null;
}

export function reportTools(db: TrajectoryDB): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'issue_report_md',
      description: 'Assemble a markdown narrative for an issue including tasks, validation, and ledger timeline.',
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

  const handlers: Record<string, Fn> = {
    issue_report_md: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const issueId = requireArg(args, 'issue_id') as string;

      const issue = db.get<Issue>('SELECT * FROM issues WHERE id = ?', [issueId]);
      if (!issue) {
        throw new Error(`Not found: ${issueId}`);
      }

      const tasks = db.all<Task>(
        `SELECT * FROM tasks WHERE issue_id = ? ORDER BY branch_id ASC`,
        [issueId],
      );

      const taskIds = tasks.map((t) => String(t.id));

      let validationAttempts: ValidationAttempt[] = [];
      if (taskIds.length > 0) {
        const placeholders = taskIds.map(() => '?').join(', ');
        validationAttempts = db.all<ValidationAttempt>(
          `SELECT * FROM validation_attempts WHERE task_id IN (${placeholders}) ORDER BY task_id ASC, attempt_n ASC`,
          taskIds,
        );
      }

      const ledgerEntries = db.all<LedgerEntry>(
        `SELECT * FROM ledger WHERE issue_id = ? ORDER BY id ASC`,
        [issueId],
      );

      const skillsUsed = db.all<SkillUsage>(
        `SELECT name as skill_name, uses, successes, effectiveness FROM skills WHERE uses > 0`,
      );

      const lines: string[] = [];

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
      } else {
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
      } else {
        lines.push('| Task ID | Attempt | Verdict | Reviewer Verdict |');
        lines.push('|---------|---------|---------|-----------------|');
        for (const v of validationAttempts) {
          const rv = v.reviewer_verdict ?? '—';
          lines.push(`| ${v.task_id} | ${v.attempt_n} | ${v.verdict} | ${rv} |`);
        }
      }
      lines.push('');

      lines.push('## Ledger Timeline');
      lines.push('');
      if (ledgerEntries.length === 0) {
        lines.push('_No ledger entries._');
      } else {
        for (const e of ledgerEntries) {
          lines.push(`- **${e.created_at}** [${e.event_type}] \`${e.from_node}\`: ${e.summary}`);
        }
      }
      lines.push('');

      lines.push('## Skill Usage Summary');
      lines.push('');
      if (skillsUsed.length === 0) {
        lines.push('_No skill usage recorded._');
      } else {
        lines.push('| Skill | Uses | Successes | Effectiveness |');
        lines.push('|-------|------|-----------|---------------|');
        for (const s of skillsUsed) {
          const eff = s.effectiveness !== null ? s.effectiveness.toFixed(2) : '—';
          lines.push(`| ${s.skill_name} | ${s.uses} | ${s.successes} | ${eff} |`);
        }
      }

      return ok({ markdown: lines.join('\n') });
    }),

    issue_snapshot_md: requireRoles('issue_snapshot_md', ['architect', 'pr-reviewer'], wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const issueId = requireArg(args, 'issue_id') as string;
      const rawOutputPath = args['output_path'] as string | undefined;

      const issue = db.get<Issue>('SELECT * FROM issues WHERE id = ?', [issueId]);
      if (!issue) {
        throw new Error(`Not found: ${issueId}`);
      }

      const defaultOutputPath = `docs/trustmybot/snapshots/${issueId}.md`;
      const relOutputPath = rawOutputPath ?? defaultOutputPath;

      if (!relOutputPath.startsWith('docs/trustmybot/')) {
        throw new Error(
          `output_path must start with "docs/trustmybot/". Got: "${relOutputPath}"`,
        );
      }

      const discussions = db.all<Discussion>(
        `SELECT * FROM discussions WHERE issue_id = ? ORDER BY created_at ASC`,
        [issueId],
      );

      const tasks = db.all<Task>(
        `SELECT * FROM tasks WHERE issue_id = ? ORDER BY branch_id ASC`,
        [issueId],
      );

      const now = new Date().toISOString();
      const lines: string[] = [];

      lines.push(`<!-- Generated by issue_snapshot_md. Do not edit; regenerate. -->`);
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
      if (issue.current_task_id !== null) {
        const currentTask = tasks.find((t) => t.id === issue.current_task_id);
        if (currentTask) {
          lines.push(`**Current Task Branch:** ${currentTask.branch_id}`);
        }
      }
      if (issue.closed_at) {
        lines.push(`**Closed:** ${issue.closed_at}`);
      }
      lines.push('');

      lines.push('## Discussions');
      lines.push('');
      if (discussions.length === 0) {
        lines.push('_No discussion entries._');
      } else {
        for (const d of discussions) {
          lines.push(`### [${d.created_at}] ${d.author} (${d.kind})`);
          lines.push('');
          lines.push(d.body_md);
          lines.push('');
        }
      }

      lines.push('## Tasks');
      lines.push('');
      if (tasks.length === 0) {
        lines.push('_No tasks._');
      } else {
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
          if (t.spec_body_md) {
            const truncated = t.spec_body_md.length > 400;
            const preview = truncated ? t.spec_body_md.slice(0, 400) + ' …' : t.spec_body_md;
            lines.push('**Spec body:**');
            lines.push('');
            lines.push(preview);
          } else {
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
