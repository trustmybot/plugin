import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { issueTools } from './issues.js';
import { taskTools } from './tasks.js';
import { ledgerTools } from './ledger.js';
import { auditTools } from './audit.js';
import { validationTools } from './validation.js';
import { skillTools } from './skills.js';
import { reportTools } from './reports.js';
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
  const issues = issueTools(db);
  const tasks = taskTools(db);
  const ledger = ledgerTools(db);
  const audit = auditTools(db);
  const validation = validationTools(db);
  const skills = skillTools(db);
  const reports = reportTools(db);

  toolDefinitions = [
    ...issues.definitions,
    ...tasks.definitions,
    ...ledger.definitions,
    ...audit.definitions,
    ...validation.definitions,
    ...skills.definitions,
    ...reports.definitions,
  ];

  toolHandlers = {
    ...wrapAll(issues.handlers),
    ...wrapAll(tasks.handlers),
    ...wrapAll(ledger.handlers),
    ...wrapAll(audit.handlers),
    ...wrapAll(validation.handlers),
    ...wrapAll(skills.handlers),
    ...wrapAll(reports.handlers),
  };
}
