import { nowISO } from '../db.js';
import { normalizeAgent, requireRoles } from '../middleware/agent-scope.js';
const ALLOWED_KINDS = new Set(['intent', 'question', 'answer', 'decision', 'note', 'analysis']);
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
export function discussionTools(db) {
    const definitions = [
        {
            name: 'discussion_append',
            description: 'Append a discussion entry to an issue. Captures conversational intent, questions, answers, decisions, or notes into the SQLite log.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string', description: 'Caller agent name' },
                    issue_id: { type: 'string', description: 'The issue ID (integer as string)' },
                    author: { type: 'string', description: 'Author of this entry (agent name or human)' },
                    kind: {
                        type: 'string',
                        enum: ['intent', 'question', 'answer', 'decision', 'note', 'analysis'],
                        description: 'Entry kind. Default: note',
                    },
                    body: { type: 'string', description: 'Markdown body of the discussion entry' },
                    verified_human: {
                        type: 'boolean',
                        description: 'Reserved for UserPromptSubmit hook captures only. Must be true when author="human"; agents must never set this on self-authored entries. Gate-only — not persisted.',
                    },
                },
                required: ['agent', 'issue_id', 'author', 'body'],
            },
        },
        {
            name: 'discussion_list',
            description: 'Return discussion entries for an issue ordered by created_at ASC. Used by bro at session resume and by snapshot generation.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    issue_id: { type: 'string' },
                    limit: { type: 'number', description: 'Max rows to return. Default 50, max 200.' },
                    offset: { type: 'number', description: 'Row offset for pagination. Default 0.' },
                },
                required: ['agent', 'issue_id'],
            },
        },
        {
            name: 'issue_get_with_discussions',
            description: 'Convenience call: returns the issue row + its full discussion list + its task list in one round-trip.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    issue_id: { type: 'string' },
                },
                required: ['agent', 'issue_id'],
            },
        },
    ];
    const handlers = {
        discussion_append: requireRoles('discussion_append', ['bro', 'swe', 'pr-reviewer', 'consultant'], wrapHandler(async (args) => {
            normalizeAgent(args['agent']);
            const issueId = requireArg(args, 'issue_id');
            const author = requireArg(args, 'author');
            const body = requireArg(args, 'body');
            const kind = args['kind'] ?? 'note';
            if (!ALLOWED_KINDS.has(kind)) {
                return err(`Invalid kind: "${kind}". Allowed values: ${[...ALLOWED_KINDS].join(', ')}`);
            }
            if (!author.trim()) {
                throw new Error('author must be a non-empty string');
            }
            const verifiedHuman = Boolean(args['verified_human']);
            if (author === 'human' && !verifiedHuman) {
                throw new Error('precondition_failed: discussion_append with author="human" requires verified_human=true. This flag must only be set by legitimate UserPromptSubmit hook captures, never by agent self-attribution. Use author="bro" with body citing the human verbatim instead.');
            }
            const issue = db.get('SELECT id FROM issues WHERE id = ?', [issueId]);
            if (!issue) {
                throw new Error(`Not found: issue ${issueId}`);
            }
            const now = nowISO();
            db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
           VALUES (?, ?, ?, ?, ?)`, [issueId, author, kind, body, now]);
            const row = db.get('SELECT * FROM discussions WHERE rowid = last_insert_rowid()');
            return ok(row);
        })),
        discussion_list: wrapHandler(async (args) => {
            normalizeAgent(args['agent']);
            const issueId = requireArg(args, 'issue_id');
            const rawLimit = args['limit'] ?? 50;
            const rawOffset = args['offset'] ?? 0;
            const limit = Math.min(Math.max(1, rawLimit), 200);
            const offset = Math.max(0, rawOffset);
            const issue = db.get('SELECT id FROM issues WHERE id = ?', [issueId]);
            if (!issue) {
                return ok({ discussions: [], warning: 'issue not found' });
            }
            const rows = db.all(`SELECT * FROM discussions WHERE issue_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?`, [issueId, limit, offset]);
            return ok(rows);
        }),
        issue_get_with_discussions: wrapHandler(async (args) => {
            normalizeAgent(args['agent']);
            const issueId = requireArg(args, 'issue_id');
            const issue = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            if (!issue) {
                throw new Error(`Not found: issue ${issueId}`);
            }
            const discussions = db.all(`SELECT * FROM discussions WHERE issue_id = ? ORDER BY created_at ASC`, [issueId]);
            const tasks = db.all(`SELECT id, branch_id, status, title FROM tasks WHERE issue_id = ? ORDER BY branch_id ASC`, [issueId]);
            return ok({ issue, discussions, tasks });
        }),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=discussions.js.map