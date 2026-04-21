import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

const VALID_VERDICTS = new Set(['pass', 'fail', 'escalate']);

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
  task_id: string;
  attempt_n: number;
  agent: string;
  verdict: string;
  feedback_md: string;
  reviewer_verdict: string | null;
  created_at: string;
}

export function validationTools(db: TrajectoryDB): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'validation_record',
      description: 'Record a validation attempt for a task.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          task_id: { type: 'string' },
          attempt_n: { type: 'number' },
          verdict: { type: 'string', enum: ['pass', 'fail', 'escalate'] },
          feedback_md: { type: 'string' },
          reviewer_verdict: { type: 'string' },
        },
        required: ['agent', 'task_id', 'attempt_n', 'verdict', 'feedback_md'],
      },
    },
    {
      name: 'validation_history',
      description: 'Return all validation attempts for a task ordered by attempt_n ascending.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          task_id: { type: 'string' },
        },
        required: ['agent', 'task_id'],
      },
    },
  ];

  const handlers: Record<string, Fn> = {
    validation_record: wrapHandler(async (args) => {
      const agent = requireArg(args, 'agent') as string;
      const taskId = requireArg(args, 'task_id') as string;
      requireArg(args, 'attempt_n');
      const verdict = requireArg(args, 'verdict') as string;
      requireArg(args, 'feedback_md');

      if (!VALID_VERDICTS.has(verdict)) {
        throw new Error(
          `Invalid verdict: "${verdict}". Allowed values: ${[...VALID_VERDICTS].join(', ')}`,
        );
      }

      const attemptN = args['attempt_n'] as number;
      const feedbackMd = args['feedback_md'] as string;
      const reviewerVerdict = (args['reviewer_verdict'] as string | undefined) ?? null;
      const now = nowISO();

      db.run(
        `INSERT INTO validation_attempts
           (task_id, attempt_n, agent, verdict, feedback_md, reviewer_verdict, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, attempt_n) DO UPDATE SET
           agent = excluded.agent,
           verdict = excluded.verdict,
           feedback_md = excluded.feedback_md,
           reviewer_verdict = excluded.reviewer_verdict,
           created_at = excluded.created_at`,
        [taskId, attemptN, agent, verdict, feedbackMd, reviewerVerdict, now],
      );

      const row = db.get<ValidationAttempt>(
        `SELECT * FROM validation_attempts WHERE task_id = ? AND attempt_n = ?`,
        [taskId, attemptN],
      );

      return ok(row);
    }),

    validation_history: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const taskId = requireArg(args, 'task_id') as string;

      const rows = db.all<ValidationAttempt>(
        `SELECT * FROM validation_attempts WHERE task_id = ? ORDER BY attempt_n ASC`,
        [taskId],
      );

      return ok(rows);
    }),
  };

  return { definitions, handlers };
}
