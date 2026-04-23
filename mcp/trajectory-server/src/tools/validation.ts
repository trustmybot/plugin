import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import { normalizeAgent, redactValidationRow } from '../middleware/agent-scope.js';

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
  task_id: number;
  attempt_n: number;
  agent: string;
  verdict: string;
  feedback: string;
  created_at: string;
}

function coerceTaskId(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `task_id must be a positive integer; got: ${JSON.stringify(raw)}`,
    );
  }
  return n;
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
          feedback: { type: 'string' },
        },
        required: ['agent', 'task_id', 'attempt_n', 'verdict', 'feedback'],
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
          own_task_id: { type: 'string', description: 'The calling agent\'s own task ID (used to gate feedback access for swe)' },
        },
        required: ['agent', 'task_id'],
      },
    },
  ];

  const handlers: Record<string, Fn> = {
    validation_record: wrapHandler(async (args) => {
      const agent = requireArg(args, 'agent') as string;
      const taskId = coerceTaskId(requireArg(args, 'task_id'));
      requireArg(args, 'attempt_n');
      const verdict = requireArg(args, 'verdict') as string;
      requireArg(args, 'feedback');

      if (!VALID_VERDICTS.has(verdict)) {
        throw new Error(
          `Invalid verdict: "${verdict}". Allowed values: ${[...VALID_VERDICTS].join(', ')}`,
        );
      }

      const taskExists = db.get<{ id: number }>(
        `SELECT id FROM tasks WHERE id = ?`,
        [taskId],
      );
      if (!taskExists) {
        throw new Error(`task_id=${taskId} not found in tasks table`);
      }

      const attemptN = args['attempt_n'] as number;
      const feedback = args['feedback'] as string;
      const now = nowISO();

      db.run(
        `INSERT INTO validation_attempts
           (task_id, attempt_n, agent, verdict, feedback, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, attempt_n) DO UPDATE SET
           agent = excluded.agent,
           verdict = excluded.verdict,
           feedback = excluded.feedback,
           created_at = excluded.created_at`,
        [taskId, attemptN, agent, verdict, feedback, now],
      );

      const row = db.get<ValidationAttempt>(
        `SELECT * FROM validation_attempts WHERE task_id = ? AND attempt_n = ?`,
        [taskId, attemptN],
      );

      return ok(row);
    }),

    validation_history: wrapHandler(async (args) => {
      const agent = normalizeAgent(args['agent'] as string | undefined);
      const taskId = coerceTaskId(requireArg(args, 'task_id'));
      const ownTaskIdRaw = args['own_task_id'];
      const ownTaskId =
        ownTaskIdRaw !== undefined && ownTaskIdRaw !== null
          ? coerceTaskId(ownTaskIdRaw)
          : undefined;

      const rows = db.all<ValidationAttempt>(
        `SELECT * FROM validation_attempts WHERE task_id = ? ORDER BY attempt_n ASC`,
        [taskId],
      );

      return ok(rows.map((row) => redactValidationRow(row, agent, { own_task_id: ownTaskId })));
    }),
  };

  return { definitions, handlers };
}
