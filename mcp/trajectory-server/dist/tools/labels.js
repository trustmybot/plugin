import { nowISO } from '../db.js';
import { normalizeAgent, requireRoles } from '../middleware/agent-scope.js';
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9\-:]*$/;
const LABEL_MAX = 50;
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
export function decodeLabels(raw) {
    if (!raw)
        return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed))
            return parsed;
        return [];
    }
    catch {
        return [];
    }
}
export function encodeLabels(labels) {
    return JSON.stringify(labels);
}
function validateLabels(labels) {
    if (!Array.isArray(labels)) {
        throw new Error('labels must be an array');
    }
    for (const label of labels) {
        if (typeof label !== 'string' || label.length === 0) {
            throw new Error('each label must be a non-empty string');
        }
        if (label.length > LABEL_MAX) {
            throw new Error(`label "${label}" exceeds maximum length of ${LABEL_MAX}`);
        }
        if (!LABEL_RE.test(label)) {
            throw new Error(`label "${label}" is invalid — must start with alphanumeric, then alphanumeric/dash/colon only`);
        }
    }
    return labels;
}
const ALLOWED_ROLES = ['bro', 'swe', 'pr-reviewer', 'consultant'];
export function labelTools(db) {
    const definitions = [
        {
            name: 'issue_set_labels',
            description: 'Replace the full label set on an issue. Validates each label string.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string', description: 'Calling agent identity' },
                    issue_id: { type: 'string', description: 'Issue ID' },
                    labels: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Full replacement label set. Max 50 chars each, alphanumeric + dash + colon.',
                    },
                },
                required: ['agent', 'issue_id', 'labels'],
            },
        },
        {
            name: 'issue_add_labels',
            description: 'Union new labels with existing labels on an issue (deduped).',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string', description: 'Calling agent identity' },
                    issue_id: { type: 'string', description: 'Issue ID' },
                    labels: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Labels to add. Existing labels are preserved.',
                    },
                },
                required: ['agent', 'issue_id', 'labels'],
            },
        },
        {
            name: 'issue_remove_labels',
            description: 'Remove specified labels from an issue. Removing a non-existent label is a no-op.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string', description: 'Calling agent identity' },
                    issue_id: { type: 'string', description: 'Issue ID' },
                    labels: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Labels to remove.',
                    },
                },
                required: ['agent', 'issue_id', 'labels'],
            },
        },
    ];
    function getIssueOrThrow(issueId) {
        const issue = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
        if (!issue) {
            throw new Error(`Not found: issue ${issueId}`);
        }
        return issue;
    }
    function updateLabels(issueId, labels) {
        const deduped = [...new Set(labels)];
        const now = nowISO();
        db.run('UPDATE issues SET labels = ?, updated_at = ? WHERE id = ?', [
            encodeLabels(deduped),
            now,
            issueId,
        ]);
        return deduped;
    }
    const handlers = {
        issue_set_labels: requireRoles('issue_set_labels', [...ALLOWED_ROLES], wrapHandler(async (args) => {
            normalizeAgent(args['agent']);
            const issueId = requireArg(args, 'issue_id');
            const rawLabels = requireArg(args, 'labels');
            const labels = validateLabels(rawLabels);
            getIssueOrThrow(issueId);
            const result = updateLabels(issueId, labels);
            return ok({ issue_id: Number(issueId), labels: result });
        })),
        issue_add_labels: requireRoles('issue_add_labels', [...ALLOWED_ROLES], wrapHandler(async (args) => {
            normalizeAgent(args['agent']);
            const issueId = requireArg(args, 'issue_id');
            const rawLabels = requireArg(args, 'labels');
            const newLabels = validateLabels(rawLabels);
            const issue = getIssueOrThrow(issueId);
            const existing = decodeLabels(issue.labels);
            const merged = [...new Set([...existing, ...newLabels])];
            const result = updateLabels(issueId, merged);
            return ok({ issue_id: Number(issueId), labels: result });
        })),
        issue_remove_labels: requireRoles('issue_remove_labels', [...ALLOWED_ROLES], wrapHandler(async (args) => {
            normalizeAgent(args['agent']);
            const issueId = requireArg(args, 'issue_id');
            const rawLabels = requireArg(args, 'labels');
            validateLabels(rawLabels);
            const toRemove = new Set(rawLabels);
            const issue = getIssueOrThrow(issueId);
            const existing = decodeLabels(issue.labels);
            const filtered = existing.filter((l) => !toRemove.has(l));
            const result = updateLabels(issueId, filtered);
            return ok({ issue_id: Number(issueId), labels: result });
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=labels.js.map