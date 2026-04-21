import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { toolDefinitions, toolHandlers } from './tools/index.js';

const dbPath =
  process.env.TRAJECTORY_DB_PATH ??
  path.join(process.cwd(), '.trajectory.db');

const server = new Server(
  { name: 'trajectory-server', version: '0.2.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = toolHandlers[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return handler(args ?? {});
});

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write(`server started (db: ${dbPath})\n`);
