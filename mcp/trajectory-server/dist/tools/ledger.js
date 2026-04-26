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
export function ledgerTools(db) {
    const definitions = [
        {
            name: 'ledger_log',
            description: 'Insert a ledger entry for an issue with auto timestamp.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    issue_id: { type: 'string' },
                    branch_id: { type: 'string' },
                    from_node: { type: 'string' },
                    event_type: { type: 'string' },
                    summary: { type: 'string' },
                    content_json: { type: 'string', description: 'JSON string, max 1 MB' },
                },
                required: ['agent', 'issue_id', 'from_node', 'event_type', 'summary'],
            },
        },
        {
            name: 'ledger_list',
            description: 'Paginated fetch of ledger entries for an issue.',
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
        ledger_log: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const issueId = requireArg(args, 'issue_id');
            requireArg(args, 'from_node');
            requireArg(args, 'event_type');
            requireArg(args, 'summary');
            const fromNode = args['from_node'];
            const eventType = args['event_type'];
            const summary = args['summary'];
            const branchId = args['branch_id'] ?? null;
            const now = nowISO();
            let contentJson = args['content_json'] ?? '{}';
            let isTruncated = 0;
            const byteLength = Buffer.byteLength(contentJson, 'utf8');
            if (byteLength > MAX_CONTENT_BYTES) {
                contentJson = Buffer.from(contentJson, 'utf8').slice(0, MAX_CONTENT_BYTES).toString('utf8');
                isTruncated = 1;
            }
            db.run(`INSERT INTO ledger (issue_id, branch_id, from_node, event_type, summary, content, is_truncated, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [issueId, branchId, fromNode, eventType, summary, contentJson, isTruncated, now]);
            const row = db.get('SELECT * FROM ledger WHERE rowid = last_insert_rowid()');
            return ok(row);
        }),
        ledger_list: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const issueId = requireArg(args, 'issue_id');
            const branchId = args['branch_id'] ?? null;
            const rawLimit = args['limit'] ?? 50;
            const limit = Math.min(Math.max(1, rawLimit), 500);
            const offset = Math.max(0, args['offset'] ?? 0);
            let rows;
            if (branchId !== null) {
                rows = db.all(`SELECT * FROM ledger WHERE issue_id = ? AND branch_id = ?
           ORDER BY id ASC LIMIT ? OFFSET ?`, [issueId, branchId, limit, offset]);
            }
            else {
                rows = db.all(`SELECT * FROM ledger WHERE issue_id = ?
           ORDER BY id ASC LIMIT ? OFFSET ?`, [issueId, limit, offset]);
            }
            return ok(rows);
        }),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=ledger.js.map