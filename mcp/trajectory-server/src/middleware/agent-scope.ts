import type { Issue, ValidationAttempt } from '../types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type AgentRole =
  | 'bro'
  | 'swe'
  | 'pr-reviewer'
  | 'consultant'
  | 'unknown';

const FIRST_CLASS_ROLES = new Set<AgentRole>(['bro', 'swe', 'pr-reviewer']);

export function normalizeAgent(name?: string): AgentRole {
  if (!name) return 'unknown';
  const lower = name.toLowerCase();
  if (FIRST_CLASS_ROLES.has(lower as AgentRole)) return lower as AgentRole;
  if (/^[a-z][a-z0-9_-]*$/.test(lower)) return 'consultant';
  return 'unknown';
}

export type { ValidationAttempt };

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

