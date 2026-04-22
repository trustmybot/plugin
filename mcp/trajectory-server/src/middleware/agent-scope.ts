import type { Issue } from '../types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type AgentRole =
  | 'gatekeeper'
  | /** @deprecated v0.3 — use 'gatekeeper'; aliased in normalizeAgent */
  'secretary'
  | 'architect'
  | 'swe'
  | 'pr-reviewer'
  | 'prompt-engineer'
  | 'unknown';

const KNOWN_ROLES = new Set<AgentRole>([
  'gatekeeper',
  'secretary',
  'architect',
  'swe',
  'pr-reviewer',
  'prompt-engineer',
]);

export function normalizeAgent(name?: string): AgentRole {
  if (!name) return 'unknown';
  const lower = name.toLowerCase() as AgentRole;
  // Back-compat: v0.2 callers may still pass 'secretary'.
  if (lower === 'secretary') return 'gatekeeper';
  return KNOWN_ROLES.has(lower) ? lower : 'unknown';
}

export interface ValidationAttempt {
  id: number;
  task_id: string;
  attempt_n: number;
  agent: string;
  verdict: string;
  feedback_md: string;
  reviewer_verdict: string | null;
  created_at: string;
}

export type Redactor<T> = (value: T, agent: AgentRole, args: Record<string, unknown>) => T;

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
  opts?: { include_goals?: boolean },
): Partial<Issue> {
  if (agent === 'swe' || agent === 'unknown') {
    const { goals_md: _, pre_commit_hash: __, ...rest } = issue;
    void _;
    void __;
    const truncated =
      rest.objective.length > 120 ? rest.objective.slice(0, 120) + '...' : rest.objective;
    return { ...rest, objective: truncated };
  }

  // gatekeeper is full-trust: same treatment as architect — no objective truncation,
  // goals_md gated only on opts.include_goals.
  if (!opts?.include_goals) {
    const { goals_md: _, ...rest } = issue;
    void _;
    return rest;
  }

  return issue;
}

export function redactValidationRow(
  row: ValidationAttempt,
  agent: AgentRole,
  scope: { own_task_id?: string },
): Partial<ValidationAttempt> {
  if (agent === 'swe' && row.task_id !== scope.own_task_id) {
    const { feedback_md: _, ...rest } = row;
    void _;
    return rest;
  }
  return row;
}

export function withAgentScope<T>(
  toolName: string,
  handler: Fn,
  redactor?: Redactor<T>,
): Fn {
  return async (args) => {
    const agent = normalizeAgent(args['agent'] as string | undefined);
    const result = await handler(args);

    if (!redactor || result.isError) return result;

    const first = result.content[0];
    if (!first || first.type !== 'text') return result;

    const parsed = JSON.parse(first.text) as T;
    if (parsed === null) return result;

    const redacted = redactor(parsed, agent, args);
    return { ...result, content: [{ type: 'text' as const, text: JSON.stringify(redacted) }] };
  };
}
