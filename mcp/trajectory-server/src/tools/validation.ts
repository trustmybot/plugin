import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import { normalizeAgent, redactValidationRow, requireRoles } from '../middleware/agent-scope.js';
import type { ReviewFinding, ValidationAttempt } from '../types.js';
import { insertAudit } from './audit.js';
import { FINDING_ORDER_SQL, latestVerificationRun } from './verification-runs.js';

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
export const REVIEWER_OBSERVATION_TTL_S = 600;
const AGENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

interface ReviewerObservation {
  id: number;
  session_id: string | null;
  agent_id: string | null;
  observed_at: string | null;
}

function latestObservation(db: TrajectoryDB, taskId: number, attemptN: number): ReviewerObservation | undefined {
  return db.get<ReviewerObservation>(
    `SELECT id,
            json_extract(content_json, '$.session_id') AS session_id,
            json_extract(content_json, '$.agent_id') AS agent_id,
            COALESCE(json_extract(content_json, '$.observed_at'), created_at) AS observed_at
       FROM audit
      WHERE event_type = 'reviewer_identity_observed'
        AND from_node = ?
        AND json_valid(content_json)
        AND CAST(json_extract(content_json, '$.task_id') AS INTEGER) = ?
        AND CAST(json_extract(content_json, '$.attempt_n') AS INTEGER) = ?
        AND COALESCE(json_extract(content_json, '$.consumed'), 0) = 0
        AND COALESCE(json_extract(content_json, '$.superseded'), 0) = 0
      ORDER BY id DESC
      LIMIT 1`,
    [REVIEWER_OBSERVE_FROM_NODE, taskId, attemptN],
  );
}

function supersedeOlderObservations(db: TrajectoryDB, taskId: number, attemptN: number, consumedId: number, now: string): void {
  db.run(
    `UPDATE audit
        SET content_json = json_set(content_json, '$.superseded', 1, '$.superseded_by', CAST(? AS INTEGER), '$.superseded_at', ?)
      WHERE event_type = 'reviewer_identity_observed'
        AND from_node = ?
        AND id < ?
        AND json_valid(content_json)
        AND CAST(json_extract(content_json, '$.task_id') AS INTEGER) = ?
        AND CAST(json_extract(content_json, '$.attempt_n') AS INTEGER) = ?
        AND COALESCE(json_extract(content_json, '$.consumed'), 0) = 0
        AND COALESCE(json_extract(content_json, '$.superseded'), 0) = 0`,
    [consumedId, now, REVIEWER_OBSERVE_FROM_NODE, consumedId, taskId, attemptN],
  );
}

function observationAgeS(observation: ReviewerObservation, nowMs: number): number {
  const observedMs = Date.parse(String(observation.observed_at ?? ''));
  return Number.isFinite(observedMs) ? Math.floor((nowMs - observedMs) / 1000) : Number.POSITIVE_INFINITY;
}

interface FindingInput {
  criterion_id: string | null;
  probe_cmd: string;
  expected: string;
  observed: string;
}

const FINDING_KEYS = new Set(['criterion_id', 'probe_cmd', 'expected', 'observed']);

/**
 * The typed findings[] of a verdict: required and non-empty on fail/escalate,
 * refused on pass. probe_cmd, expected and observed are trimmed non-empty
 * strings; criterion_id is a non-empty string or absent/null.
 */
