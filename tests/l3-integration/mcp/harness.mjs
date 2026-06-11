import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIST = path.resolve(HERE, '../../../mcp/trajectory-server/dist/index.js');

export async function startClient() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_DIST],
    env: { ...process.env, TRAJECTORY_DB_PATH: ':memory:' },
  });

  const client = new Client({ name: 'tmb-integration-test', version: '1.0' }, { capabilities: {} });
  await client.connect(transport);

  // Pre-seed the registry-cold gate so workflow-sim tests don't need to
  // know about the gate's existence. Tests that target the gate itself
  // can run a separate client without this seed.
  await client.callTool({
    name: 'audit_log',
    arguments: {
      agent: 'bro',
      issue_id: '-1',
      from_node: 'bro',
      kind: 'event',
      event_type: 'deep_scan_completed',
      summary: 'integration-test fixture: gate cleared',
    },
  });

  return {
    client,
    async close() {
      await client.close();
    },
  };
}

export async function listTools(client) {
  const res = await client.listTools();
  return res.tools;
}

export async function call(client, name, args) {
  try {
    const res = await client.callTool({ name, arguments: args });
    if (res.isError) {
      return { ok: false, error: parseTextContent(res) };
    }
    return { ok: true, data: parseTextContent(res) };
  } catch (e) {
    return { ok: false, throw: String(e) };
  }
}

function parseTextContent(res) {
  const text = res.content?.[0]?.text;
  if (typeof text !== 'string') return res;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export { spawn };
