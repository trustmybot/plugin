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
  status: string;
  outcome: string;
  created_at: string;
  closed_at: string | null;
}

interface RoundtableVoteRow {
  id: number;
  roundtable_id: number;
  agent: string;
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
        'Create a new roundtable meeting record. Bro-only. Returns the roundtable_id to use for subsequent vote and close calls.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Must be bro' },
          issue_id: { type: 'number', description: 'Carrier issue ID for this roundtable' },
          topic: { type: 'string', description: 'Short topic description for this roundtable' },
        },
        required: ['agent', 'issue_id', 'topic'],
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
        'Close a roundtable and record the final outcome. Bro-only. Idempotent — re-closing an already-closed roundtable is allowed.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Must be bro' },
          roundtable_id: { type: 'number', description: 'ID of the roundtable to close' },
          outcome: { type: 'string', description: 'One-sentence summary of the meeting outcome' },
        },
        required: ['agent', 'roundtable_id', 'outcome'],
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

        if (!topic.trim()) {
          throw new Error('topic must be a non-empty string');
        }

        const now = nowISO();
        db.run(
          `INSERT INTO roundtables (issue_id, topic, status, outcome, created_at)
           VALUES (?, ?, 'open', '', ?)`,
          [issueId, topic, now],
        );

        const row = db.get<RoundtableRow>(
          'SELECT * FROM roundtables WHERE rowid = last_insert_rowid()',
        );
        return ok({ roundtable_id: row!.id });
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

        const roundtable = db.get<{ id: number }>(
          'SELECT id FROM roundtables WHERE id = ?',
          [roundtableId],
        );
        if (!roundtable) {
          throw new Error(`Not found: roundtable ${roundtableId}`);
        }

        const now = nowISO();
        db.run(
          `INSERT INTO roundtable_votes (roundtable_id, agent, vote, rationale, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [roundtableId, participant, vote, rationale, now],
        );

        const row = db.get<RoundtableVoteRow>(
          'SELECT * FROM roundtable_votes WHERE rowid = last_insert_rowid()',
        );
        return ok({ vote_id: row!.id });
      }),
    ),

    roundtable_close: requireRoles(
      'roundtable_close',
      ['bro'],
      wrapHandler(async (args) => {
        normalizeAgent(args['agent'] as string | undefined);
        const roundtableId = requireArg(args, 'roundtable_id') as number;
        const outcome = requireArg(args, 'outcome') as string;

        const roundtable = db.get<RoundtableRow>(
          'SELECT * FROM roundtables WHERE id = ?',
          [roundtableId],
        );
        if (!roundtable) {
          throw new Error(`Not found: roundtable ${roundtableId}`);
        }

        const now = nowISO();
        db.run(
          `UPDATE roundtables SET status = 'closed', outcome = ?, closed_at = ? WHERE id = ?`,
          [outcome, now, roundtableId],
        );

        const updated = db.get<RoundtableRow>(
          'SELECT * FROM roundtables WHERE id = ?',
          [roundtableId],
        );
        return ok({
          roundtable_id: updated!.id,
          status: updated!.status,
          closed_at: updated!.closed_at,
        });
      }),
    ),
  };

  return { definitions, handlers };
}
