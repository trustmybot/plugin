export interface Issue {
  id: number;
  objective: string;
  description: string;
  status: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  remote_iid?: number | null;
  remote_kind?: 'github' | 'gitlab' | null;
  gh_iid?: number | null;
  gl_iid?: number | null;
}

export interface IssueRow {
  id: number;
  objective: string;
  description: string;
  status: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  remote_iid: number | null;
  remote_kind: 'github' | 'gitlab' | null;
  gh_iid: number | null;
  gl_iid: number | null;
}

export interface Task {
  id: number;
  issue_id: number;
  /** Git-convention name: <type>/<slug> (e.g. feat/user-login). Doubles as the working git branch. */
  branch_id: string;
  /** Parent task's git-convention branch_id, or null for root tasks. */
  parent_branch_id: string | null;
  title: string;
  description: string;
  status: string;
  attempts: number;
  spec_body: string;
  commit_sha: string | null;
  /** Relative path to the git repo for this task (e.g. "inner" or "repos/backend"). Null for single-repo CC. */
  repo: string | null;
  /**
   * 1 when this task intentionally modifies prompt-surface files (agents/,
   * skills/NAME/SKILL.md, commands/, templates/, CLAUDE.md, etc.). The
   * swe-boundary hook checks this flag before blocking prompt-surface writes.
   * Default 0.
   */
  prompt_bearing: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface Discussion {
  id: number;
  issue_id: number;
  author: string;
  kind: string;
  body: string;
  created_at: string;
}

export interface AuditEventEntry {
  id: number;
  issue_id: number;
  branch_id: string | null;
  from_node: string;
  event_type: string;
  summary: string;
  content_json: string;
  created_at: string;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface TaskInput {
  /** Git-convention name: <type>/<slug> (e.g. feat/user-login). Validated by BRANCH_ID_RE at runtime. */
  branch_id: string;
  /** Optional parent task branch_id; same git-convention format if supplied. */
  parent_branch_id?: string;
  title?: string;
  description: string;
  spec_body?: string;
  /** Optional relative path to the git repo for this task. Must not contain ".." or start with "/". */
  repo?: string;
  /**
   * Set to 1 when this task intentionally modifies prompt-surface files.
   * The swe-boundary hook will allow writes to agents/, skills/NAME/SKILL.md,
   * commands/, templates/, and identity .md files when this flag is 1.
   * Default 0.
   */
  prompt_bearing?: number;
}

export interface PluginConfigRow {
  key: string;
  value_json: string;
}

export interface ValidationAttempt {
  id: number;
  task_id: number;
  attempt_n: number;
  agent: string;
  verdict: string;
  feedback: string;
  subagent_session_id?: string | null;
  created_at: string;
}

/** Capability scope — mirrors the agents.scope CHECK. */
export type CapabilityScope = 'global' | 'template' | 'project-local';

/** Rule severity — drives downstream enforcement (advisory = inform; warning = surface; blocking = deny). */
export type RuleSeverity = 'advisory' | 'warning' | 'blocking';

export interface RuleRow {
  id: number;
  name: string;
  description: string;
  file_path: string;
  scope: CapabilityScope;
  severity: RuleSeverity;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CommandRow {
  id: number;
  name: string;
  description: string;
  file_path: string;
  scope: CapabilityScope;
  /** JSON string holding optional shape metadata (e.g. `{"argument_hint":"<PR number>"}`). */
  args_schema: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export type SkillInvocationOutcome = 'completed' | 'failed' | 'partial';
export type RuleInvocationOutcome = 'applied' | 'violated' | 'skipped';

export interface SkillInvocationRow {
  id: number;
  skill_name: string;
  agent_name: string;
  agent_run_id: number | null;
  task_id: number | null;
  invoked_at: string;
  outcome: SkillInvocationOutcome;
}

export interface RuleInvocationRow {
  id: number;
  rule_name: string;
  agent_name: string;
  agent_run_id: number | null;
  task_id: number | null;
  applied_at: string;
  outcome: RuleInvocationOutcome;
}
