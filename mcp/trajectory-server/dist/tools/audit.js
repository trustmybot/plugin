import { nowISO } from '../db.js';
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
// Audit table is event-only after the #179 schema cleanup. The kind='tool_call'
// branch was retired (always-empty across production data; tool-call records
// live in debug_trajectory). All audit_log inserts must specify event_type +
// summary; the schema CHECK enforces kind='event' and the handler rejects any
// caller that tries to pass kind='tool_call' for backward compatibility.
export function auditTools(db) {
    const definitions = [
        {
            name: 'audit_log',
            description: "Insert an audit lifecycle event (planning_complete, bro_verification_pass, headless_fallback, etc.). All rows are kind='event'; the kind='tool_call' branch was retired in #179. Both event_type and summary are required.",
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    issue_id: { type: 'string' },
                    branch_id: { type: 'string' },
                    from_node: { type: 'string' },
                    kind: {
                        type: 'string',
                        enum: ['event'],
                        description: "Always 'event'. Retained for backward-compatible callers; defaults to 'event' if omitted.",
                    },
                    event_type: { type: 'string', description: 'Required. Lifecycle event identifier (e.g. planning_complete).' },
                    summary: { type: 'string', description: 'Required. One-line human-readable summary.' },
                    content_json: { type: 'string', description: 'Optional. JSON string with structured event payload, max 1 MB.' },
                },
                required: ['agent', 'issue_id', 'from_node', 'event_type', 'summary'],
            },
        },
        {
            name: 'audit_log_list',
            description: 'Paginated fetch of audit records for an issue.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    issue_id: { type: 'string' },
                    branch_id: { type: 'string' },
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
            if (kind !== 'event') {
                throw new Error(`Invalid kind: "${kind}". Only 'event' is supported after the #179 schema cleanup. The 'tool_call' kind was retired — log tool calls via debug_trajectory instead.`);
            }
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
        }),
        audit_log_list: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const issueId = requireArg(args, 'issue_id');
            const branchId = args['branch_id'] ?? null;
            const rawLimit = args['limit'] ?? 50;
            const limit = Math.min(Math.max(1, rawLimit), 500);
            const offset = Math.max(0, args['offset'] ?? 0);
            const params = [issueId];
            let whereClause = 'WHERE issue_id = ?';
            if (branchId !== null) {
                whereClause += ' AND branch_id = ?';
                params.push(branchId);
            }
            params.push(limit, offset);
            const rows = db.all(`SELECT * FROM audit ${whereClause} ORDER BY id ASC LIMIT ? OFFSET ?`, params);
            return ok(rows);
        }),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=audit.js.map