import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

const MAX_OUTPUT_BYTES = 1_048_576; // 1 MB
const HALF_BYTES = 524_288; // 512 KB

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

export function auditTools(db: TrajectoryDB): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'audit_log',
      description: 'Store a full tool invocation record for post-hoc debugging.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          issue_id: { type: 'string' },
          branch_id: { type: 'string' },
          from_node: { type: 'string' },
          tool_name: { type: 'string' },
          tool_args: {},
          output: { type: 'string' },
          round: { type: 'number' },
        },
        required: ['agent', 'issue_id', 'from_node', 'tool_name', 'tool_args', 'output'],
      },
    },
  ];

  const handlers: Record<string, Fn> = {
    audit_log: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const issueId = requireArg(args, 'issue_id') as string;
      requireArg(args, 'from_node');
      requireArg(args, 'tool_name');
      requireArg(args, 'tool_args');
      requireArg(args, 'output');

      const fromNode = args['from_node'] as string;
      const toolName = args['tool_name'] as string;
      const branchId = (args['branch_id'] as string | undefined) ?? null;
      const now = nowISO();

      const rawToolArgs = args['tool_args'];
      const toolArgs =
        typeof rawToolArgs === 'string' ? rawToolArgs : JSON.stringify(rawToolArgs);

      let output = args['output'] as string;
      let isTruncated = 0;

      const outputBytes = Buffer.byteLength(output, 'utf8');
      if (outputBytes > MAX_OUTPUT_BYTES) {
        const buf = Buffer.from(output, 'utf8');
        const head = buf.slice(0, HALF_BYTES).toString('utf8');
        const tail = buf.slice(buf.length - HALF_BYTES).toString('utf8');
        const droppedBytes = outputBytes - HALF_BYTES * 2;
        output = `${head}...[truncated ${droppedBytes} bytes]...${tail}`;
        isTruncated = 1;
      }

      let round: number;
      if (args['round'] !== undefined && args['round'] !== null) {
        round = args['round'] as number;
      } else {
        const maxRow = db.get<{ max_round: number | null }>(
          `SELECT MAX(round) as max_round FROM audit WHERE issue_id = ?`,
          [issueId],
        );
        round = (maxRow?.max_round ?? -1) + 1;
      }

      db.run(
        `INSERT INTO audit
           (issue_id, branch_id, from_node, round, tool_name, tool_args, output, output_chars, is_truncated, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [issueId, branchId, fromNode, round, toolName, toolArgs, output, output.length, isTruncated, now],
      );

      const row = db.get<Record<string, unknown>>(
        'SELECT * FROM audit WHERE rowid = last_insert_rowid()',
      );

      return ok(row);
    }),
  };

  return { definitions, handlers };
}
