import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { discussionTools } from './discussions.js';
import { issueTools } from './issues.js';
import { taskTools } from './tasks.js';
import { auditTools } from './audit.js';
import { validationTools } from './validation.js';
import { skillTools } from './skills.js';
import { agentTools } from './agents.js';
import { reportTools } from './reports.js';
import { configTools } from './config.js';
import { identityTools } from './identity.js';
import { fileRegistryTools } from './file-registry.js';
import { branchReportMdTools } from './branch_report_md.js';
// labelTools removed in #179 — issues.labels column was always-empty in
// production; local label storage retired.
// regenStateTools + architectureRegenTools removed in 2026-05 (#2881-followup):
// scan_run is the single scan-side tool now. The regen_state table + the
// regen_state_get/set/architecture_regen MCP surface were retired to stop
// confusing bro about which tool to use. Renderer code still lives in
// `renderers/` for an eventual scan_run-internal call when structural_change
// detection fires (currently inert).
import { statsTools } from './stats.js';
import { roundtableTools } from './roundtable.js';
import { prCommentsTools } from './pr_comments.js';
import { compositeTools } from './composites.js';
import { onboardTools } from './onboard.js';
import { scanTools } from './scan.js';
import { withAgentScope } from '../middleware/agent-scope.js';

export let toolDefinitions: Tool[] = [];
export let toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<CallToolResult>> = {};

function wrapAll(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<CallToolResult>>,
): Record<string, (args: Record<string, unknown>) => Promise<CallToolResult>> {
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [name, withAgentScope(name, handler)]),
  );
}

function decorateWithAgent(tools: Tool[]): Tool[] {
  return tools.map((t) => ({
    ...t,
    inputSchema: {
      ...t.inputSchema,
      properties: {
        ...((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}),
        agent: {
          type: 'string',
          pattern: '^[a-z][a-z0-9_-]*$',
          description:
            "Calling agent identity. First-class roles: bro, swe, pr-reviewer. Any other valid name is treated as consultant.",
        },
      },
    },
  }));
}

export function registerTools(server: Server, db: TrajectoryDB, dbPath = ''): void {
  const discussions = discussionTools(db);
  const issues = issueTools(db, dbPath);
  const tasks = taskTools(db);
  const audit = auditTools(db);
  const validation = validationTools(db);
  const skills = skillTools(db);
  const agents = agentTools(db);
  const reports = reportTools(db);
  const config = configTools(db);
  const identity = identityTools(db);
  const fileRegistry = fileRegistryTools(db, dbPath);
  const branchReport = branchReportMdTools(db);
  const stats = statsTools(db);
  const roundtable = roundtableTools(db);
  const prComments = prCommentsTools(db);
  const composites = compositeTools(db, dbPath);
  const onboard = onboardTools(db, dbPath);
  const scan = scanTools(db);

  toolDefinitions = decorateWithAgent([
    ...discussions.definitions,
    ...issues.definitions,
    ...tasks.definitions,
    ...audit.definitions,
    ...validation.definitions,
    ...skills.definitions,
    ...agents.definitions,
    ...reports.definitions,
    ...config.definitions,
    ...identity.definitions,
    ...fileRegistry.definitions,
    ...branchReport.definitions,
    ...stats.definitions,
    ...roundtable.definitions,
    ...prComments.definitions,
    ...composites.definitions,
    ...onboard.definitions,
    ...scan.definitions,
  ]);

  toolHandlers = {
    ...wrapAll(discussions.handlers),
    ...wrapAll(issues.handlers),
    ...wrapAll(tasks.handlers),
    ...wrapAll(audit.handlers),
    ...wrapAll(validation.handlers),
    ...wrapAll(skills.handlers),
    ...wrapAll(agents.handlers),
    ...wrapAll(reports.handlers),
    ...wrapAll(config.handlers),
    ...wrapAll(identity.handlers),
    ...wrapAll(fileRegistry.handlers),
    ...wrapAll(branchReport.handlers),
    ...wrapAll(stats.handlers),
    ...wrapAll(roundtable.handlers),
    ...wrapAll(prComments.handlers),
    ...wrapAll(composites.handlers),
    ...wrapAll(onboard.handlers),
    ...wrapAll(scan.handlers),
  };
}
