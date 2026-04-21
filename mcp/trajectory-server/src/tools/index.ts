import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { issueTools } from './issues.js';
import { taskTools } from './tasks.js';
import { ledgerTools } from './ledger.js';

export let toolDefinitions: Tool[] = [];
export let toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<CallToolResult>> = {};

export function registerTools(server: Server, db: TrajectoryDB): void {
  const issues = issueTools(db);
  const tasks = taskTools(db);
  const ledger = ledgerTools(db);

  toolDefinitions = [
    ...issues.definitions,
    ...tasks.definitions,
    ...ledger.definitions,
  ];

  toolHandlers = {
    ...issues.handlers,
    ...tasks.handlers,
    ...ledger.handlers,
  };
}
