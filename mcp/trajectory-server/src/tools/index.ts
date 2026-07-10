import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import type { GraphHolder } from '../graph-db.js';
import { discussionTools } from './discussions.js';
import { issueTools } from './issues.js';
import { taskTools } from './tasks.js';
import { auditTools } from './audit.js';
import { validationTools } from './validation.js';
import { skillTools } from './skills.js';
import { agentTools } from './agents.js';
import { reportTools } from './reports.js';
import { configTools } from './config.js';
import { branchReportMdTools } from './branch_report_md.js';
import { statsTools } from './stats.js';
import { roundtableTools } from './roundtable.js';
import { prMonitorTools } from './pr_monitor.js';
import { compositeTools } from './composites.js';
import { onboardTools } from './onboard.js';
import { scanTools } from './scan.js';
import { cheatcodeTools } from './cheatcode.js';
import { worldModelTools } from './world_model.js';
export let toolDefinitions: Tool[] = [];
export let toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<CallToolResult>> = {};

function decorateWithAgent(tools: Tool[]): Tool[] {
  return tools.map((t) => {
    const existing = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    const existingAgent = existing['agent'] as Record<string, unknown> | undefined;
    const mergedAgent: Record<string, unknown> = {
      type: 'string',
      pattern: '^[a-z][a-z0-9_-]*$',
      description: 'Calling agent: bro, swe, pr-reviewer, or a consultant name.',
      ...existingAgent,
    };
    return {
      ...t,
      inputSchema: {
        ...t.inputSchema,
        properties: {
          ...existing,
          agent: mergedAgent,
        },
      },
    };
  });
}

export function registerTools(
  server: Server,
  db: TrajectoryDB,
  dbPath = '',
  graphHolder: GraphHolder | null = null,
): void {
  const discussions = discussionTools(db);
  const issues = issueTools(db, dbPath);
  const tasks = taskTools(db);
  const audit = auditTools(db);
  const validation = validationTools(db);
  const skills = skillTools(db);
  const agents = agentTools(db, dbPath);
  const reports = reportTools(db);
  const config = configTools(db);
  const branchReport = branchReportMdTools(db);
  const stats = statsTools(db);
  const roundtable = roundtableTools(db);
  const prMonitor = prMonitorTools(db);
  const composites = compositeTools(db, dbPath, graphHolder);
  const onboard = onboardTools(db, dbPath);
  const scan = scanTools(db, graphHolder, dbPath);
  const cheatcode = cheatcodeTools(db);
  const worldModel = worldModelTools(db, graphHolder);

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
    ...branchReport.definitions,
    ...stats.definitions,
    ...roundtable.definitions,
    ...prMonitor.definitions,
    ...composites.definitions,
    ...onboard.definitions,
    ...scan.definitions,
    ...cheatcode.definitions,
    ...worldModel.definitions,
  ]);

  toolHandlers = {
    ...discussions.handlers,
    ...issues.handlers,
    ...tasks.handlers,
    ...audit.handlers,
    ...validation.handlers,
    ...skills.handlers,
    ...agents.handlers,
    ...reports.handlers,
    ...config.handlers,
    ...branchReport.handlers,
    ...stats.handlers,
    ...roundtable.handlers,
    ...prMonitor.handlers,
    ...composites.handlers,
    ...onboard.handlers,
    ...scan.handlers,
    ...cheatcode.handlers,
    ...worldModel.handlers,
  };
}
