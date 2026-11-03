import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openDb } from './db.js';
import { registerTools } from './tools/index.js';
export { openDb } from './db.js';
const db = openDb(process.argv[2]);
const server = new McpServer({ name: 'trajectory', version: '0.0.0' });
registerTools(server, db);
//# sourceMappingURL=index.js.map
