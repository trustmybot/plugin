// Flow 2 — Simple Task (FLOWS.md §2)
//
// Trajectory: bro triages simple → issue_create → discussion (intent + triage) →
// task_provision (decision + task + branch + worktree + planning_complete) →
// SWE starts with task_brief, commits in the worktree, returns
// (task_update_status='completed') → bro verifies (no validation row at task close;
// code-reviewer fires only at push gate) → bro_atomic_close → issue_close.
//
// Asserts the structural contract: state transitions, audit events, role
// enforcement at each call, and the branch + worktree task_provision leaves on
// disk. Direct-runs the MCP server against a temp git repo, no Claude.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startProjectClient, call, seedPassingVerificationRun } from '../l3-integration/mcp/harness.mjs';

test('Flow 2 — simple task: bro provisions → swe briefs, commits, completes → bro closes (no per-task code-reviewer)', async (t) => {
  const { client, close, dbPath, project } = await startProjectClient();
  t.after(async () => { await close(); });

  // 1. bro creates issue
  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'Add /hello endpoint',
    description: 'Single-file route, no architecture impact.',
    labels: ['Feature', 'Priority: Medium'],
  });
  assert.equal(issue.ok, true, `issue_create: ${JSON.stringify(issue)}`);
  const issueId = issue.data.id;

  // 2. bro logs intent + triage discussion
  const intent = await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, author: 'human', kind: 'intent',
    body: '@bro add /hello endpoint', verified_human: true,
  });
  assert.equal(intent.ok, true);

  const triage = await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, author: 'bro', kind: 'note',
    body: 'Triage: simple — single file, defaults applied.',
  });
  assert.equal(triage.ok, true);

  // 3. bro plans with task_provision: decision + task + branch + worktree in one call
  const provisioned = await call(client, 'task_provision', {
    agent: 'bro',
    issue_id: issueId,
    branch_id: 'feat/hello',
    decision_body: 'Chosen approach: one route file wired to 200 OK {msg:"hello"}; no architecture impact.',
    task: {
      title: 'Add /hello endpoint',
      description: 'Wire /hello → 200 OK {msg:"hello"}.',
      spec_body: '## Success Criteria\n- SC1: 200 OK',
      files: ['hello.txt'],
      verification: ['test -f hello.txt'],
      repo: project.name,
    },
  });
  assert.equal(provisioned.ok, true, `task_provision: ${JSON.stringify(provisioned)}`);
  const taskId = provisioned.data.task_id;
  assert.ok(taskId, `no task id returned: ${JSON.stringify(provisioned.data)}`);
  assert.equal(provisioned.data.git_setup, 'created');
  const worktreePath = provisioned.data.worktree_path;
  assert.ok(existsSync(worktreePath), `worktree missing on disk: ${worktreePath}`);
  assert.equal(project.git('rev-parse', '--verify', 'refs/heads/feat/hello').length, 40, 'branch ref feat/hello exists');
  assert.match(project.git('worktree', 'list', '--porcelain'), /branch refs\/heads\/feat\/hello/);

  // 4. SWE picks up the task: task_brief returns the spec
  const brief = await call(client, 'task_brief', { agent: 'swe', task_id: taskId });
  assert.equal(brief.ok, true, `task_brief: ${JSON.stringify(brief)}`);
  assert.match(JSON.stringify(brief.data), /Success Criteria/);

  // 5. SWE commits in the worktree and completes with that commit_sha
  const sha = project.commitIn(worktreePath, 'hello.txt', 'hello\n', 'feat: add /hello');
  const completed = await call(client, 'task_update_status', {
    agent: 'swe', task_id: taskId, status: 'completed', commit_sha: sha, report: { criteria: [{ id: 'SC1', status: 'met' }] },
  });
  assert.equal(completed.ok, true, `swe→completed: ${JSON.stringify(completed)}`);
  seedPassingVerificationRun(dbPath, taskId, sha);

  // 6. CRITICAL: bro's task gate — verifies and closes (no code-reviewer at this point).
  // code-reviewer is the PUSH gate, not the task gate. validation_attempts stays empty
  // until the push gate fires (Flow 6).
  const preCloseValidations = await call(client, 'validation_history', {
    agent: 'bro', task_id: taskId,
  });
  assert.equal(preCloseValidations.ok, true);
  assert.equal(preCloseValidations.data.length, 0,
    'simple-task close must NOT spawn code-reviewer (push gate is amortized)');

  const closed = await call(client, 'bro_atomic_close', {
    agent: 'bro', task_id: taskId,
    commit_sha: sha,
    verification_summary: 'V1 files match. V2 verification commands passed. V3 success criteria met.',
    close_issue_if_last_task: true,
    waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test',
  });
  assert.equal(closed.ok, true, `bro_atomic_close: ${JSON.stringify(closed)}`);

  // 7. bro closes the issue. code-reviewer runs at the push gate, not per task, so
  // the closed task has no verdict yet: the close carries an explicit review waiver.
  const issueClosed = await call(client, 'issue_close', {
    agent: 'bro', issue_id: issueId,
    waive_review: true,
    waive_review_reason: 'simple task: code-reviewer runs at the push gate, not at task close',
  });
  assert.equal(issueClosed.ok, true, JSON.stringify(issueClosed));

  // 8. Final state: issue closed, task closed with commit_sha, no validation rows yet
  const finalIssue = await call(client, 'issue_get', { agent: 'bro', issue_id: issueId });
  assert.equal(finalIssue.data.status, 'closed');

  const finalTask = await call(client, 'task_get', { agent: 'bro', task_id: taskId });
  assert.equal(finalTask.data.status, 'closed');
  assert.equal(finalTask.data.commit_sha, sha);

  // audit event recorded
  const audit = await call(client, 'audit_list', { agent: 'bro', issue_id: issueId });
  assert.equal(audit.ok, true);
  assert.ok(audit.data.some(e => e.event_type === 'planning_complete'),
    'planning_complete event must land in audit');
  const waived = audit.data.filter(e => e.event_type === 'review_gate_waived');
  assert.equal(waived.length, 1, 'one review_gate_waived row for the unreviewed task');
  assert.equal(waived[0].from_node, 'bro');
});
