import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import { normalizeAgent, redactValidationRow, requireRoles } from '../middleware/agent-scope.js';
import type { ValidationAttempt } from '../types.js';
import { insertAudit } from './audit.js';
import { latestVerificationRun } from './verification-runs.js';

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

export const REVIEWER_OBSERVE_FROM_NODE = 'hook:reviewer-identity-observe';
const AGENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

interface ReviewerObservation {
  id: number;
  session_id: string | null;
  agent_id: string | null;
}

function latestObservation(db: TrajectoryDB, taskId: number, attemptN: number): ReviewerObservation | undefined {
  return db.get<ReviewerObservation>(
    `SELECT id,
            json_extract(content_json, '$.session_id') AS session_id,
            json_extract(content_json, '$.agent_id') AS agent_id
       FROM audit
      WHERE event_type = 'reviewer_identity_observed'
        AND from_node = ?
        AND json_valid(content_json)
        AND CAST(json_extract(content_json, '$.task_id') AS INTEGER) = ?
        AND CAST(json_extract(content_json, '$.attempt_n') AS INTEGER) = ?
        AND COALESCE(json_extract(content_json, '$.consumed'), 0) = 0
      ORDER BY id DESC
      LIMIT 1`,
    [REVIEWER_OBSERVE_FROM_NODE, taskId, attemptN],
  );
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
      description: 'Record a validation attempt for a task. subagent_session_id and reviewer_agent_id are derived server-side from the reviewer-identity-observe hook row for (task_id, attempt_n); caller values are ignored.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          task_id: { type: 'string' },
          attempt_n: { type: 'number' },
          verdict: { type: 'string', enum: ['pass', 'fail', 'escalate'] },
          feedback: { type: 'string' },
          mcp_available: { type: 'boolean', description: 'Required when agent="pr-reviewer": true if the review ran with the trajectory MCP up, false for the honor-system fallback. The typed push-gate signal bro reads from the validation row.' },
          subagent_session_id: { type: 'string', description: 'Ignored: derived from the hook observation. Recorded only on the mcp_available:false honor-system path when no observation exists.' },
        },
        required: ['agent', 'task_id', 'attempt_n', 'verdict', 'feedback'],
      },
    },
    {
      name: 'validation_history',
      description: 'Return all validation attempts for a task ordered by attempt_n ascending; each row carries verification_run, the latest gate-recorded run started by the attempt (null when none). Without limit, returns a bare array (L4-compatible default). With limit, returns {rows, next_cursor}. Supports optional fields projection: pass fields=[\'attempt_n\',\'verdict\'] to return only those columns (unknown fields return a named error).',
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
            description: 'Optional column projection. Allowed: id, task_id, attempt_n, agent, verdict, feedback, mcp_available, subagent_session_id, reviewer_agent_id, created_at, verification_run. Unknown fields return a named error. Default: all columns.',
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

      const role = normalizeAgent(agent);

      const mcpAvailableArg = args['mcp_available'];
      if (role === 'pr-reviewer' && typeof mcpAvailableArg !== 'boolean') {
        throw new Error(
          'precondition_failed: validation_record with agent="pr-reviewer" requires mcp_available (boolean) — the typed push-gate signal bro reads (true=MCP up, false=honor-system fallback).',
        );
      }
      const mcpAvailable = mcpAvailableArg === false ? 0 : 1;

      if (!VALID_VERDICTS.has(verdict)) {
        throw new Error(
          `Invalid verdict: "${verdict}". Allowed values: ${[...VALID_VERDICTS].join(', ')}`,
        );
      }

      const taskExists = db.get<{ id: number; issue_id: number; repo: string | null }>(
        `SELECT t.id, t.issue_id, COALESCE(t.repo, i.repo) AS repo
           FROM tasks t LEFT JOIN issues i ON i.id = t.issue_id
          WHERE t.id = ?`,
        [taskId],
      );
      if (!taskExists) {
        throw new Error(`task_id=${taskId} not found in tasks table`);
      }

      const attemptN = args['attempt_n'] as number;
      const feedback = args['feedback'] as string;
      const now = nowISO();
      const callerSessionId = typeof args['subagent_session_id'] === 'string' ? (args['subagent_session_id'] as string) : null;

      db.transaction(() => {
        const observed = latestObservation(db, taskId, attemptN);
        let subagentSessionId: string | null;
        let reviewerAgentId: string | null;

        if (observed) {
          const observedAgentId = typeof observed.agent_id === 'string' ? observed.agent_id : '';
          if (observedAgentId === '') {
            throw new Error(
              `reviewer_not_independent: the observed validation_record call for task ${taskId} attempt ${attemptN} carried no agent_id — it came from the main loop, not a pr-reviewer subagent.`,
            );
          }
          if (!AGENT_ID_RE.test(observedAgentId)) {
            throw new Error(
              `reviewer_agent_id_malformed: observed agent_id ${JSON.stringify(observedAgentId)} does not match [A-Za-z0-9_-]{8,64}.`,
            );
          }
          const sweRun = db.get<{ id: number }>(
            `SELECT id FROM agent_runs WHERE task_id = ? AND agent_type = 'swe' AND spawn_id = ? LIMIT 1`,
            [taskId, observedAgentId],
          );
          if (sweRun) {
            throw new Error(
              `reviewer_not_independent: reviewer agent_id ${observedAgentId} is the swe that ran task ${taskId}; spawn a separate pr-reviewer.`,
            );
          }
          subagentSessionId = typeof observed.session_id === 'string' && observed.session_id !== '' ? observed.session_id : null;
          reviewerAgentId = observedAgentId;
          db.run(
            `UPDATE audit SET content_json = json_set(content_json, '$.consumed', 1) WHERE id = ?`,
            [observed.id],
          );
        } else if (mcpAvailable === 0) {
          subagentSessionId = callerSessionId;
          reviewerAgentId = null;
          insertAudit(db, {
            issue_id: taskExists.issue_id,
            from_node: 'trajectory-server',
            event_type: 'validation_session_unverified',
            summary: `validation_record for task ${taskId} attempt ${attemptN} recorded on the honor-system path without a hook-observed reviewer identity`,
            content_json: JSON.stringify({ task_id: taskId, attempt_n: attemptN, subagent_session_id: callerSessionId }),
            created_at: now,
          });
        } else {
          throw new Error(
            `subagent_session_unavailable: no reviewer_identity_observed row for task ${taskId} attempt ${attemptN}. validation_record must be called by a spawned pr-reviewer subagent (the reviewer-identity-observe hook records its identity); pass mcp_available:false only on the honor-system path.`,
          );
        }

        db.run(
          `INSERT INTO validation_attempts
             (task_id, attempt_n, agent, verdict, feedback, mcp_available, subagent_session_id, reviewer_agent_id, created_at, repo)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id, attempt_n) DO UPDATE SET
             agent = excluded.agent,
             verdict = excluded.verdict,
             feedback = excluded.feedback,
             mcp_available = excluded.mcp_available,
             subagent_session_id = excluded.subagent_session_id,
             reviewer_agent_id = excluded.reviewer_agent_id,
             created_at = excluded.created_at,
             repo = excluded.repo`,
          [taskId, attemptN, agent, verdict, feedback, mcpAvailable, subagentSessionId, reviewerAgentId, now, taskExists.repo],
        );
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

      const ALLOWED_VALIDATION_FIELDS = new Set(['id', 'task_id', 'attempt_n', 'agent', 'verdict', 'feedback', 'mcp_available', 'subagent_session_id', 'reviewer_agent_id', 'created_at', 'verification_run']);

      if (fieldsArg !== undefined) {
        const unknown = fieldsArg.filter((f) => !ALLOWED_VALIDATION_FIELDS.has(f));
        if (unknown.length > 0) {
          return err(`Unknown fields: ${unknown.join(', ')}. Allowed: ${[...ALLOWED_VALIDATION_FIELDS].join(', ')}`);
        }
      }

      function projectRow(redacted: Record<string, unknown>): Record<string, unknown> {
        const row: Record<string, unknown> = { ...redacted, verification_run: latestVerificationRun(db, taskId, String(redacted['created_at'])) };
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
