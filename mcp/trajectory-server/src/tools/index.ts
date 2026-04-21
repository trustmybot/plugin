import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const toolDefinitions: Tool[] = [];
export const toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<CallToolResult>> = {};

export function registerTools(server: unknown, db: unknown): void {}
