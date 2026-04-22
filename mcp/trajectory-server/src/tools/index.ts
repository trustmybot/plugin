import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { discussionTools } from './discussions.js';
import { issueTools } from './issues.js';
import { taskTools } from './tasks.js';
import { ledgerTools } from './ledger.js';
import { auditTools } from './audit.js';
import { validationTools } from './validation.js';
import { skillTools } from './skills.js';
import { reportTools } from './reports.js';
import { configTools } from './config.js';
import { identityTools } from './identity.js';
import { regenStateTools } from './regen-state.js';
import { fileRegistryTools } from './file-registry.js';
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

export function registerTools(server: Server, db: TrajectoryDB): void {
  const discussions = discussionTools(db);
  const issues = issueTools(db);
  const tasks = taskTools(db);
  const ledger = ledgerTools(db);
  const audit = auditTools(db);
  const validation = validationTools(db);
  const skills = skillTools(db);
  const reports = reportTools(db);
  const config = configTools(db);
  const identity = identityTools(db);
  const regenState = regenStateTools(db);
  const fileRegistry = fileRegistryTools(db);

  toolDefinitions = [
    ...discussions.definitions,
    ...issues.definitions,
    ...tasks.definitions,
    ...ledger.definitions,
    ...audit.definitions,
    ...validation.definitions,
    ...skills.definitions,
    ...reports.definitions,
    ...config.definitions,
    ...identity.definitions,
    ...regenState.definitions,
    ...fileRegistry.definitions,
  ];

  toolHandlers = {
    ...wrapAll(discussions.handlers),
    ...wrapAll(issues.handlers),
    ...wrapAll(tasks.handlers),
    ...wrapAll(ledger.handlers),
    ...wrapAll(audit.handlers),
    ...wrapAll(validation.handlers),
    ...wrapAll(skills.handlers),
    ...wrapAll(reports.handlers),
    ...wrapAll(config.handlers),
    ...wrapAll(identity.handlers),
    ...wrapAll(regenState.handlers),
    ...wrapAll(fileRegistry.handlers),
  };
}
