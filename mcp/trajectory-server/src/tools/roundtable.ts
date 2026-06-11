import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';
import { normalizeAgent, requireRoles } from '../middleware/agent-scope.js';

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

interface RoundtableRow {
  id: number;
  issue_id: number;
  topic: string;
  outcome: string;
  created_at: string;
  closed_at: string | null;
  state: string;
  expected_participants: number | null;
}

interface RoundtableVoteRow {
  id: number;
  roundtable_id: number;
  participant: string;
  vote: string;
  rationale: string;
  created_at: string;
}

export function roundtableTools(db: TrajectoryDB): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'roundtable_create',
      description:
        'Create a new roundtable. Bro-only. Returns roundtable_id. Server-gated: requires an unconsumed audit row with event_type=\'roundtable_slash_invoked\' (written when the user types /roundtable). Human-triggered only.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Must be bro' },
          issue_id: { type: 'number', description: 'Carrier issue ID for this roundtable' },
          topic: { type: 'string', description: 'Short topic description for this roundtable' },
          expected_participants: {
            type: 'number',
            description: 'Number of non-human participants (2–5)',
          },
          waive_slash_gate: {
            type: 'boolean',
            description:
              "Set true to bypass the slash-invoke gate (rarely justified — /roundtable is Human-triggered only). If false or omitted, an audit row with event_type='roundtable_slash_invoked' must exist.",
          },
          waive_slash_gate_reason: {
            type: 'string',
            description:
              "Required when waive_slash_gate=true. Min 10 chars. Explain why bro is firing roundtable_create without a /roundtable invocation.",
          },
        },
        required: ['agent', 'issue_id', 'topic', 'expected_participants'],
      },
    },
    {
      name: 'roundtable_vote',
      description:
        'Record a participant vote/position for a roundtable. Bro-only. One row per participant per call; participant is an agent name or "human" for ratification rows.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Must be bro' },
          roundtable_id: { type: 'number', description: 'ID returned by roundtable_create' },
          participant: {
            type: 'string',
            description: 'Agent name (ceo, cto, pm, architect) or "human" for ratification rows',
          },
          vote: { type: 'string', description: 'Stance summary or vote value' },
          rationale: { type: 'string', description: 'Key reasoning or rationale (optional)' },
        },
        required: ['agent', 'roundtable_id', 'participant', 'vote'],
      },
    },
    {
      name: 'roundtable_close',
      description:
        'Close a roundtable and record the final outcome. Bro-only. Requires state=awaiting_human with ≥1 human vote, or skip=true to bypass.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Must be bro' },
          roundtable_id: { type: 'number', description: 'ID of the roundtable to close' },
          outcome: { type: 'string', description: 'One-sentence summary of the meeting outcome' },
          skip: {
            type: 'boolean',
            description: 'If true, bypass state checks and set state=skipped',
          },
        },
        required: ['agent', 'roundtable_id', 'outcome'],
      },
    },
    {
      name: 'roundtable_finalize_decisions',
      description:
        'Atomically write all post-AUQ ratification rows (discussions + votes). Bro-only. Requires state=awaiting_human.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Must be bro' },
          roundtable_id: { type: 'number', description: 'ID of the roundtable' },
          ratified: {
            type: 'array',
            items: { type: 'string' },
            description: 'Agreements ratified by the human',
          },
          unratified: {
            type: 'array',
            items: { type: 'string' },
            description: 'Agreements not ratified',
          },
          resolutions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                topic_slug: { type: 'string' },
                winning_stance: { type: 'string' },
                dissenter: { type: 'string' },
                rationale: { type: 'string' },
              },
              required: ['topic_slug', 'winning_stance', 'dissenter'],
            },
            description: 'Disagreements resolved by human choice',
          },
        },
        required: ['agent', 'roundtable_id', 'ratified', 'unratified', 'resolutions'],
      },
    },
    {
      name: 'roundtable_summarize',
      description:
        'Assemble the canonical summary of a roundtable from existing DB rows. Bro-only. Pure SELECT.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Must be bro' },
          roundtable_id: { type: 'number', description: 'ID of the roundtable' },
        },
        required: ['agent', 'roundtable_id'],
      },
    },
    {
      name: 'roundtable_close_with_decisions',
      description:
        'Composite: collapses roundtable_finalize_decisions + roundtable_close + roundtable_summarize into one transactional call. Bro-only. Requires state=awaiting_human. Writes decision rows, closes the roundtable, returns the canonical summary.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Must be bro' },
          roundtable_id: { type: 'number', description: 'ID of the roundtable' },
          outcome: { type: 'string', description: 'One-sentence summary of the meeting outcome' },
          decisions: {
            type: 'object',
            description: 'Decision payload forwarded to roundtable_finalize_decisions.',
            properties: {
              ratified: { type: 'array', items: { type: 'string' }, description: 'Agreements ratified by the human' },
              unratified: { type: 'array', items: { type: 'string' }, description: 'Agreements not ratified' },
              resolutions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    topic_slug: { type: 'string' },
                    winning_stance: { type: 'string' },
                    dissenter: { type: 'string' },
                    rationale: { type: 'string' },
                  },
                  required: ['topic_slug', 'winning_stance', 'dissenter'],
                },
                description: 'Disagreements resolved by human choice',
              },
            },
            required: ['ratified', 'unratified', 'resolutions'],
          },
          summary: {
            type: 'string',
            description: 'Optional — passed through as outcome if provided; otherwise outcome is used.',
          },
        },
        required: ['agent', 'roundtable_id', 'outcome', 'decisions'],
      },
    },
  ];

  const handlers: Record<string, Fn> = {
    roundtable_create: requireRoles(
      'roundtable_create',
      ['bro'],
      wrapHandler(async (args) => {
        normalizeAgent(args['agent'] as string | undefined);
        const issueId = requireArg(args, 'issue_id') as number;
        const topic = requireArg(args, 'topic') as string;
        const expectedParticipants = requireArg(args, 'expected_participants') as number;

        if (!topic.trim()) {
          throw new Error('topic must be a non-empty string');
        }
        if (
          !Number.isInteger(expectedParticipants) ||
          expectedParticipants < 2 ||
          expectedParticipants > 5
        ) {
          throw new Error('invalid_argument: expected_participants must be an integer between 2 and 5');
        }

        // --- Slash-invoke gate (MCP-level enforcement) ---
        // /roundtable is Human-triggered only per CLAUDE.md routing. The
        // roundtable-slash-detect.sh UserPromptSubmit hook writes an
        // audit row when the user actually types /roundtable. Without
        // that audit, bro is auto-firing roundtable_create from a phrase
        // trigger — captured-bug L6 scenario 08.
        const slashGateWaived = args['waive_slash_gate'] === true;
        const slashGateWaiverReason = (args['waive_slash_gate_reason'] ?? '') as string;
        if (slashGateWaived) {
          if (
            typeof slashGateWaiverReason !== 'string' ||
            slashGateWaiverReason.trim().length < 10
          ) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: 'invalid_argument',
                    message: 'waive_slash_gate_reason must be a string ≥10 chars.',
                  }),
                },
              ],
            };
          }
        } else {
          const slashRow = db.get<{ id: number }>(
            `SELECT id FROM audit
             WHERE event_type = 'roundtable_slash_invoked'
               AND created_at >= datetime('now', '-10 minutes')
               AND (content_json IS NULL OR json_extract(content_json, '$.consumed_by_roundtable_id') IS NULL)
             ORDER BY created_at DESC
             LIMIT 1`,
          );
          if (!slashRow) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: 'roundtable_slash_gate_violation',
                    message:
                      `Roundtable slash gate: /roundtable is Human-triggered only. ` +
                      `No unconsumed audit row with event_type='roundtable_slash_invoked' exists within the last 10 minutes, ` +
                      `meaning the user did not type /roundtable recently. Tell the Human to type /roundtable <topic> ` +
                      `instead of auto-firing roundtable_create. For exceptional cases, pass ` +
                      `waive_slash_gate=true with waive_slash_gate_reason="<why>".`,
                  }),
                },
              ],
            };
          }
        }

        const now = nowISO();

        // Find the slash-invoke audit row to consume BEFORE inserting the roundtable,
        // so we have its id for the stamp (#356).
        const slashAuditId = slashGateWaived
          ? null
          : db.get<{ id: number }>(
              `SELECT id FROM audit
               WHERE event_type = 'roundtable_slash_invoked'
                 AND created_at >= datetime('now', '-10 minutes')
                 AND (content_json IS NULL OR json_extract(content_json, '$.consumed_by_roundtable_id') IS NULL)
               ORDER BY created_at DESC
               LIMIT 1`,
            )?.id ?? null;

        db.run(
          `INSERT INTO roundtables (issue_id, topic, outcome, created_at, state, expected_participants)
           VALUES (?, ?, '', ?, 'collecting', ?)`,
          [issueId, topic, now, expectedParticipants],
        );

        const row = db.get<RoundtableRow>(
          'SELECT * FROM roundtables WHERE rowid = last_insert_rowid()',
        );

        // Consume the slash-invoke audit row by stamping the new roundtable_id
        // into its content_json (#356). Uses the audit row id to avoid ORDER BY
        // in UPDATE (not supported in all SQLite builds).
        if (slashAuditId !== null) {
          db.run(
            `UPDATE audit
             SET content_json = json_set(COALESCE(content_json, '{}'), '$.consumed_by_roundtable_id', ?)
             WHERE id = ?`,
            [row!.id, slashAuditId],
          );
        }

        return ok({ roundtable_id: row!.id, state: row!.state });
      }),
    ),

    roundtable_vote: requireRoles(
      'roundtable_vote',
      ['bro'],
      wrapHandler(async (args) => {
        normalizeAgent(args['agent'] as string | undefined);
        const roundtableId = requireArg(args, 'roundtable_id') as number;
        const participant = requireArg(args, 'participant') as string;
        const vote = requireArg(args, 'vote') as string;
        const rationale = (args['rationale'] as string | undefined) ?? '';

        if (!participant.trim()) {
          throw new Error('participant must be a non-empty string');
        }
        if (!vote.trim()) {
          throw new Error('vote must be a non-empty string');
        }

        const roundtable = db.get<RoundtableRow>(
          'SELECT * FROM roundtables WHERE id = ?',
          [roundtableId],
        );
        if (!roundtable) {
          throw new Error(`Not found: roundtable ${roundtableId}`);
        }

        const currentState = roundtable.state ?? 'collecting';
        if (currentState !== 'collecting' && currentState !== 'awaiting_human') {
          throw new Error(
            `invalid_state: roundtable ${roundtableId} is in state '${currentState}'; votes only allowed in collecting or awaiting_human`,
          );
        }

        const now = nowISO();
        db.run(
          `INSERT INTO roundtable_votes (roundtable_id, participant, vote, rationale, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [roundtableId, participant, vote, rationale, now],
        );

        const row = db.get<RoundtableVoteRow>(
          'SELECT * FROM roundtable_votes WHERE rowid = last_insert_rowid()',
        );

        let newState = currentState;
        if (participant !== 'human' && currentState === 'collecting') {
          const expectedN = roundtable.expected_participants;
          if (expectedN !== null && expectedN !== undefined) {
            const countRow = db.get<{ cnt: number }>(
              `SELECT COUNT(DISTINCT participant) AS cnt
               FROM roundtable_votes
               WHERE roundtable_id = ? AND participant != 'human'`,
              [roundtableId],
            );
            if (countRow && countRow.cnt >= expectedN) {
              db.run(
                `UPDATE roundtables SET state = 'awaiting_human' WHERE id = ?`,
                [roundtableId],
              );
              newState = 'awaiting_human';
            }
          }
        }

        return ok({ vote_id: row!.id, state: newState });
      }),
    ),

    roundtable_close: requireRoles(
      'roundtable_close',
      ['bro'],
      wrapHandler(async (args) => {
        normalizeAgent(args['agent'] as string | undefined);
        const roundtableId = requireArg(args, 'roundtable_id') as number;
        const outcome = requireArg(args, 'outcome') as string;
        const skip = (args['skip'] as boolean | undefined) ?? false;

        const roundtable = db.get<RoundtableRow>(
          'SELECT * FROM roundtables WHERE id = ?',
          [roundtableId],
        );
        if (!roundtable) {
          throw new Error(`Not found: roundtable ${roundtableId}`);
        }

        if (skip) {
          const now = nowISO();
          db.run(
            `UPDATE roundtables SET state = 'skipped', outcome = ?, closed_at = ? WHERE id = ?`,
            [outcome, now, roundtableId],
          );
          const updated = db.get<RoundtableRow>('SELECT * FROM roundtables WHERE id = ?', [roundtableId]);
          return ok({
            roundtable_id: updated!.id,
            state: updated!.state,
            closed_at: updated!.closed_at,
          });
        }

        const currentState = roundtable.state ?? 'collecting';
        if (currentState !== 'awaiting_human' && currentState !== 'skipped') {
          throw new Error(
            `invalid_state: roundtable ${roundtableId} is in state '${currentState}'; close requires awaiting_human or skip:true`,
          );
        }

        if (currentState === 'awaiting_human') {
          const humanVote = db.get<{ id: number }>(
            `SELECT id FROM roundtable_votes WHERE roundtable_id = ? AND participant = 'human' LIMIT 1`,
            [roundtableId],
          );
          if (!humanVote) {
            throw new Error(
              `precondition_failed: roundtable ${roundtableId} has no human votes; call roundtable_finalize_decisions first`,
            );
          }
        }

        const now = nowISO();
        db.run(
          `UPDATE roundtables SET state = 'closed', outcome = ?, closed_at = ? WHERE id = ?`,
          [outcome, now, roundtableId],
        );

        const updated = db.get<RoundtableRow>('SELECT * FROM roundtables WHERE id = ?', [roundtableId]);
        return ok({
          roundtable_id: updated!.id,
          state: updated!.state,
          closed_at: updated!.closed_at,
        });
      }),
    ),

    roundtable_finalize_decisions: requireRoles(
      'roundtable_finalize_decisions',
      ['bro'],
      wrapHandler(async (args) => {
        normalizeAgent(args['agent'] as string | undefined);
        const roundtableId = requireArg(args, 'roundtable_id') as number;
        const ratified = (requireArg(args, 'ratified') as string[]);
        const unratified = (requireArg(args, 'unratified') as string[]);
        const resolutions = (requireArg(args, 'resolutions') as Array<{
          topic_slug: string;
          winning_stance: string;
          dissenter: string;
          rationale?: string;
        }>);

        const roundtable = db.get<RoundtableRow>(
          'SELECT * FROM roundtables WHERE id = ?',
          [roundtableId],
        );
        if (!roundtable) {
          throw new Error(`Not found: roundtable ${roundtableId}`);
        }

        const currentState = roundtable.state ?? 'collecting';
        if (currentState !== 'awaiting_human') {
          throw new Error(
            `invalid_state: roundtable ${roundtableId} is in state '${currentState}'; finalize_decisions requires awaiting_human`,
          );
        }

        if (ratified.length === 0 && unratified.length === 0 && resolutions.length === 0) {
          throw new Error('invalid_argument: at least one of ratified, unratified, or resolutions must be non-empty');
        }

        for (const r of resolutions) {
          if (r.topic_slug.length > 12) {
            throw new Error(
              `invalid_argument: topic_slug '${r.topic_slug}' exceeds 12 characters`,
            );
          }
        }

        const issueId = roundtable.issue_id;
        const now = nowISO();
        let discussionRowsWritten = 0;
        let voteRowsWritten = 0;

        db.transaction(() => {
          for (const agreement of ratified) {
            db.run(
              `INSERT INTO discussions (issue_id, author, kind, body, created_at) VALUES (?, 'bro', 'answer', ?, ?)`,
              [issueId, agreement, now],
            );
            discussionRowsWritten++;
            db.run(
              `INSERT INTO discussions (issue_id, author, kind, body, created_at) VALUES (?, 'bro', 'decision', ?, ?)`,
              [issueId, `Ratified: ${agreement}`, now],
            );
            discussionRowsWritten++;
            db.run(
              `INSERT INTO roundtable_votes (roundtable_id, participant, vote, rationale, created_at) VALUES (?, 'human', 'ratified', ?, ?)`,
              [roundtableId, `Ratified: ${agreement}`, now],
            );
            voteRowsWritten++;
          }

          for (const agreement of unratified) {
            db.run(
              `INSERT INTO discussions (issue_id, author, kind, body, created_at) VALUES (?, 'bro', 'note', ?, ?)`,
              [issueId, `not ratified: ${agreement}`, now],
            );
            discussionRowsWritten++;
          }

          for (const r of resolutions) {
            db.run(
              `INSERT INTO discussions (issue_id, author, kind, body, created_at) VALUES (?, 'bro', 'decision', ?, ?)`,
              [issueId, `Human chose ${r.winning_stance}; ${r.dissenter} dissented but did not block.`, now],
            );
            discussionRowsWritten++;
            db.run(
              `INSERT INTO roundtable_votes (roundtable_id, participant, vote, rationale, created_at) VALUES (?, 'human', ?, ?, ?)`,
              [roundtableId, r.winning_stance, r.rationale ?? '', now],
            );
            voteRowsWritten++;
          }

        });

        return ok({
          discussion_rows_written: discussionRowsWritten,
          vote_rows_written: voteRowsWritten,
          state: 'awaiting_human',
        });
      }),
    ),

    roundtable_summarize: requireRoles(
      'roundtable_summarize',
      ['bro'],
      wrapHandler(async (args) => {
        normalizeAgent(args['agent'] as string | undefined);
        const roundtableId = requireArg(args, 'roundtable_id') as number;

        const roundtable = db.get<RoundtableRow>(
          'SELECT * FROM roundtables WHERE id = ?',
          [roundtableId],
        );
        if (!roundtable) {
          throw new Error(`Not found: roundtable ${roundtableId}`);
        }

        const participants = db.all<{ participant: string }>(
          `SELECT DISTINCT participant FROM roundtable_votes
           WHERE roundtable_id = ? AND participant != 'human' AND participant IS NOT NULL`,
          [roundtableId],
        ).map((r) => r.participant);

        const answerRows = db.all<{ body: string }>(
          `SELECT body FROM discussions WHERE issue_id = ? AND kind = 'answer'
           AND created_at >= ? AND created_at <= COALESCE(?, datetime('now'))`,
          [roundtable.issue_id, roundtable.created_at, roundtable.closed_at],
        ).map((r) => r.body);

        const noteRows = db.all<{ body: string }>(
          `SELECT body FROM discussions WHERE issue_id = ? AND kind = 'note' AND body LIKE 'not ratified: %'
           AND created_at >= ? AND created_at <= COALESCE(?, datetime('now'))`,
          [roundtable.issue_id, roundtable.created_at, roundtable.closed_at],
        ).map((r) => r.body.replace(/^not ratified: /, ''));

        const decisionRows = db.all<{ body: string }>(
          `SELECT body FROM discussions WHERE issue_id = ? AND kind = 'decision' AND body NOT LIKE 'Ratified: %'
           AND created_at >= ? AND created_at <= COALESCE(?, datetime('now'))`,
          [roundtable.issue_id, roundtable.created_at, roundtable.closed_at],
        );

        const disagreementsResolved = decisionRows.map((r) => ({
          decision_body: r.body,
        }));

        return ok({
          topic: roundtable.topic,
          participants,
          agreements_ratified: answerRows,
          unratified: noteRows,
          disagreements_resolved: disagreementsResolved,
          outcome: roundtable.outcome || null,
          state: roundtable.state ?? 'collecting',
        });
      }),
    ),

    roundtable_close_with_decisions: requireRoles(
      'roundtable_close_with_decisions',
      ['bro'],
      wrapHandler(async (args) => {
        normalizeAgent(args['agent'] as string | undefined);
        const roundtableId = requireArg(args, 'roundtable_id') as number;
        const outcome = requireArg(args, 'outcome') as string;
        const decisions = requireArg(args, 'decisions') as {
          ratified: string[];
          unratified: string[];
          resolutions: Array<{
            topic_slug: string;
            winning_stance: string;
            dissenter: string;
            rationale?: string;
          }>;
        };

        const roundtable = db.get<RoundtableRow>(
          'SELECT * FROM roundtables WHERE id = ?',
          [roundtableId],
        );
        if (!roundtable) {
          throw new Error(`Not found: roundtable ${roundtableId}`);
        }

        const currentState = roundtable.state ?? 'collecting';
        if (currentState !== 'awaiting_human') {
          throw new Error(
            `invalid_state: roundtable ${roundtableId} is in state '${currentState}'; roundtable_close_with_decisions requires awaiting_human`,
          );
        }

        if (
          decisions.ratified.length === 0 &&
          decisions.unratified.length === 0 &&
          decisions.resolutions.length === 0
        ) {
          throw new Error('invalid_argument: at least one of ratified, unratified, or resolutions must be non-empty');
        }

        for (const r of decisions.resolutions) {
          if (r.topic_slug.length > 12) {
            throw new Error(
              `invalid_argument: topic_slug '${r.topic_slug}' exceeds 12 characters`,
            );
          }
        }

        const issueId = roundtable.issue_id;
        const now = nowISO();
        let discussionRowsWritten = 0;
        let voteRowsWritten = 0;

        db.transaction(() => {
          for (const agreement of decisions.ratified) {
            db.run(
              `INSERT INTO discussions (issue_id, author, kind, body, created_at) VALUES (?, 'bro', 'answer', ?, ?)`,
              [issueId, agreement, now],
            );
            discussionRowsWritten++;
            db.run(
              `INSERT INTO discussions (issue_id, author, kind, body, created_at) VALUES (?, 'bro', 'decision', ?, ?)`,
              [issueId, `Ratified: ${agreement}`, now],
            );
            discussionRowsWritten++;
            db.run(
              `INSERT INTO roundtable_votes (roundtable_id, participant, vote, rationale, created_at) VALUES (?, 'human', 'ratified', ?, ?)`,
              [roundtableId, `Ratified: ${agreement}`, now],
            );
            voteRowsWritten++;
          }

          for (const agreement of decisions.unratified) {
            db.run(
              `INSERT INTO discussions (issue_id, author, kind, body, created_at) VALUES (?, 'bro', 'note', ?, ?)`,
              [issueId, `not ratified: ${agreement}`, now],
            );
            discussionRowsWritten++;
          }

          for (const r of decisions.resolutions) {
            db.run(
              `INSERT INTO discussions (issue_id, author, kind, body, created_at) VALUES (?, 'bro', 'decision', ?, ?)`,
              [issueId, `Human chose ${r.winning_stance}; ${r.dissenter} dissented but did not block.`, now],
            );
            discussionRowsWritten++;
            db.run(
              `INSERT INTO roundtable_votes (roundtable_id, participant, vote, rationale, created_at) VALUES (?, 'human', ?, ?, ?)`,
              [roundtableId, r.winning_stance, r.rationale ?? '', now],
            );
            voteRowsWritten++;
          }

          db.run(
            `UPDATE roundtables SET state = 'closed', outcome = ?, closed_at = ? WHERE id = ?`,
            [outcome, now, roundtableId],
          );
        });

        const updated = db.get<RoundtableRow>('SELECT * FROM roundtables WHERE id = ?', [roundtableId]);

        const participants = db.all<{ participant: string }>(
          `SELECT DISTINCT participant FROM roundtable_votes
           WHERE roundtable_id = ? AND participant != 'human' AND participant IS NOT NULL`,
          [roundtableId],
        ).map((r) => r.participant);

        const answerRows = db.all<{ body: string }>(
          `SELECT body FROM discussions WHERE issue_id = ? AND kind = 'answer'
           AND created_at >= ? AND created_at <= COALESCE(?, datetime('now'))`,
          [issueId, roundtable.created_at, updated!.closed_at],
        ).map((r) => r.body);

        const noteRows = db.all<{ body: string }>(
          `SELECT body FROM discussions WHERE issue_id = ? AND kind = 'note' AND body LIKE 'not ratified: %'
           AND created_at >= ? AND created_at <= COALESCE(?, datetime('now'))`,
          [issueId, roundtable.created_at, updated!.closed_at],
        ).map((r) => r.body.replace(/^not ratified: /, ''));

        const decisionRows = db.all<{ body: string }>(
          `SELECT body FROM discussions WHERE issue_id = ? AND kind = 'decision' AND body NOT LIKE 'Ratified: %'
           AND created_at >= ? AND created_at <= COALESCE(?, datetime('now'))`,
          [issueId, roundtable.created_at, updated!.closed_at],
        );

        const disagreementsResolved = decisionRows.map((r) => ({
          decision_body: r.body,
        }));

        return ok({
          roundtable_id: updated!.id,
          state: updated!.state,
          closed_at: updated!.closed_at,
          discussion_rows_written: discussionRowsWritten,
          vote_rows_written: voteRowsWritten,
          summary: {
            topic: roundtable.topic,
            participants,
            agreements_ratified: answerRows,
            unratified: noteRows,
            disagreements_resolved: disagreementsResolved,
            outcome: updated!.outcome || null,
          },
        });
      }),
    ),
  };

  return { definitions, handlers };
}
