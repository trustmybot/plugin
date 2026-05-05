import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, listTools } from './harness.mjs';

const EXPECTED_PATTERN = '^[a-z][a-z0-9_-]*$';

test('every MCP tool exposes the `agent` parameter in its inputSchema', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const tools = await listTools(client);
  assert.ok(tools.length > 20, `expected >20 tools, got ${tools.length}`);

  const missing = [];
  const badSchema = [];
  for (const tool of tools) {
    const props = tool.inputSchema?.properties ?? {};
    if (!('agent' in props)) {
      missing.push(tool.name);
      continue;
    }
    const agentProp = props.agent;
    if (agentProp.type !== 'string') {
      badSchema.push(`${tool.name}: type=${agentProp.type}`);
    }
    if (agentProp.pattern !== EXPECTED_PATTERN) {
      badSchema.push(`${tool.name}: pattern=${JSON.stringify(agentProp.pattern)}`);
    }
  }

  assert.deepEqual(missing, [], `tools missing \`agent\` in schema: ${missing.join(', ')}`);
  assert.deepEqual(badSchema, [], `tools with bad \`agent\` schema: ${badSchema.join('; ')}`);
});
