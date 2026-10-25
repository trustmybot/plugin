// Flow 14 — repo_rename (refused while a task worktree is live, applied after close)
//
// Trajectory: bro provisions a task under repo "app" → repo_rename is refused with
// rename_in_progress and names the blocking task → the task closes → repo_rename
// succeeds, the repos row and every child row (issues, tasks, audit) carry the
// new name, and a repo_renamed audit row records the move.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startClient, call, seedPassingVerificationRun } from '../l3-integration/mcp/harness.mjs';

const SPEC = ['## Description', 'do the thing', '', '## Success Criteria', '- SC1: works'].join('\n');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function makeProject() {
  const ws = mkdtempSync(join(tmpdir(), 'tmb-l4-flow14-'));
  const home = join(ws, 'home');
  const repo = join(ws, 'app');
  mkdirSync(home);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'branch', 'dev');
  return { ws, home, repo, sha: git(repo, 'rev-parse', 'HEAD') };
}

function pinEnv(vars) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function registerRepo(dbPath, name, path) {
  execFileSync('sqlite3', ['-cmd', '.timeout 5000', dbPath,
    `INSERT INTO repos (name, path, target_branch) VALUES ('${name}', '${path}', 'dev');`]);
}

test('Flow 14 — repo_rename: rename_in_progress while a worktree is live, applied after close', async (t) => {
  const project = makeProject();
  const restoreEnv = pinEnv({ HOME: project.home, CLAUDE_PROJECT_DIR: project.ws, TMB_DISABLE_REMOTE_SYNC: '1' });
  const { client, close, dbPath } = await startClient({ fileDb: true });
  t.after(async () => {
    await close();
    restoreEnv();
    rmSync(project.ws, { recursive: true, force: true });
  });
  registerRepo(dbPath, 'app', project.repo);
  const sql = (query) => JSON.parse(execFileSync('sqlite3', ['-json', dbPath, query]).toString() || '[]');
  const count = (query) => sql(query)[0].c;

  const issue = await call(client, 'issue_create', {
    agent: 'bro', objective: 'Rename the repo', description: 'repo_rename flow.',
    labels: ['Feature', 'Priority: Medium'], repo: 'app',
  });
  assert.equal(issue.ok, true, `issue_create: ${JSON.stringify(issue)}`);
  const provisioned = await call(client, 'task_provision', {
    agent: 'bro', issue_id: issue.data.id, branch_id: 'feat/before-rename',
    decision_body: 'Chosen approach: provision under the old name, rename once the task closes.',
    task: { title: 'before rename', description: 'd', spec_body: SPEC, files: ['src/'], verification: ['true'], repo: 'app' },
  });
  assert.equal(provisioned.ok, true, `task_provision: ${JSON.stringify(provisioned)}`);
  const taskId = provisioned.data.task_id;

  const refused = await call(client, 'repo_rename', { agent: 'bro', old: 'app', new: 'service', reason: 'naming cleanup' });
  assert.equal(refused.ok, false);
  const refusal = refused.error;
  assert.equal(refusal.error, 'rename_in_progress');
  assert.deepEqual(refusal.blocking_tasks.map((b) => b.id), [taskId]);
  assert.equal(count(`SELECT COUNT(*) AS c FROM repos WHERE name = 'app'`), 1, 'refused rename leaves the repo');
  assert.equal(count(`SELECT COUNT(*) AS c FROM audit WHERE event_type = 'repo_renamed'`), 0);

  const swe = await call(client, 'task_update_status', { agent: 'swe', task_id: taskId, status: 'completed', commit_sha: project.sha, report: { criteria: [{ id: 'SC1', status: 'met' }] } });
  assert.equal(swe.ok, true, `swe completes: ${JSON.stringify(swe)}`);
  seedPassingVerificationRun(dbPath, taskId, project.sha);
  const closed = await call(client, 'bro_atomic_close', {
    agent: 'bro', task_id: taskId, commit_sha: project.sha, verification_summary: 'V1 verified; closing.',
    waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test',
  });
  assert.equal(closed.ok, true, `bro_atomic_close: ${JSON.stringify(closed)}`);

  const renamed = await call(client, 'repo_rename', { agent: 'bro', old: 'app', new: 'service', reason: 'naming cleanup' });
  assert.equal(renamed.ok, true, `repo_rename: ${JSON.stringify(renamed)}`);
  assert.equal(renamed.data.renamed, true);
  assert.equal(renamed.data.new, 'service');

  assert.equal(count(`SELECT COUNT(*) AS c FROM repos WHERE name = 'app'`), 0);
  assert.equal(count(`SELECT COUNT(*) AS c FROM repos WHERE name = 'service'`), 1);
  for (const table of ['issues', 'tasks', 'audit']) {
    assert.equal(count(`SELECT COUNT(*) AS c FROM ${table} WHERE repo = 'app'`), 0, `${table} rows under the old name`);
    assert.ok(count(`SELECT COUNT(*) AS c FROM ${table} WHERE repo = 'service'`) > 0, `${table} rows under the new name`);
  }
  const audit = sql(`SELECT from_node, repo, content_json FROM audit WHERE event_type = 'repo_renamed'`);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].repo, 'service');
  const payload = JSON.parse(audit[0].content_json);
  assert.deepEqual({ old: payload.old, new: payload.new, reason: payload.reason }, { old: 'app', new: 'service', reason: 'naming cleanup' });
});
