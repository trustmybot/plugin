import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readCodexPackageMetadata } from './codex-package.js';
import { CodexRuntimeManager } from './codex-runtime.js';
import {
  createCodexToolRegistry,
} from './codex-tools.js';
import { createShutdown, installShutdownHandlers } from './shutdown.js';

const plugin = readCodexPackageMetadata();
const manager = new CodexRuntimeManager({ plugin });
const registry = createCodexToolRegistry(manager);

const server = new Server(
  { name: 'tmb-codex', version: plugin.version },
  {
    capabilities: { tools: {} },
    instructions:
      'This Codex adapter exposes the bounded TMB Bro planning surface. Every call requires an explicit Git worktree root; state and planning records stay under that project\'s ignored .tmb/tmb directory. Task execution, review, push, merge, remote issue mutation, onboarding, and lifecycle enforcement are not exposed.',
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...registry.definitions],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return registry.call(request.params.name, request.params.arguments);
});

const shutdown = createShutdown({
  closeDb: () => manager.close(),
  closeGraph: () => {},
  log: () => {},
  exit: (code) => process.exit(code),
  pid: process.pid,
});
installShutdownHandlers(shutdown, process, process.stdin);

await server.connect(new StdioServerTransport());
