import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, listTools } from './harness.mjs';

const EXPECTED_ROLES = ['bro', 'architect', 'swe', 'pr-reviewer'];

test('every MCP tool exposes the `agent` parameter in its inputSchema', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const tools = await listTools(client);
  assert.ok(tools.length > 20, `expected >20 tools, got ${tools.length}`);

  const missing = [];
  const badEnum = [];
  for (const tool of tools) {
    const props = tool.inputSchema?.properties ?? {};
    if (!('agent' in props)) {
      missing.push(tool.name);
      continue;
    }
    const agentProp = props.agent;
    if (agentProp.type !== 'string') {
      badEnum.push(`${tool.name}: type=${agentProp.type}`);
    }
    if (!Array.isArray(agentProp.enum) || !EXPECTED_ROLES.every((r) => agentProp.enum.includes(r))) {
      badEnum.push(`${tool.name}: enum=${JSON.stringify(agentProp.enum)}`);
    }
  }

  assert.deepEqual(missing, [], `tools missing \`agent\` in schema: ${missing.join(', ')}`);
  assert.deepEqual(badEnum, [], `tools with bad \`agent\` schema: ${badEnum.join('; ')}`);
});
