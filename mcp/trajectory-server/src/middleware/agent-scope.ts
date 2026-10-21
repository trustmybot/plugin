import type { Issue, ValidationAttempt } from '../types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type AgentRole =
  | 'bro'
  | 'swe'
  | 'pr-reviewer'
  | 'consultant'
  | 'unknown';

const FIRST_CLASS_ROLES = new Set<AgentRole>(['bro', 'swe', 'pr-reviewer']);
const ALL_ROLES: AgentRole[] = ['bro', 'swe', 'pr-reviewer', 'consultant'];

export function normalizeAgent(name?: unknown): AgentRole {
  if (typeof name !== 'string') return 'unknown';
  const lower = name.toLowerCase().replace(/^tmb:/, '');
  if (!lower) return 'unknown';
  if (FIRST_CLASS_ROLES.has(lower as AgentRole)) return lower as AgentRole;
  if (/^[a-z][a-z0-9_-]*$/.test(lower)) return 'consultant';
  return 'unknown';
}

export type { ValidationAttempt };

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

const VALID_AGENTS = ['bro', 'swe', 'pr-reviewer', 'consultant slug matching ^[a-z][a-z0-9_-]*$'];

function missingAgentDiagnostics(toolName: string, allowedRoles: AgentRole[], received: unknown) {
  const agentReceived = received === undefined ? null : received;
  return {
    reason: 'agent_missing_or_invalid',
    agent_received: agentReceived,
    valid_agents: VALID_AGENTS,
    message:
      `\`agent\` was missing or invalid (received: ${JSON.stringify(agentReceived)}). ` +
      'This is a missing-argument error, not a role restriction — retry with agent set to your role: ' +
      "'bro', 'swe', 'pr-reviewer', or a consultant slug matching ^[a-z][a-z0-9_-]*$. " +
      `${toolName} accepts: ${allowedRoles.join(', ')}.`,
  };
}

function forbidden(toolName: string, agent: AgentRole, allowedRoles: AgentRole[], received: unknown): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
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

const gatedRoles = new WeakMap<Fn, AgentRole[]>();

export function requireRoles(toolName: string, allowedRoles: AgentRole[], handler: Fn): Fn {
  const allowed = new Set(allowedRoles);
  const gated: Fn = async (args) => {
    const agent = normalizeAgent(args['agent']);
    if (!allowed.has(agent)) return forbidden(toolName, agent, allowedRoles, args['agent']);
    return handler(args);
  };
  gatedRoles.set(gated, [...allowedRoles]);
  return gated;
}

export function requireAgent(toolName: string, handler: Fn): Fn {
  const allowedRoles = gatedRoles.get(handler) ?? ALL_ROLES;
  return async (args) => {
    if (normalizeAgent(args['agent']) === 'unknown') {
      return forbidden(toolName, 'unknown', allowedRoles, args['agent']);
    }
    return handler(args);
  };
}

export function redactIssue(
  issue: Issue,
  agent: AgentRole,
  opts?: { include_description?: boolean },
): Partial<Issue> {
  if (agent === 'swe' || agent === 'unknown') {
    const { description: _, ...rest } = issue;
    void _;
    const truncated =
      rest.objective.length > 120 ? rest.objective.slice(0, 120) + '...' : rest.objective;
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

export function redactValidationRow(
  row: ValidationAttempt,
  agent: AgentRole,
  scope: { own_task_id?: number },
): Partial<ValidationAttempt> {
  if (agent === 'swe' && row.task_id !== scope.own_task_id) {
    const { feedback: _, ...rest } = row;
    void _;
    return rest;
  }
  return row;
}

