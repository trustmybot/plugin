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

export let toolDefinitions: Tool[] = [];
export let toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<CallToolResult>> = {};

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
    ...issues.handlers,
    ...tasks.handlers,
    ...ledger.handlers,
    ...audit.handlers,
    ...validation.handlers,
    ...skills.handlers,
    ...reports.handlers,
  };
}
