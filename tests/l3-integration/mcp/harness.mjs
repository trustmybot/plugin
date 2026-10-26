import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    // Startup cheatcode reconcile shells out to the claude CLI; tests pin the documented bypass (a caller's env can override).
    env: { TMB_DISABLE_CHEATCODE_HEALTHCHECK: '1', ...base, TRAJECTORY_DB_PATH: dbPath, TMPDIR: dir },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

// startClient({ fileDb: true }) backs the server with a temp-dir DB file
// instead of :memory:, so the test can write rows only a hook writes (see
// seedReviewerObservation); close() removes the dir. extraEnv layers variables
// over the server's environment without switching the server runtime to env's.
export async function startClient({ env, extraEnv, dbPath: requestedDbPath = ':memory:', fileDb = false } = {}) {
  const dbDir = fileDb ? mkdtempSync(path.join(tmpdir(), 'tmb-l3-db-')) : null;
  const dbPath = dbDir ? path.join(dbDir, 'trajectory.db') : requestedDbPath;
  const server = serverEnv({ ...(env ?? process.env), ...extraEnv }, dbPath);
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
// reviewer-identity-observe hook writes when a code-reviewer subagent calls
// validation_record (the server refuses a verdict without one). Needs a
// startClient({ fileDb: true }) dbPath; uses the sqlite3 CLI so it runs under
// node and bun alike.
export function seedReviewerObservation(dbPath, taskId, attemptN, { agentId = 'l3-reviewer-agent', sessionId = 'l3-main-session', toolUseId = 'toolu_l3_fixture', observedAt = new Date().toISOString() } = {}) {
  const content = JSON.stringify({ task_id: Number(taskId), attempt_n: attemptN, session_id: sessionId, agent_id: agentId, tool_use_id: toolUseId, observed_at: observedAt, consumed: 0 }).replace(/'/g, "''");
  const id = Number(taskId);
  execFileSync('sqlite3', ['-cmd', '.timeout 5000', dbPath,
    `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at, repo)
     SELECT t.issue_id, 'hook:reviewer-identity-observe', 'reviewer_identity_observed', 'l3 fixture: reviewer observed', '${content}',
            strftime('%Y-%m-%dT%H:%M:%fZ','now'), (SELECT repo FROM issues WHERE id = t.issue_id)
       FROM tasks t WHERE t.id = ${id};`]);
}

// sqliteRun runs sql against a startClient({ fileDb: true }) DB through the sqlite3
// CLI and returns the rows as objects (a statement that selects nothing returns []).
export function sqliteRun(dbPath, sql) {
  const out = execFileSync('sqlite3', ['-cmd', '.timeout 5000', '-json', dbPath, sql], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  return out === '' ? [] : JSON.parse(out);
}

// seedPassingVerificationRun writes the passing verification_runs row (plus one
// command row per verification[] entry, then one `[probe <id>] <probe_cmd>` row
// per non-wontfix review finding, GH 1737) that swe-verification-gate records
// when swe completes, so bro_atomic_close's verification gate (GH 1672) admits
// the close. Needs a startClient({ fileDb: true }) dbPath.
export function seedPassingVerificationRun(dbPath, taskId, commitSha) {
  const id = Number(taskId);
  const sha = String(commitSha).replace(/'/g, "''");
  execFileSync('sqlite3', ['-cmd', '.timeout 5000', dbPath,
    `INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out)
     VALUES (${id}, '${sha}', 'gate', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0, 900, 0);
     INSERT INTO verification_run_commands (run_id, ordinal, command, exit_code, elapsed_s, output_tail)
     SELECT (SELECT max(id) FROM verification_runs WHERE task_id = ${id}), ROW_NUMBER() OVER (ORDER BY grp, k), cmd, 0, 0, ''
       FROM (SELECT 0 AS grp, e.key AS k, e.value AS cmd FROM tasks t, json_each(t.verification) e WHERE t.id = ${id}
             UNION ALL
             SELECT 1, CAST(substr(f.id, instr(f.id, '-') + 1) AS INTEGER), '[probe ' || f.id || '] ' || f.probe_cmd
               FROM review_findings f WHERE f.task_id = ${id} AND f.status <> 'wontfix');`]);
}

// createProjectRepo builds the temp project a task_provision flow runs in: a git
// repo (main plus a dev branch) at <dir>/app. Pass env as startClient's extraEnv so the
// server's project root is <dir>, and registerRepo(dbPath) once the client is up
// (needs startClient({ fileDb: true })). cleanup() removes <dir> and every
// worktree provisioned under it.
export function createProjectRepo({ name = 'app', targetBranch = 'dev' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tmb-l4-project-'));
  const repoPath = path.join(dir, name);
  mkdirSync(repoPath, { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'config', 'user.email', 'l4@example.invalid');
  git(repoPath, 'config', 'user.name', 'l4');
  git(repoPath, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repoPath, 'README.md'), 'base\n');
  git(repoPath, 'add', '.');
  git(repoPath, 'commit', '-q', '-m', 'base');
  git(repoPath, 'branch', targetBranch);
  return {
    dir,
    name,
    repoPath,
    env: { CLAUDE_PROJECT_DIR: dir },
    git: (...args) => git(repoPath, ...args),
    gitIn: git,
    commitIn(worktreePath, file, content, message) {
      writeFileSync(path.join(worktreePath, file), content);
      git(worktreePath, 'add', file);
      git(worktreePath, 'commit', '-q', '-m', message);
      return git(worktreePath, 'rev-parse', 'HEAD');
    },
    registerRepo(dbPath) {
      execFileSync('sqlite3', ['-cmd', '.timeout 5000', dbPath,
        `INSERT INTO repos (name, path, target_branch) VALUES ('${name}', '${repoPath.replace(/'/g, "''")}', '${targetBranch}');`]);
    },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

// startProjectClient starts a file-DB server pointed at a fresh createProjectRepo
// project with its repo registered; close() stops the server and removes the
// project and the DB dir.
export async function startProjectClient() {
  const project = createProjectRepo();
  try {
    const started = await startClient({ extraEnv: project.env, fileDb: true });
    project.registerRepo(started.dbPath);
    return {
      ...started,
      project,
      async close() {
        try { await started.close(); } finally { project.cleanup(); }
      },
    };
  } catch (e) {
    project.cleanup();
    throw e;
  }
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
