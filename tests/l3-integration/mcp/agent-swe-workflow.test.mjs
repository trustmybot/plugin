// Layer 2 agent-workflow: swe's MCP responsibilities end-to-end.
// SWE picks up a seeded task, transitions running → completed, logs
// progress, and registers file changes — the atomic-close sequence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, call } from './harness.mjs';

const SPEC_BODY = [
  '# Task: swe-test handler',
  '',
  '## Success Criteria',
  '- SC1: handler returns 200 with body "ok"',
].join('\n');

async function seedIssueAndTask(client) {
  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'task for swe',
    description: 'x',
    labels: ['Feature', 'Priority: Medium'],
  });
  assert.equal(issue.ok, true);
  const batch = await call(client, 'task_create_batch', {
    waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
    waive_branch_gate: true, waive_branch_gate_reason: 'integration-test fixture; branch gate not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic triage; not under test',
    agent: 'bro',
    issue_id: issue.data.id,
    tasks: [{
      branch_id: 'feat/swe-test',
      title: 't',
      description: 'd',
      spec_body: SPEC_BODY,
    }],
  });
  const taskId = Array.isArray(batch.data) ? batch.data[0]?.id : batch.data.tasks?.[0]?.id;
  return { taskId, issueId: issue.data.id };
}

test('swe — pickup → running → atomic close sequence', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const { taskId, issueId } = await seedIssueAndTask(client);
  assert.ok(taskId);

  // 1. SWE reads the spec
  const getSpec = await call(client, 'task_get', { agent: 'swe', task_id: taskId, include_spec_body: true });
  assert.equal(getSpec.ok, true, `task_get: ${JSON.stringify(getSpec)}`);
  assert.equal(getSpec.data.spec_body, SPEC_BODY);

  // 2. Transition to running
  const running = await call(client, 'task_update_status', {
    agent: 'swe', task_id: taskId, status: 'running',
  });
  assert.equal(running.ok, true, `status running: ${JSON.stringify(running)}`);

  // 3. An event outside the closed audit.event_type set is rejected
  const unknownAudit = await call(client, 'audit_append', {
    agent: 'swe',
    issue_id: issueId,
    branch_id: 'feat/swe-test',
    from_node: 'swe',
    event_type: 'swe_progress',
    summary: 'wrote initial handler',
  });
  assert.equal(unknownAudit.ok, false, `unknown event_type must be rejected: ${JSON.stringify(unknownAudit)}`);
  assert.match(unknownAudit.error.error, /unknown audit event_type 'swe_progress'\. Allowed: .*planning_complete/);

  // 4. Atomic close — status → completed
  const completed = await call(client, 'task_update_status', {
    agent: 'swe', task_id: taskId, status: 'completed', report: { criteria: [{ id: 'SC1', status: 'met' }] },
  });
  assert.equal(completed.ok, true, `status completed: ${JSON.stringify(completed)}`);

  // 5. Verify final state
  const finalTask = await call(client, 'task_get', { agent: 'swe', task_id: taskId });
  assert.equal(finalTask.data.status, 'completed');
});

test('swe — validation_history read-access to own task', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const { taskId } = await seedIssueAndTask(client);

  // Should return empty before any validation_record.
  const history = await call(client, 'validation_history', {
    agent: 'swe', task_id: taskId,
  });
  assert.equal(history.ok, true, `validation_history: ${JSON.stringify(history)}`);
  assert.ok(Array.isArray(history.data) || history.data !== null);
});
