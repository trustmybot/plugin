export interface Issue {
  id: number;
  parent_issue_id: number | null;
  objective: string;
  goals_md: string;
  goals_md_hash: string;
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
  branch_id: string;
  parent_branch_id: string | null;
  title: string;
  description: string;
  tools_required: string;
  skills_required: string;
  success_criteria: string;
  status: string;
  attempts: number;
  execution_plan_md: string;
  qa_results: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
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
  branch_id: string;
  parent_branch_id?: string;
  title?: string;
  description: string;
  tools_required?: string[];
  skills_required?: string[];
  success_criteria: string;
  execution_plan_md?: string;
}
