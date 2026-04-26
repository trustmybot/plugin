import { nowISO } from '../db.js';
const MAX_OUTPUT_BYTES = 1_048_576; // 1 MB
const HALF_BYTES = 524_288; // 512 KB
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
export function auditTools(db) {
    const definitions = [
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
    const handlers = {
        audit_log: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const issueId = requireArg(args, 'issue_id');
            requireArg(args, 'from_node');
            requireArg(args, 'tool_name');
            requireArg(args, 'tool_args');
            requireArg(args, 'output');
            const fromNode = args['from_node'];
            const toolName = args['tool_name'];
            const branchId = args['branch_id'] ?? null;
            const now = nowISO();
            const rawToolArgs = args['tool_args'];
            const toolArgs = typeof rawToolArgs === 'string' ? rawToolArgs : JSON.stringify(rawToolArgs);
            let output = args['output'];
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
            let round;
            if (args['round'] !== undefined && args['round'] !== null) {
                round = args['round'];
            }
            else if (branchId !== null) {
                const maxRow = db.get(`SELECT MAX(round) as max_round FROM audit WHERE issue_id = ? AND branch_id = ?`, [issueId, branchId]);
                round = (maxRow?.max_round ?? -1) + 1;
            }
            else {
                // branch_id not provided: fall back to issue-only scope (ambiguous across tasks)
                const maxRow = db.get(`SELECT MAX(round) as max_round FROM audit WHERE issue_id = ?`, [issueId]);
                round = (maxRow?.max_round ?? -1) + 1;
            }
            db.run(`INSERT INTO audit
           (issue_id, branch_id, from_node, round, tool_name, tool_args, output, output_chars, is_truncated, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [issueId, branchId, fromNode, round, toolName, toolArgs, output, output.length, isTruncated, now]);
            const row = db.get('SELECT * FROM audit WHERE rowid = last_insert_rowid()');
            return ok(row);
        }),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=audit.js.map