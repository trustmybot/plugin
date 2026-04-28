import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { toolDefinitions, toolHandlers, registerTools } from './tools/index.js';
import { TrajectoryDB, resolveDbPath } from './db.js';
import { serverLog } from './logger.js';

const dbPath = resolveDbPath();
if (dbPath !== ':memory:') {
  mkdirSync(path.dirname(dbPath), { recursive: true });
}

const db = new TrajectoryDB(dbPath);

const server = new Server(
  { name: 'trajectory-server', version: '0.3.2' },
  { capabilities: { tools: {} } },
);

registerTools(server, db);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions,
}));

// L5 trajectory capture (issue #108). Active only when TMB_DEBUG_TRAJECTORY=1.
// Session ID is per-server-spawn — covers a single `claude -p` invocation.
const debugTrajectoryEnabled = process.env['TMB_DEBUG_TRAJECTORY'] === '1';
const debugSessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let debugStepCounter = 0;

function maybeRecordTrajectory(
  toolName: string,
  args: unknown,
  result: { content?: ReadonlyArray<unknown>; isError?: boolean },
): void {
  if (!debugTrajectoryEnabled) return;
  try {
    const agentName = (args as { agent?: string } | undefined)?.agent ?? null;
    const argsJson = JSON.stringify(args ?? {}).slice(0, 4000);
    const firstContent = result.content?.[0] as { text?: unknown } | undefined;
    const resultText =
      firstContent && typeof firstContent.text === 'string' ? firstContent.text : '';
    const resultJson = JSON.stringify({ text: resultText.slice(0, 4000) });
    db.run(
      `INSERT INTO debug_trajectory
       (session_id, step_n, kind, agent, tool_or_mcp_name, args_json, result_json, is_error, created_at)
       VALUES (?, ?, 'mcp_call', ?, ?, ?, ?, ?, datetime('now'))`,
      [
        debugSessionId,
        ++debugStepCounter,
        agentName,
        toolName,
        argsJson,
        resultJson,
        result.isError ? 1 : 0,
      ],
    );
  } catch {
    // Trajectory capture must never break the actual tool call.
  }
}

process.on('uncaughtException', (err: Error) => {
  serverLog({ kind: 'error', error_message: err.message, stack: err.stack });
  process.stderr.write(`uncaughtException: ${err.message}\n${err.stack ?? ''}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  serverLog({ kind: 'error', error_message: msg, stack });
  process.stderr.write(`unhandledRejection: ${msg}\n`);
  process.exit(1);
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = toolHandlers[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  const start = performance.now();
  const agent = (args as Record<string, unknown> | undefined)?.agent ?? null;
  serverLog({ kind: 'tool_entry', tool: name, agent });
  let result: Awaited<ReturnType<typeof handler>>;
  try {
    result = await handler(args ?? {});
  } catch (err) {
    const duration_ms = Math.round(performance.now() - start);
    serverLog({
      kind: 'tool_exit',
      tool: name,
      agent,
      is_error: true,
      error_message: err instanceof Error ? err.message : String(err),
      duration_ms,
    });
    throw err;
  }
  const duration_ms = Math.round(performance.now() - start);
  serverLog({
    kind: 'tool_exit',
    tool: name,
    agent,
    is_error: result.isError ?? false,
    duration_ms,
  });
  maybeRecordTrajectory(name, args, result);
  return result;
});

process.on('SIGINT', () => {
  serverLog({ kind: 'shutdown', signal: 'SIGINT' });
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  serverLog({ kind: 'shutdown', signal: 'SIGTERM' });
  db.close();
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);
serverLog({ kind: 'startup', pid: process.pid, version: '0.5.0', db_path: dbPath });

process.stderr.write(`server started (db: ${dbPath})\n`);
