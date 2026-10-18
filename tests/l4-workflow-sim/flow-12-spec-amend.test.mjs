// Flow 12 — Spec amend (task_update_spec on a live task)
//
// Trajectory: bro provisions a task → amends its spec_body, files and
// verification mid-task with task_update_spec → the stored spec changed, a
// decision discussion and a task_spec_amended audit row carry the reason → once
// the task is closed the amend is refused and nothing moves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startClient, call } from '../l3-integration/mcp/harness.mjs';

const SPEC = ['## Description', 'do the thing', '', '## Success Criteria', '- works'].join('\n');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function makeProject() {
  const ws = mkdtempSync(join(tmpdir(), 'tmb-l4-flow12-'));
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

const AMENDED_SPEC = ['## Description', 'do the thing, narrower', '', '## Success Criteria', '- works', '- edge case handled'].join('\n');

test('Flow 12 — task_update_spec amends a live task and audits it; refused once closed', async (t) => {
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

  const issue = await call(client, 'issue_create', {
    agent: 'bro', objective: 'Amend a spec mid-task', description: 'task_update_spec flow.',
    labels: ['Feature', 'Priority: Medium'], repo: 'app',
  });
  assert.equal(issue.ok, true, `issue_create: ${JSON.stringify(issue)}`);
  const issueId = issue.data.id;

  const provisioned = await call(client, 'task_provision', {
    agent: 'bro', issue_id: issueId, branch_id: 'feat/amend-me',
    decision_body: 'Chosen approach: provision first, amend once the edge case surfaces.',
    task: { title: 'amend me', description: 'd', spec_body: SPEC, files: ['src/'], verification: ['true'], repo: 'app' },
  });
  assert.equal(provisioned.ok, true, `task_provision: ${JSON.stringify(provisioned)}`);
  const taskId = provisioned.data.task_id;
  const specOf = () => sql(`SELECT spec_body, files, verification FROM tasks WHERE id = ${taskId}`)[0];
  assert.equal(specOf().spec_body, SPEC);

  const amend = await call(client, 'task_update_spec', {
    agent: 'bro', task_id: taskId, reason: 'the edge case surfaced after provisioning',
    spec_body: AMENDED_SPEC, files: ['src/', 'docs/'], verification: ['true', 'echo ok'],
  });
  assert.equal(amend.ok, true, `task_update_spec: ${JSON.stringify(amend)}`);
  assert.deepEqual([...amend.data.changed].sort(), ['files', 'spec_body', 'verification']);

  const stored = specOf();
  assert.equal(stored.spec_body, AMENDED_SPEC);
  assert.deepEqual(JSON.parse(stored.files), ['src/', 'docs/']);
  assert.deepEqual(JSON.parse(stored.verification), ['true', 'echo ok']);

  const decisions = sql(`SELECT author, body FROM discussions WHERE issue_id = ${issueId} AND kind = 'decision' AND body LIKE '%spec amended%'`);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].author, 'bro');
  assert.match(decisions[0].body, /the edge case surfaced after provisioning/);

  const audits = sql(`SELECT from_node, content_json FROM audit WHERE event_type = 'task_spec_amended' AND issue_id = ${issueId}`);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].from_node, 'bro');
  const payload = JSON.parse(audits[0].content_json);
  assert.equal(payload.task_id, taskId);
  assert.equal(payload.reason, 'the edge case surfaced after provisioning');

  const swe = await call(client, 'task_update_status', { agent: 'swe', task_id: taskId, status: 'completed', commit_sha: project.sha });
  assert.equal(swe.ok, true, `swe completes: ${JSON.stringify(swe)}`);
  const closed = await call(client, 'bro_atomic_close', {
    agent: 'bro', task_id: taskId, commit_sha: project.sha, verification_summary: 'V1 verified; closing.',
    waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test',
  });
  assert.equal(closed.ok, true, `bro_atomic_close: ${JSON.stringify(closed)}`);

  const refused = await call(client, 'task_update_spec', {
    agent: 'bro', task_id: taskId, reason: 'late amend on a closed task', spec_body: SPEC,
  });
  assert.equal(refused.ok, false);
  assert.match(JSON.stringify(refused), /closed/);
  assert.equal(specOf().spec_body, AMENDED_SPEC, 'refused amend leaves the spec untouched');
  assert.equal(sql(`SELECT COUNT(*) AS c FROM audit WHERE event_type = 'task_spec_amended'`)[0].c, 1, 'refused amend writes no audit row');
});
