// MCP stdio driver for upgrade-smoke.Dockerfile (GH 1465).
//
//   node upgrade-smoke-driver.mjs seed <dist/index.js>  write a real-shape DB through an old server
//   node upgrade-smoke-driver.mjs boot <dist/index.js>  boot a server on the same project and read it back
//
// Runs with cwd = the scratch project and pins TRAJECTORY_DB_PATH to the
// project DB a user's session uses (<project>/.claude/tmb/trajectory.db), so
// neither server can walk up to another DB. Exits non-zero on any JSON-RPC
// error or tool result flagged isError.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [mode, entry] = process.argv.slice(2);
if (!['seed', 'boot'].includes(mode) || !entry) {
  console.error('usage: upgrade-smoke-driver.mjs seed|boot <dist/index.js>');
  process.exit(2);
}

const env = { ...process.env, TRAJECTORY_DB_PATH: join(process.cwd(), '.claude', 'tmb', 'trajectory.db') };
const server = spawn('node', ['--experimental-sqlite', '--no-warnings', entry], {
  env,
  stdio: ['pipe', 'pipe', 'inherit'],
});

const pending = new Map();
let nextId = 1;
createInterface({ input: server.stdout }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const waiter = pending.get(msg.id);
  if (waiter) {
    pending.delete(msg.id);
    waiter(msg);
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  server.kill();
  process.exit(1);
}

async function call(name, args) {
  const res = await request('tools/call', { name, arguments: args });
  if (res.error) fail(`${name}: JSON-RPC error ${JSON.stringify(res.error)}`);
  const text = res.result?.content?.[0]?.text ?? '';
  if (res.result?.isError) fail(`${name}: tool error ${text}`);
  console.log(`ok ${name}: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const timer = setTimeout(() => fail(`${mode} timed out`), 60_000);

await request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'upgrade-smoke', version: '0' },
});
server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

if (mode === 'seed') {
  await call('onboard_state_get', { agent: 'bro' });
  const issue = await call('issue_create', {
    agent: 'bro',
    objective: 'Upgrade smoke: real-shape v1.0.x trajectory',
    description: 'Issue written by the v1.0.2 server for the L0 upgrade smoke (GH 1465).',
    labels: ['Test', 'Priority: Low'],
  });
  const issueId = String(issue.issue_id ?? issue.id);
  await call('discussion_append', {
    agent: 'bro',
    issue_id: issueId,
    author: 'bro',
    kind: 'question',
    body: 'Which shape must the upgraded DB keep?',
  });
  await call('discussion_append', {
    agent: 'bro',
    issue_id: issueId,
    author: 'bro',
    kind: 'decision',
    body: 'Keep every row a v1.0.x session writes, including custom audit event types.',
  });
  const batch = await call('task_create_batch', {
    agent: 'bro',
    issue_id: issueId,
    tasks: [
      {
        branch_id: 'test/upgrade-smoke',
        title: 'Upgrade smoke task',
        description: 'Task written by the v1.0.2 server.',
        spec_body:
          '## Description\nUpgrade smoke task.\n\n## Success Criteria\n- The DB upgrades.\n\n## Commit\ntest: upgrade smoke',
        files: ['README.md'],
        verification: ['true'],
      },
    ],
    waive_scope_gate: true,
    waive_scope_gate_reason: 'L0 upgrade smoke seeds a fixed task shape',
    waive_branch_gate: true,
    waive_branch_gate_reason: 'L0 upgrade smoke has no remote branch',
    waive_registry_gate: true,
    waive_registry_gate_reason: 'L0 upgrade smoke has no agent registry',
    waive_intent_gate: true,
    waive_intent_gate_reason: 'L0 upgrade smoke has no intent session',
    waive_decision_gate: true,
    waive_decision_gate_reason: 'L0 upgrade smoke seeds its own decision',
    waive_spec_shape: true,
    waive_spec_shape_reason: 'L0 upgrade smoke spec is deliberately short',
  });
  const taskId = String(batch.task_ids?.[0] ?? batch.tasks?.[0]?.id ?? batch.tasks?.[0]?.task_id);
  if (!taskId || taskId === 'undefined') fail(`task_create_batch returned no task id: ${JSON.stringify(batch)}`);
  await call('audit_append', {
    agent: 'bro',
    issue_id: issueId,
    branch_id: 'test/upgrade-smoke',
    from_node: 'bro',
    event_type: 'upgrade_smoke_custom_event',
    summary: 'Custom, undocumented event type as v1.0.x accepted it (GH 1464 shape)',
    content_json: JSON.stringify({ source: 'upgrade-smoke' }),
  });
  console.log(`seeded issue_id=${issueId} task_id=${taskId}`);
} else {
  await call('onboard_state_get', { agent: 'bro' });
  await call('issue_list', { agent: 'bro' });
}

clearTimeout(timer);
server.kill();
process.exit(0);
