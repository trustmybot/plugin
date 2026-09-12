// Pure Codex surface metadata shared by the Hook and bundled MCP registry.
// This module has no imports, runtime initialization, or host-state access.
export const CODEX_SCOPE_3_TOOL_NAMES = Object.freeze([
  "runtime_initialize",
  "project_inventory",
  "project_scan",
  "world_model_get",
  "world_model_search",
  "planning_label_taxonomy_get",
  "planning_label_taxonomy_set",
  "planning_issue_create",
  "planning_issue_get",
  "planning_issue_list",
  "planning_issue_resume",
  "planning_discussion_append",
  "planning_discussion_list",
]);

export const CODEX_SCOPE_4_TOOL_NAMES = Object.freeze([
  ...CODEX_SCOPE_3_TOOL_NAMES,
  "agent_materialization_get",
  "agent_materialization_set",
]);
