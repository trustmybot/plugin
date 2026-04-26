import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { toolDefinitions, toolHandlers, registerTools } from './tools/index.js';
import { TrajectoryDB, resolveDbPath } from './db.js';
const dbPath = resolveDbPath();
if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
}
const db = new TrajectoryDB(dbPath);
const server = new Server({ name: 'trajectory-server', version: '0.3.2' }, { capabilities: { tools: {} } });
registerTools(server, db);
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
process.on('SIGINT', () => {
    db.close();
    process.exit(0);
});
process.on('SIGTERM', () => {
    db.close();
    process.exit(0);
});
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`server started (db: ${dbPath})\n`);
//# sourceMappingURL=index.js.map