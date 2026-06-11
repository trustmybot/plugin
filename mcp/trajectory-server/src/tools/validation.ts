import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import { normalizeAgent, redactValidationRow, requireRoles } from '../middleware/agent-scope.js';
import type { ValidationAttempt } from '../types.js';

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
          subagent_session_id: { type: 'string', description: 'Required when agent="pr-reviewer": the spawned pr-reviewer subagent\'s session ID.' },
        },
        required: ['agent', 'task_id', 'attempt_n', 'verdict', 'feedback'],
      },
    },
    {
      name: 'validation_history',
      description: 'Return all validation attempts for a task ordered by attempt_n ascending. Without limit, returns a bare array (L4-compatible default). With limit, returns {rows, next_cursor}. Supports optional fields projection: pass fields=[\'attempt_n\',\'verdict\'] to return only those columns (unknown fields return a named error).',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          task_id: { type: 'string' },
          own_task_id: { type: 'string', description: 'The calling agent\'s own task ID (used to gate feedback access for swe)' },
          limit: { type: 'number', description: 'Optional — max rows to return. When provided, response includes next_cursor.' },
          cursor: { type: 'string', description: 'Opaque cursor from a previous response.' },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional column projection. Allowed: id, task_id, attempt_n, agent, verdict, feedback, subagent_session_id, created_at. Unknown fields return a named error. Default: all columns.',
          },
        },
        required: ['agent', 'task_id'],
      },
    },
  ];

  const handlers: Record<string, Fn> = {
    validation_record: requireRoles('validation_record', ['pr-reviewer'], wrapHandler(async (args) => {
      const agent = requireArg(args, 'agent') as string;
      const taskId = coerceTaskId(requireArg(args, 'task_id'));
      requireArg(args, 'attempt_n');
      const verdict = requireArg(args, 'verdict') as string;
      requireArg(args, 'feedback');

      const subagentSessionId = (args['subagent_session_id'] ?? null) as string | null;

      if (agent === 'pr-reviewer' && !subagentSessionId) {
        throw new Error(
          'precondition_failed: validation_record with agent="pr-reviewer" requires subagent_session_id (the spawned pr-reviewer subagent\'s session ID). This prevents bro from self-authoring pr-reviewer verdicts.',
        );
      }

      if (!VALID_VERDICTS.has(verdict)) {
        throw new Error(
          `Invalid verdict: "${verdict}". Allowed values: ${[...VALID_VERDICTS].join(', ')}`,
        );
      }

      const feedbackArg = args['feedback'] as string;
      if (!/^MCP available: (yes|no)\b/.test(feedbackArg)) {
        throw new Error(
          'precondition_failed: validation_record.feedback must start with "MCP available: yes" or "MCP available: no — honor-system fallback" (LOAD-BEARING-SAFETY #97 — bro\'s push-gate parses this prefix to detect dead MCP). Prepend the line, then put your rationale on subsequent lines.',
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

      const taskRepo = db.get<{ repo: string | null }>(
        'SELECT repo FROM tasks WHERE id = ?',
        [taskId],
      );
      const repo = taskRepo?.repo ?? '';

      db.transaction(() => {
        db.run(
          `INSERT INTO validation_attempts
             (task_id, attempt_n, agent, verdict, feedback, subagent_session_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id, attempt_n) DO UPDATE SET
             agent = excluded.agent,
             verdict = excluded.verdict,
             feedback = excluded.feedback,
             subagent_session_id = excluded.subagent_session_id,
             created_at = excluded.created_at`,
          [taskId, attemptN, agent, verdict, feedback, subagentSessionId, now],
        );

        const existingPrRow = db.get<{ id: number }>(
          'SELECT id FROM pr_review_runs WHERE task_id = ? AND attempt_n = ?',
          [taskId, attemptN],
        );
        if (existingPrRow) {
          db.run(
            'UPDATE pr_review_runs SET verdict = ?, last_fetched_at = ? WHERE id = ?',
            [verdict, now, existingPrRow.id],
          );
        } else {
          // Audit rows use pr_number=0 (sentinel). The (pr_number, repo)
          // unique index is partial (WHERE pr_number > 0) so multiple audit
          // rows for different attempts of the same task do not conflict.
          db.run(
            `INSERT INTO pr_review_runs (pr_number, repo, last_fetched_at, task_id, verdict, attempt_n)
             VALUES (0, ?, ?, ?, ?, ?)`,
            [repo, now, taskId, verdict, attemptN],
          );
        }
      });

      const row = db.get<ValidationAttempt>(
        `SELECT * FROM validation_attempts WHERE task_id = ? AND attempt_n = ?`,
        [taskId, attemptN],
      );

      return ok(row);
    })),

    validation_history: wrapHandler(async (args) => {
      const agent = normalizeAgent(args['agent'] as string | undefined);
      const taskId = coerceTaskId(requireArg(args, 'task_id'));
      const ownTaskIdRaw = args['own_task_id'];
      const ownTaskId =
        ownTaskIdRaw !== undefined && ownTaskIdRaw !== null
          ? coerceTaskId(ownTaskIdRaw)
          : undefined;
      const limitArg = args['limit'] as number | undefined;
      const cursorArg = args['cursor'] as string | undefined;
      const fieldsArg = args['fields'] as string[] | undefined;

      const ALLOWED_VALIDATION_FIELDS = new Set(['id', 'task_id', 'attempt_n', 'agent', 'verdict', 'feedback', 'subagent_session_id', 'created_at']);

      if (fieldsArg !== undefined) {
        const unknown = fieldsArg.filter((f) => !ALLOWED_VALIDATION_FIELDS.has(f));
        if (unknown.length > 0) {
          return err(`Unknown fields: ${unknown.join(', ')}. Allowed: ${[...ALLOWED_VALIDATION_FIELDS].join(', ')}`);
        }
      }

      function projectRow(row: Record<string, unknown>): Record<string, unknown> {
        if (!fieldsArg) return row;
        const out: Record<string, unknown> = {};
        for (const f of fieldsArg) out[f] = row[f];
        return out;
      }

      if (limitArg === undefined || limitArg === null) {
        const rows = db.all<ValidationAttempt>(
          `SELECT * FROM validation_attempts WHERE task_id = ? ORDER BY attempt_n ASC`,
          [taskId],
        );
        return ok(rows.map((row) => projectRow(redactValidationRow(row, agent, { own_task_id: ownTaskId }) as Record<string, unknown>)));
      }

      const limit = Math.min(Math.max(1, limitArg), 500);
      let cursorFilter = '';
      let cursorParams: unknown[] = [];

      if (cursorArg) {
        try {
          const decoded = JSON.parse(Buffer.from(cursorArg, 'base64').toString('utf8')) as {
            attempt_n: number;
          };
          if (typeof decoded.attempt_n === 'number') {
            cursorFilter = 'AND attempt_n > ?';
            cursorParams = [decoded.attempt_n];
          }
        } catch {
          // ignore invalid cursor
        }
      }

      const sql =
        'SELECT * FROM validation_attempts WHERE task_id = ? ' +
        cursorFilter +
        ' ORDER BY attempt_n ASC LIMIT ?';
      const fetchedRows = db.all<ValidationAttempt>(sql, [taskId, ...cursorParams, limit + 1]);

      const hasMore = fetchedRows.length > limit;
      const rows = hasMore ? fetchedRows.slice(0, limit) : fetchedRows;
      const last = rows[rows.length - 1];
      const next_cursor =
        hasMore && last
          ? Buffer.from(JSON.stringify({ attempt_n: last.attempt_n })).toString('base64')
          : undefined;

      return ok({
        rows: rows.map((row) => projectRow(redactValidationRow(row, agent, { own_task_id: ownTaskId }) as Record<string, unknown>)),
        next_cursor,
      });
    }),
  };

  return { definitions, handlers };
}
