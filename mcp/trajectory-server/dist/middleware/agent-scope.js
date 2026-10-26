const FIRST_CLASS_ROLES = new Set(['bro', 'swe', 'code-reviewer']);
const ALL_ROLES = ['bro', 'swe', 'code-reviewer', 'consultant'];
export function normalizeAgent(name) {
    if (typeof name !== 'string')
        return 'unknown';
    const lower = name.toLowerCase().replace(/^tmb:/, '');
    if (!lower)
        return 'unknown';
    if (FIRST_CLASS_ROLES.has(lower))
        return lower;
    if (/^[a-z][a-z0-9_-]*$/.test(lower))
        return 'consultant';
    return 'unknown';
}
const VALID_AGENTS = ['bro', 'swe', 'code-reviewer', 'consultant slug matching ^[a-z][a-z0-9_-]*$'];
function missingAgentDiagnostics(toolName, allowedRoles, received) {
    const agentReceived = received === undefined ? null : received;
    return {
        reason: 'agent_missing_or_invalid',
        agent_received: agentReceived,
        valid_agents: VALID_AGENTS,
        message: `\`agent\` was missing or invalid (received: ${JSON.stringify(agentReceived)}). ` +
            'This is a missing-argument error, not a role restriction — retry with agent set to your role: ' +
            "'bro', 'swe', 'code-reviewer', or a consultant slug matching ^[a-z][a-z0-9_-]*$. " +
            `${toolName} accepts: ${allowedRoles.join(', ')}.`,
    };
}
function forbidden(toolName, agent, allowedRoles, received) {
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
                    ...(agent === 'unknown' ? missingAgentDiagnostics(toolName, allowedRoles, received) : {}),
                }),
            },
        ],
    };
}
const gatedRoles = new WeakMap();
export function requireRoles(toolName, allowedRoles, handler) {
    const allowed = new Set(allowedRoles);
    const gated = async (args) => {
        const agent = normalizeAgent(args['agent']);
        if (!allowed.has(agent))
            return forbidden(toolName, agent, allowedRoles, args['agent']);
        return handler(args);
    };
    gatedRoles.set(gated, [...allowedRoles]);
    return gated;
}
export function requireAgent(toolName, handler) {
    const allowedRoles = gatedRoles.get(handler) ?? ALL_ROLES;
    return async (args) => {
        if (normalizeAgent(args['agent']) === 'unknown') {
            return forbidden(toolName, 'unknown', allowedRoles, args['agent']);
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
    // Bro, consultants, and code-reviewer are full-trust; description gated only on opts.include_description.
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
//# sourceMappingURL=agent-scope.js.map