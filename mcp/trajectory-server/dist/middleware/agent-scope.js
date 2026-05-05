const FIRST_CLASS_ROLES = new Set(['bro', 'swe', 'pr-reviewer']);
export function normalizeAgent(name) {
    if (!name)
        return 'unknown';
    const lower = name.toLowerCase();
    if (FIRST_CLASS_ROLES.has(lower))
        return lower;
    if (/^[a-z][a-z0-9_-]*$/.test(lower))
        return 'consultant';
    return 'unknown';
}
export function requireRoles(toolName, allowedRoles, handler) {
    const allowed = new Set(allowedRoles);
    return async (args) => {
        const agent = normalizeAgent(args['agent']);
        if (!allowed.has(agent)) {
            return {
                isError: true,
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            error: 'forbidden',
                            tool: toolName,
                            caller_role: agent,
                            allowed_roles: [...allowedRoles],
                        }),
                    },
                ],
            };
        }
        return handler(args);
    };
}
export function redactIssue(issue, agent, opts) {
    if (agent === 'swe' || agent === 'unknown') {
        const { description: _, ...rest } = issue;
        void _;
        const truncated = rest.objective.length > 120 ? rest.objective.slice(0, 120) + '...' : rest.objective;
        return { ...rest, objective: truncated };
    }
    // Bro, consultants, and pr-reviewer are full-trust; description gated only on opts.include_description.
    if (!opts?.include_description) {
        const { description: _, ...rest } = issue;
        void _;
        return rest;
    }
    return issue;
}
export function redactValidationRow(row, agent, scope) {
    if (agent === 'swe' && row.task_id !== scope.own_task_id) {
        const { feedback: _, ...rest } = row;
        void _;
        return rest;
    }
    return row;
}
/**
 * Pass-through wrapper around a handler. Kept as a seam for future
 * cross-cutting concerns (tracing, metrics, etc.) that need to see every
 * MCP tool call. Redaction is done INSIDE individual handlers against
 * `redactIssue` / `redactValidationRow`; role enforcement is done via
 * `requireRoles`. This function deliberately does not carry a redactor
 * argument — callers that need redaction should apply it in-handler.
 */
export function withAgentScope(_toolName, handler) {
    return handler;
}
//# sourceMappingURL=agent-scope.js.map