function parseFindings(verdict: string, raw: unknown): FindingInput[] {
  const list = raw === undefined || raw === null ? [] : raw;
  if (!Array.isArray(list)) {
    throw new Error(`findings must be an array of {criterion_id?, probe_cmd, expected, observed}; got ${typeof raw}`);
  }
  if (verdict === 'pass') {
    if (list.length > 0) {
      throw new Error(`findings_refused: a pass verdict records no findings; got ${list.length}. Send findings only with verdict fail or escalate.`);
    }
    return [];
  }
  if (list.length === 0) {
    throw new Error(
      `findings_required: a ${verdict} verdict needs a non-empty findings[] — one {criterion_id?, probe_cmd, expected, observed} per defect, each probe_cmd a command that exits 0 once the defect is fixed.`,
    );
  }
  return list.map((item, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`findings[${i}] must be an object {criterion_id?, probe_cmd, expected, observed}`);
    }
    const entry = item as Record<string, unknown>;
    const unknown = Object.keys(entry).filter((k) => !FINDING_KEYS.has(k));
    if (unknown.length > 0) {
      throw new Error(`findings[${i}] has unknown field(s) ${unknown.join(', ')}; the server assigns id and status. Allowed: ${[...FINDING_KEYS].join(', ')}`);
    }
    const text = (field: 'probe_cmd' | 'expected' | 'observed'): string => {
      const v = entry[field];
      if (typeof v !== 'string' || v.trim() === '') {
        throw new Error(`findings[${i}].${field} must be a non-empty string`);
      }
      return v.trim();
    };
    const criterion = entry['criterion_id'];
    if (criterion !== undefined && criterion !== null && (typeof criterion !== 'string' || criterion.trim() === '')) {
      throw new Error(`findings[${i}].criterion_id must be a non-empty string or null`);
    }
    return {
      criterion_id: typeof criterion === 'string' ? criterion.trim() : null,
      probe_cmd: text('probe_cmd'),
      expected: text('expected'),
      observed: text('observed'),
    };
  });
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
      description: 'Record a validation attempt for a task. subagent_session_id and reviewer_agent_id come from the fresh (<=600 s) reviewer-identity-observe hook row for (task_id, attempt_n); caller values are ignored. fail/escalate require findings[] and pass refuses them; each becomes a review_findings row the close gate re-probes.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          task_id: { type: 'string' },
          attempt_n: { type: 'number' },
          verdict: { type: 'string', enum: ['pass', 'fail', 'escalate'] },
          feedback: { type: 'string' },
          mcp_available: { type: 'boolean', description: 'Required when agent="code-reviewer": true if the review ran with the trajectory MCP up, false for the honor-system fallback. The typed push-gate signal bro reads from the validation row.' },
          subagent_session_id: { type: 'string', description: 'Ignored: derived from the hook observation. Recorded only on the mcp_available:false honor-system path when no observation exists.' },
          findings: {
            type: 'array',
            description:
              'Required and non-empty when verdict is fail or escalate; refused (must be absent or []) when verdict is pass. One entry per defect. ' +
              'The server assigns each id F<task_id>-<n> (n counts up per task) and status open; re-recording the same attempt replaces that attempt\'s open findings. ' +
              'On every later task_update_status(completed) the swe verification gate runs each non-wontfix finding\'s probe_cmd after verification[]: ' +
              'a passing probe marks an open finding fixed (resolved_at set); any failing probe fails the gate, and a failing fixed finding is reported as a regression. ' +
              'task_brief.open_findings shows the open ones to the swe.',
            items: {
              type: 'object',
              properties: {
                criterion_id: { type: ['string', 'null'], description: 'The spec Success Criteria id the finding breaks (e.g. "SC2"). Omit or null when it covers no single criterion.' },
                probe_cmd: {
                  type: 'string',
                  description:
                    'Self-contained shell command, run with bash -c from the task worktree root, that exits 0 once the finding is fixed and non-zero while it stands. ' +
                    'Inline node -e, bash -c or a heredoc is fine; it must not depend on files only the reviewer has. Example: grep -q "findings" mcp/trajectory-server/src/tools/validation.ts',
                },
                expected: { type: 'string', description: 'What correct behaviour looks like (what the probe checks for).' },
                observed: { type: 'string', description: 'What the reviewer saw instead, with the file:line or output that shows it.' },
              },
              required: ['probe_cmd', 'expected', 'observed'],
              additionalProperties: false,
            },
          },
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
    validation_record: requireRoles('validation_record', ['code-reviewer'], wrapHandler(async (args) => {
      const agent = requireArg(args, 'agent') as string;
      const taskId = coerceTaskId(requireArg(args, 'task_id'));
      requireArg(args, 'attempt_n');
      const verdict = requireArg(args, 'verdict') as string;
      requireArg(args, 'feedback');

      const role = normalizeAgent(agent);

      const mcpAvailableArg = args['mcp_available'];
      if (role === 'code-reviewer' && typeof mcpAvailableArg !== 'boolean') {
        throw new Error(
          'precondition_failed: validation_record with agent="code-reviewer" requires mcp_available (boolean) — the typed push-gate signal bro reads (true=MCP up, false=honor-system fallback).',
        );
      }
      const mcpAvailable = mcpAvailableArg === false ? 0 : 1;

      if (!VALID_VERDICTS.has(verdict)) {
        throw new Error(
          `Invalid verdict: "${verdict}". Allowed values: ${[...VALID_VERDICTS].join(', ')}`,
        );
      }
      const findings = parseFindings(verdict, args['findings']);

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
      const findingIds: string[] = [];

      db.transaction(() => {
        if (mcpAvailable === 0) {
          const verified = db.get<{ verdict: string; reviewer_agent_id: string | null; created_at: string }>(
            `SELECT verdict, reviewer_agent_id, created_at FROM validation_attempts
              WHERE task_id = ? AND attempt_n = ? AND mcp_available = 1`,
            [taskId, attemptN],
          );
          if (verified) {
            throw new Error(
              `verified_verdict_exists: task ${taskId} attempt ${attemptN} already holds a verified ${verified.verdict} verdict (reviewer_agent_id ${verified.reviewer_agent_id ?? 'null'}, recorded ${verified.created_at}); an honor-system call (mcp_available:false) cannot overwrite it.`,
            );
          }
        }

        const latest = latestObservation(db, taskId, attemptN);
        const ageS = latest ? observationAgeS(latest, Date.now()) : 0;
        const staleRow = latest !== undefined && ageS > REVIEWER_OBSERVATION_TTL_S ? latest : undefined;
        const observed = staleRow ? undefined : latest;
        let subagentSessionId: string | null;
        let reviewerAgentId: string | null;

        if (observed) {
          const observedAgentId = typeof observed.agent_id === 'string' ? observed.agent_id : '';
          if (observedAgentId === '') {
            throw new Error(
              `reviewer_not_independent: the observed validation_record call for task ${taskId} attempt ${attemptN} carried no agent_id — it came from the main loop, not a code-reviewer subagent.`,
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
              `reviewer_not_independent: reviewer agent_id ${observedAgentId} is the swe that ran task ${taskId}; spawn a separate code-reviewer.`,
            );
          }
          subagentSessionId = typeof observed.session_id === 'string' && observed.session_id !== '' ? observed.session_id : null;
          reviewerAgentId = observedAgentId;
          db.run(
            `UPDATE audit SET content_json = json_set(content_json, '$.consumed', 1) WHERE id = ?`,
            [observed.id],
          );
          supersedeOlderObservations(db, taskId, attemptN, observed.id, now);
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
        } else if (staleRow) {
          const age = Number.isFinite(ageS) ? `${ageS}s old` : 'of unknown age';
          throw new Error(
            `subagent_session_unavailable: the newest unconsumed reviewer_identity_observed row for task ${taskId} attempt ${attemptN} (audit id ${staleRow.id}) is ${age}, past the ${REVIEWER_OBSERVATION_TTL_S}s freshness window; call validation_record again so the reviewer-identity-observe hook records a fresh row.`,
          );
        } else {
          throw new Error(
            `subagent_session_unavailable: no reviewer_identity_observed row for task ${taskId} attempt ${attemptN}. validation_record must be called by a spawned code-reviewer subagent (the reviewer-identity-observe hook records its identity); pass mcp_available:false only on the honor-system path.`,
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

        const lastN =
          db.get<{ n: number | null }>(
            `SELECT MAX(${FINDING_ORDER_SQL}) AS n FROM review_findings WHERE task_id = ?`,
            [taskId],
          )?.n ?? 0;
        db.run(
          `DELETE FROM review_findings WHERE task_id = ? AND attempt_n = ? AND status = 'open'`,
          [taskId, attemptN],
        );
        findings.forEach((f, i) => {
          const id = `F${taskId}-${lastN + i + 1}`;
          db.run(
            `INSERT INTO review_findings (id, task_id, attempt_n, criterion_id, probe_cmd, expected, observed, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
            [id, taskId, attemptN, f.criterion_id, f.probe_cmd, f.expected, f.observed, now],
          );
          findingIds.push(id);
        });
      });

      const row = db.get<ValidationAttempt>(
        `SELECT * FROM validation_attempts WHERE task_id = ? AND attempt_n = ?`,
        [taskId, attemptN],
      );
      const recorded = findingIds.map((id) => ({ ...db.get<ReviewFinding>('SELECT * FROM review_findings WHERE id = ?', [id]) }));

      return ok({ ...row, findings: recorded });
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
