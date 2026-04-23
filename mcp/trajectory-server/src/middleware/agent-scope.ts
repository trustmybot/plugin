import type { Issue } from '../types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type AgentRole =
  | 'gatekeeper'
  | 'architect'
  | 'swe'
  | 'pr-reviewer'
  | 'unknown';

const KNOWN_ROLES = new Set<AgentRole>([
  'gatekeeper',
  'architect',
  'swe',
  'pr-reviewer',
]);

export function normalizeAgent(name?: string): AgentRole {
  if (!name) return 'unknown';
  const lower = name.toLowerCase() as AgentRole;
  return KNOWN_ROLES.has(lower) ? lower : 'unknown';
}

export interface ValidationAttempt {
  id: number;
  task_id: number;
  attempt_n: number;
  agent: string;
  verdict: string;
  feedback: string;
  created_at: string;
}

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

export function requireRoles(toolName: string, allowedRoles: AgentRole[], handler: Fn): Fn {
  const allowed = new Set(allowedRoles);
  return async (args) => {
    const agent = normalizeAgent(args['agent'] as string | undefined);
    if (!allowed.has(agent)) {
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
            }),
          },
        ],
      };
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
    const { description: _, pre_commit_hash: __, ...rest } = issue;
    void _;
    void __;
    const truncated =
      rest.objective.length > 120 ? rest.objective.slice(0, 120) + '...' : rest.objective;
    return { ...rest, objective: truncated };
  }

  // Architect and gatekeeper are full-trust; description gated only on opts.include_description.
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

/**
 * Pass-through wrapper around a handler. Kept as a seam for future
 * cross-cutting concerns (tracing, metrics, etc.) that need to see every
 * MCP tool call. Redaction is done INSIDE individual handlers against
 * `redactIssue` / `redactValidationRow`; role enforcement is done via
 * `requireRoles`. This function deliberately does not carry a redactor
 * argument — callers that need redaction should apply it in-handler.
 */
export function withAgentScope(_toolName: string, handler: Fn): Fn {
  return handler;
}
