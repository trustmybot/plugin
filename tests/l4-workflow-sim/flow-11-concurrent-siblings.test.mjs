// Flow 11 — Concurrent sibling tasks (task_provision x2 on one issue)
//
// Trajectory: bro provisions two sibling branches for one issue → both tasks are
// pending with distinct branches and live worktrees → one sibling closes through
// bro_atomic_close → the other stays pending with its worktree intact and the
// issue stays open behind it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startClient, call } from '../l3-integration/mcp/harness.mjs';

const SPEC = ['## Description', 'do the thing', '', '## Success Criteria', '- works'].join('\n');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function makeProject() {
  const ws = mkdtempSync(join(tmpdir(), 'tmb-l4-flow11-'));
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

test('Flow 11 — sibling tasks: distinct branches and worktrees; closing one leaves the other pending', async (t) => {
  const project = makeProject();
  const restoreEnv = pinEnv({ HOME: project.home, CLAUDE_PROJECT_DIR: project.ws, TMB_DISABLE_REMOTE_SYNC: '1' });
  const { client, close, dbPath } = await startClient({ fileDb: true });
  t.after(async () => {
    await close();
    restoreEnv();
    rmSync(project.ws, { recursive: true, force: true });
  });
  registerRepo(dbPath, 'app', project.repo);

  const issue = await call(client, 'issue_create', {
    agent: 'bro', objective: 'Two siblings on one issue', description: 'Concurrent sibling tasks.',
    labels: ['Feature', 'Priority: Medium'], repo: 'app',
  });
  assert.equal(issue.ok, true, `issue_create: ${JSON.stringify(issue)}`);
  const issueId = issue.data.id;

  const provision = (branch_id) => call(client, 'task_provision', {
    agent: 'bro', issue_id: issueId, branch_id,
    decision_body: `Chosen approach: ${branch_id} as one of two independent siblings; no shared files.`,
    task: { title: branch_id, description: 'd', spec_body: SPEC, files: ['src/'], verification: ['true'], repo: 'app' },
  });
  const a = await provision('feat/sibling-a');
  const b = await provision('feat/sibling-b');
  assert.equal(a.ok, true, `provision a: ${JSON.stringify(a)}`);
  assert.equal(b.ok, true, `provision b: ${JSON.stringify(b)}`);

  assert.notEqual(a.data.task_id, b.data.task_id);
  assert.notEqual(a.data.branch_id, b.data.branch_id);
  assert.notEqual(a.data.worktree_path, b.data.worktree_path);
  for (const out of [a.data, b.data]) {
    assert.equal(git(project.repo, 'rev-parse', '--verify', `refs/heads/${out.branch_id}`).length, 40);
    assert.equal(existsSync(out.worktree_path), true, `worktree ${out.worktree_path}`);
    const brief = await call(client, 'task_brief', { agent: 'bro', task_id: out.task_id });
    assert.equal(brief.ok, true, `task_brief: ${JSON.stringify(brief)}`);
    assert.equal(brief.data.status, 'pending');
  }

  const swe = await call(client, 'task_update_status', {
    agent: 'swe', task_id: a.data.task_id, status: 'completed', commit_sha: project.sha,
  });
  assert.equal(swe.ok, true, `swe completes a: ${JSON.stringify(swe)}`);
  const closed = await call(client, 'bro_atomic_close', {
    agent: 'bro', task_id: a.data.task_id, commit_sha: project.sha,
    verification_summary: 'V1 verified; closing sibling a.',
    close_issue_if_last_task: true,
    waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test',
  });
  assert.equal(closed.ok, true, `bro_atomic_close: ${JSON.stringify(closed)}`);

  const status = async (id) => (await call(client, 'task_brief', { agent: 'bro', task_id: id })).data.status;
  assert.equal(await status(a.data.task_id), 'closed');
  assert.equal(await status(b.data.task_id), 'pending', 'sibling b untouched by closing a');
  assert.equal(existsSync(b.data.worktree_path), true, 'sibling b worktree intact');
  assert.match(git(project.repo, 'worktree', 'list', '--porcelain'), /sibling-b/);

  const issueAfter = await call(client, 'issue_get', { agent: 'bro', issue_id: String(issueId) });
  assert.equal(issueAfter.ok, true, JSON.stringify(issueAfter));
  assert.notEqual(issueAfter.data.status, 'closed', 'issue stays open behind the live sibling');
});
