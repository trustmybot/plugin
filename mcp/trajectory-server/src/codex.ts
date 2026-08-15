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
      'This Codex adapter exposes bounded local Bro planning and explicit management of two fixed project-level Agent files. Every call requires an explicit Git worktree root. Planning state stays under the project\'s ignored .tmb/tmb directory; Agent setup can only inspect, create, or remove .codex/agents/tmb_swe.toml and .codex/agents/tmb_pr_reviewer.toml. Task workflow, validation records, Agent spawning, Git delivery, remote issue mutation, onboarding, and lifecycle Hooks are not exposed.',
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
