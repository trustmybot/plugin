export interface Issue {
  id: number;
  parent_issue_id: number | null;
  objective: string;
  description: string;
  pre_commit_hash: string;
  post_commit_hash: string | null;
  status: string;
  current_task_id: number | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
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
  tools_required: string;
  skills_required: string;
  success_criteria: string;
  status: string;
  attempts: number;
  spec_body: string;
  commit_sha: string | null;
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

export interface LedgerEntry {
  id: number;
  issue_id: number;
  branch_id: string | null;
  from_node: string;
  event_type: string;
  summary: string;
  content: string;
  is_truncated: number;
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
  tools_required?: string[];
  skills_required?: string[];
  success_criteria: string;
  spec_body?: string;
}

export interface FileRegistryRow {
  path: string;
  type: string;
  language: string | null;
  size_bytes: number | null;
  last_commit_sha: string | null;
  last_change_type: string | null;
  last_change_at: string | null;
  imports_json: string;
  exports_json: string;
  metadata_json: string;
}

export interface PluginConfigRow {
  key: string;
  value_json: string;
  updated_at: string;
}

export interface IdentityRow {
  id: number;
  human_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface RegenStateRow {
  target: string;
  last_regen_at: string | null;
  last_seen_sha: string | null;
  notes: string;
}
