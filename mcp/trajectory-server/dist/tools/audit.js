import { nowISO } from '../db.js';
const MAX_OUTPUT_BYTES = 1_048_576; // 1 MB
const HALF_BYTES = 524_288; // 512 KB
const MAX_CONTENT_BYTES = 1_000_000;
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
            description: "Insert an audit record. Use kind='event' for lifecycle events (planning_complete, bro_verification_pass, etc.) and kind='tool_call' for tool invocation records.",
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    issue_id: { type: 'string' },
                    branch_id: { type: 'string' },
                    from_node: { type: 'string' },
                    kind: {
                        type: 'string',
                        enum: ['event', 'tool_call'],
                        description: "Discriminator: 'event' (lifecycle event) or 'tool_call' (tool invocation record). Defaults to 'event'.",
                    },
                    // event fields
                    event_type: { type: 'string', description: "Required when kind='event'." },
                    summary: { type: 'string', description: "Required when kind='event'." },
                    content_json: { type: 'string', description: "JSON string, max 1 MB. Optional for kind='event'." },
                    // tool_call fields
                    tool_name: { type: 'string', description: "Required when kind='tool_call'." },
                    tool_args: { description: "Required when kind='tool_call'." },
                    output: { type: 'string', description: "Required when kind='tool_call'." },
                    round: { type: 'number', description: "Optional for kind='tool_call'." },
                },
                required: ['agent', 'issue_id', 'from_node'],
            },
        },
        {
            name: 'audit_log_list',
            description: 'Paginated fetch of audit records for an issue, optionally filtered by kind.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    issue_id: { type: 'string' },
                    branch_id: { type: 'string' },
                    kind: {
                        type: 'string',
                        enum: ['event', 'tool_call'],
                        description: "Filter by kind. Omit to return all rows.",
                    },
                    limit: { type: 'number', description: 'Max rows to return (default 50, max 500)' },
                    offset: { type: 'number', description: 'Row offset for pagination (default 0)' },
                },
                required: ['agent', 'issue_id'],
            },
        },
    ];
    const handlers = {
        audit_log: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const issueId = requireArg(args, 'issue_id');
            requireArg(args, 'from_node');
            const fromNode = args['from_node'];
            const branchId = args['branch_id'] ?? null;
            const kind = args['kind'] ?? 'event';
            const now = nowISO();
            if (kind !== 'event' && kind !== 'tool_call') {
                throw new Error(`Invalid kind: "${kind}". Must be 'event' or 'tool_call'.`);
            }
            if (kind === 'event') {
                requireArg(args, 'event_type');
                requireArg(args, 'summary');
                const eventType = args['event_type'];
                const summary = args['summary'];
                let contentJson = args['content_json'] ?? '{}';
                let isTruncated = 0;
                const byteLength = Buffer.byteLength(contentJson, 'utf8');
                if (byteLength > MAX_CONTENT_BYTES) {
                    contentJson = Buffer.from(contentJson, 'utf8').slice(0, MAX_CONTENT_BYTES).toString('utf8');
                    isTruncated = 1;
                }
                db.run(`INSERT INTO audit
             (issue_id, branch_id, from_node, kind, event_type, summary, content_json, is_truncated, created_at)
           VALUES (?, ?, ?, 'event', ?, ?, ?, ?, ?)`, [issueId, branchId, fromNode, eventType, summary, contentJson, isTruncated, now]);
                const row = db.get('SELECT * FROM audit WHERE rowid = last_insert_rowid()');
                return ok(row);
            }
            else {
                // kind='tool_call'
                requireArg(args, 'tool_name');
                requireArg(args, 'tool_args');
                requireArg(args, 'output');
                const toolName = args['tool_name'];
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
                    const maxRow = db.get(`SELECT MAX(round) as max_round FROM audit WHERE issue_id = ? AND branch_id = ? AND kind = 'tool_call'`, [issueId, branchId]);
                    round = (maxRow?.max_round ?? -1) + 1;
                }
                else {
                    const maxRow = db.get(`SELECT MAX(round) as max_round FROM audit WHERE issue_id = ? AND kind = 'tool_call'`, [issueId]);
                    round = (maxRow?.max_round ?? -1) + 1;
                }
                db.run(`INSERT INTO audit
             (issue_id, branch_id, from_node, kind, round, tool_name, tool_args, output, output_chars, is_truncated, created_at)
           VALUES (?, ?, ?, 'tool_call', ?, ?, ?, ?, ?, ?, ?)`, [issueId, branchId, fromNode, round, toolName, toolArgs, output, output.length, isTruncated, now]);
                const row = db.get('SELECT * FROM audit WHERE rowid = last_insert_rowid()');
                return ok(row);
            }
        }),
        audit_log_list: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const issueId = requireArg(args, 'issue_id');
            const branchId = args['branch_id'] ?? null;
            const kind = args['kind'] ?? null;
            const rawLimit = args['limit'] ?? 50;
            const limit = Math.min(Math.max(1, rawLimit), 500);
            const offset = Math.max(0, args['offset'] ?? 0);
            const params = [issueId];
            let whereClause = 'WHERE issue_id = ?';
            if (branchId !== null) {
                whereClause += ' AND branch_id = ?';
                params.push(branchId);
            }
            if (kind !== null) {
                whereClause += ' AND kind = ?';
                params.push(kind);
            }
            params.push(limit, offset);
            const rows = db.all(`SELECT * FROM audit ${whereClause} ORDER BY id ASC LIMIT ? OFFSET ?`, params);
            return ok(rows);
        }),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=audit.js.map