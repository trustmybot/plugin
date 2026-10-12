import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIST = path.resolve(HERE, '../../../mcp/trajectory-server/dist/index.js');

// A server logs under its TMPDIR; each server gets its own, removed when the
// client closes, so the suite leaves nothing in the runner's TMPDIR.
export function serverEnv(base = process.env, dbPath = ':memory:') {
  const dir = mkdtempSync(path.join(tmpdir(), 'tmb-l3-server-'));
  return {
    env: { ...base, TRAJECTORY_DB_PATH: dbPath, TMPDIR: dir },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

// startClient({ fileDb: true }) backs the server with a temp-dir DB file
// instead of :memory:, so the test can write rows only a hook writes (see
// seedReviewerObservation); close() removes the dir.
export async function startClient({ env, dbPath: requestedDbPath = ':memory:', fileDb = false } = {}) {
  const dbDir = fileDb ? mkdtempSync(path.join(tmpdir(), 'tmb-l3-db-')) : null;
  const dbPath = dbDir ? path.join(dbDir, 'trajectory.db') : requestedDbPath;
  const server = serverEnv(env ?? process.env, dbPath);
  const transport = new StdioClientTransport({
    command: env ? process.execPath : 'node',
    args: [SERVER_DIST],
    env: server.env,
  });

  const client = new Client({ name: 'tmb-integration-test', version: '1.0' }, { capabilities: {} });
  await client.connect(transport);

  // Pre-seed the registry-cold gate so workflow-sim tests don't need to
  // know about the gate's existence. Tests that target the gate itself
  // can run a separate client without this seed.
  await client.callTool({
    name: 'audit_append',
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
    dbPath,
    async close() {
      await client.close();
      if (dbDir) rmSync(dbDir, { recursive: true, force: true });
      server.cleanup();
    },
  };
}

// seedReviewerObservation writes the reviewer_identity_observed row the
// reviewer-identity-observe hook writes when a pr-reviewer subagent calls
// validation_record (the server refuses a verdict without one). Needs a
// startClient({ fileDb: true }) dbPath; uses the sqlite3 CLI so it runs under
// node and bun alike.
export function seedReviewerObservation(dbPath, taskId, attemptN, { agentId = 'l3-reviewer-agent', sessionId = 'l3-main-session' } = {}) {
  const content = JSON.stringify({ task_id: Number(taskId), attempt_n: attemptN, session_id: sessionId, agent_id: agentId, consumed: 0 }).replace(/'/g, "''");
  const id = Number(taskId);
  execFileSync('sqlite3', ['-cmd', '.timeout 5000', dbPath,
    `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at, repo)
     SELECT t.issue_id, 'hook:reviewer-identity-observe', 'reviewer_identity_observed', 'l3 fixture: reviewer observed', '${content}',
            strftime('%Y-%m-%dT%H:%M:%fZ','now'), (SELECT repo FROM issues WHERE id = t.issue_id)
       FROM tasks t WHERE t.id = ${id};`]);
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
