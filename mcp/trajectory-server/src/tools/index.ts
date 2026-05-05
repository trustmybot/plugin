import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { discussionTools } from './discussions.js';
import { issueTools } from './issues.js';
import { taskTools } from './tasks.js';
import { auditTools } from './audit.js';
import { validationTools } from './validation.js';
import { skillTools } from './skills.js';
import { reportTools } from './reports.js';
import { configTools } from './config.js';
import { identityTools } from './identity.js';
import { regenStateTools } from './regen-state.js';
import { fileRegistryTools } from './file-registry.js';
import { architectureRegenTools } from './architecture-regen.js';
import { branchReportMdTools } from './branch_report_md.js';
import { labelTools } from './labels.js';
import { statsTools } from './stats.js';
import { roundtableTools } from './roundtable.js';
import { prCommentsTools } from './pr_comments.js';
import { projectMetadataTools } from './project-metadata.js';
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
  const reports = reportTools(db);
  const config = configTools(db);
  const identity = identityTools(db);
  const regenState = regenStateTools(db);
  const fileRegistry = fileRegistryTools(db, dbPath);
  const architectureRegen = architectureRegenTools(db);
  const branchReport = branchReportMdTools(db);
  const labels = labelTools(db);
  const stats = statsTools(db);
  const roundtable = roundtableTools(db);
  const prComments = prCommentsTools(db);
  const projectMetadata = projectMetadataTools(db);

  toolDefinitions = decorateWithAgent([
    ...discussions.definitions,
    ...issues.definitions,
    ...tasks.definitions,
    ...audit.definitions,
    ...validation.definitions,
    ...skills.definitions,
    ...reports.definitions,
    ...config.definitions,
    ...identity.definitions,
    ...regenState.definitions,
    ...fileRegistry.definitions,
    ...architectureRegen.definitions,
    ...branchReport.definitions,
    ...labels.definitions,
    ...stats.definitions,
    ...roundtable.definitions,
    ...prComments.definitions,
    ...projectMetadata.definitions,
  ]);

  toolHandlers = {
    ...wrapAll(discussions.handlers),
    ...wrapAll(issues.handlers),
    ...wrapAll(tasks.handlers),
    ...wrapAll(audit.handlers),
    ...wrapAll(validation.handlers),
    ...wrapAll(skills.handlers),
    ...wrapAll(reports.handlers),
    ...wrapAll(config.handlers),
    ...wrapAll(identity.handlers),
    ...wrapAll(regenState.handlers),
    ...wrapAll(fileRegistry.handlers),
    ...wrapAll(architectureRegen.handlers),
    ...wrapAll(branchReport.handlers),
    ...wrapAll(labels.handlers),
    ...wrapAll(stats.handlers),
    ...wrapAll(roundtable.handlers),
    ...wrapAll(prComments.handlers),
    ...wrapAll(projectMetadata.handlers),
  };
}
