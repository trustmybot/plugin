// Flow 2 — Simple Task (FLOWS.md §2)
//
// Trajectory: bro triages simple → issue_create → discussion (intent + triage) →
// task_create_batch + audit_append(planning_complete) → SWE returns
// (task_update_status='completed') → bro verifies (no validation row at task close;
// pr-reviewer fires only at push gate) → bro flips task to 'closed' → issue_close.
//
// Asserts the structural contract: state transitions, audit events, role
// enforcement at each call. Direct-runs the MCP server, no Claude.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, call } from '../l3-integration/mcp/harness.mjs';

test('Flow 2 — simple task: bro plans → swe completes → bro closes (no per-task pr-reviewer)', async (t) => {
  const { client, close } = await startClient();
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

  // 3. bro authors task spec + emits planning_complete
  const batch = await call(client, 'task_create_batch', {
    agent: 'bro',
    issue_id: issueId,
    waive_scope_gate: true,
    waive_scope_gate_reason: 'simple-triage personal endpoint; defaults named in triage note (single file, stdlib router)',
    waive_branch_gate: true,
    waive_branch_gate_reason: 'workflow-sim test; branch gate not under test in this flow',
    waive_intent_gate: true,
    waive_intent_gate_reason: 'workflow-sim test; intent gate not under test in this flow',
    waive_decision_gate: true,
    waive_decision_gate_reason: 'workflow-sim test; triage gate not under test in this flow',
    tasks: [{
      branch_id: 'feat/hello',
      title: 'Add /hello endpoint',
      description: 'Wire /hello → 200 OK {msg:"hello"}.',
      spec_body: '## Success Criteria\n- 200 OK',
    }],
  });
  assert.equal(batch.ok, true, `task_create_batch: ${JSON.stringify(batch)}`);
  // batch.data may be an array of created tasks OR {tasks: [...]} depending on API revision
  const taskId = Array.isArray(batch.data) ? batch.data[0]?.id : batch.data.tasks?.[0]?.id;
  assert.ok(taskId, `no task id returned: ${JSON.stringify(batch.data)}`);

  const planning = await call(client, 'audit_append', {
    agent: 'bro', issue_id: issueId, branch_id: 'feat/hello',
    from_node: 'bro',
    event_type: 'planning_complete', summary: 'Triage simple. Spec authored for task_id=' + taskId,
  });
  assert.equal(planning.ok, true, `audit_append: ${JSON.stringify(planning)}`);

  // 4. SWE picks up the task: read spec → mark running
  const taskRead = await call(client, 'task_get', { agent: 'swe', task_id: taskId, include_spec_body: true });
  assert.equal(taskRead.ok, true);
  assert.match(taskRead.data.spec_body, /Success Criteria/);

  const running = await call(client, 'task_update_status', {
    agent: 'swe', task_id: taskId, status: 'running',
  });
  assert.equal(running.ok, true);

  // 5. SWE completes with commit_sha
  const completed = await call(client, 'task_update_status', {
    agent: 'swe', task_id: taskId, status: 'completed',
    commit_sha: 'aaaaaaa1111111111111111111111111111aaaaa',
  });
  assert.equal(completed.ok, true, `swe→completed: ${JSON.stringify(completed)}`);

  // 6. CRITICAL: bro's task gate — verifies and closes (no pr-reviewer at this point).
  // PR-reviewer is the PUSH gate, not the task gate. validation_attempts stays empty
  // until the push gate fires (Flow 6).
  const preCloseValidations = await call(client, 'validation_history', {
    agent: 'bro', task_id: taskId,
  });
  assert.equal(preCloseValidations.ok, true);
  assert.equal(preCloseValidations.data.length, 0,
    'simple-task close must NOT spawn pr-reviewer (push gate is amortized)');

  const closed = await call(client, 'task_update_status', {
    agent: 'bro', task_id: taskId, status: 'closed',
  });
  assert.equal(closed.ok, true);

  // 7. bro closes the issue
  const issueClosed = await call(client, 'issue_close', {
    agent: 'bro', issue_id: issueId,
  });
  assert.equal(issueClosed.ok, true);

  // 8. Final state: issue closed, task closed with commit_sha, no validation rows yet
  const finalIssue = await call(client, 'issue_get', { agent: 'bro', issue_id: issueId });
  assert.equal(finalIssue.data.status, 'closed');

  const finalTask = await call(client, 'task_get', { agent: 'bro', task_id: taskId });
  assert.equal(finalTask.data.status, 'closed');
  assert.equal(finalTask.data.commit_sha, 'aaaaaaa1111111111111111111111111111aaaaa');

  // audit event recorded
  const audit = await call(client, 'audit_list', { agent: 'bro', issue_id: issueId });
  assert.equal(audit.ok, true);
  assert.ok(audit.data.some(e => e.event_type === 'planning_complete'),
    'planning_complete event must land in audit');
});
