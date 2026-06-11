// Flow 09 — Cold-restart after onboarding
//
// Human completes /onboard (any path). Server MUST persist the onboarded
// marker (plugin_config 'onboarded'='true'). On any subsequent cold session,
// onboard_state_get must return first_run=false so bro's first-action chain
// skips re-firing /onboard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, call } from '../l3-integration/mcp/harness.mjs';

test('Flow 09 — Cold-restart: onboard_apply marks first_run=false; marker persists', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  // Step 1: /onboard completes → onboard_apply marks the project onboarded.
  const apply = await call(client, 'onboard_apply', { agent: 'bro', shape: 'local' });
  assert.equal(apply.ok, true, `onboard_apply must succeed: ${JSON.stringify(apply)}`);
  assert.equal(apply.data.applied.onboarded, true);

  // Step 2: Simulate cold session — bro's first-action chain calls
  // onboard_state_get. first_run must be false so /onboard does not re-fire.
  const probe = await call(client, 'onboard_state_get', { agent: 'bro' });
  assert.equal(probe.ok, true);
  assert.equal(
    probe.data.first_run,
    false,
    'first_run MUST be false — this is the signal that prevents re-firing /onboard (issue #95)',
  );
});

test('Flow 09b — Bro forbidden from validation_record (issue #96 server enforcement)', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  // Set up onboarded marker + an issue + task so validation_record has a valid target
  await call(client, 'onboard_apply', { agent: 'bro', shape: 'local' });
  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'Verify role enforcement',
    description: 'Confirm validation_record rejects non-pr-reviewer callers.',
  });
  assert.equal(issue.ok, true);

  const task = await call(client, 'task_create_batch', {
    agent: 'bro',
    issue_id: issue.data.id,
    waive_scope_gate: true,
    waive_scope_gate_reason: 'test fixture',
    waive_branch_gate: true,
    waive_branch_gate_reason: 'workflow-sim test; branch gate not under test in this flow',
    waive_intent_gate: true,
    waive_intent_gate_reason: 'workflow-sim test; intent gate not under test in this flow',
    waive_decision_gate: true,
    waive_decision_gate_reason: 'workflow-sim test; triage gate not under test in this flow',
    tasks: [{
      branch_id: 'feat/role-test',
      title: 'role test',
      description: 'fixture',
      spec_body: '## Description\nfixture\n## Files\n- none\n## Success Criteria\n- none\n## Verification\n```\necho ok\n```',
    }],
  });
  assert.equal(task.ok, true);
  const taskId = Array.isArray(task.data) ? task.data[0]?.id : task.data.tasks?.[0]?.id;

  // The invariant: bro calling validation_record must be rejected
  const result = await call(client, 'validation_record', {
    agent: 'bro',
    task_id: taskId,
    attempt_n: 1,
    verdict: 'pass',
    feedback: 'attempted-bypass',
  });

  assert.equal(result.ok, false, 'validation_record must reject bro caller');
  assert.equal(result.error.error, 'forbidden');
  assert.equal(result.error.tool, 'validation_record');
  assert.equal(result.error.caller_role, 'bro');
  assert.deepEqual(result.error.allowed_roles, ['pr-reviewer']);

  // Confirm no validation row was written
  const history = await call(client, 'validation_history', { agent: 'bro', task_id: taskId });
  assert.equal(history.ok, true);
  assert.equal(history.data.length, 0, 'no validation row should have been recorded');
});

test('Flow 09c — Bro task-gate uses audit_log(bro_verification_pass), not validation_record (issue #91/#96)', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  await call(client, 'onboard_apply', { agent: 'bro', shape: 'local' });
  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'Verify bro_verification_pass audit event',
    description: 'Bro must record its task-gate verdict in audit, not in validation_attempts.',
  });
  const issueId = issue.data.id;

  const task = await call(client, 'task_create_batch', {
    agent: 'bro',
    issue_id: issueId,
    waive_scope_gate: true,
    waive_scope_gate_reason: 'test fixture',
    waive_branch_gate: true,
    waive_branch_gate_reason: 'workflow-sim test; branch gate not under test in this flow',
    waive_intent_gate: true,
    waive_intent_gate_reason: 'workflow-sim test; intent gate not under test in this flow',
    waive_decision_gate: true,
    waive_decision_gate_reason: 'workflow-sim test; triage gate not under test in this flow',
    tasks: [{
      branch_id: 'feat/audit-event-test',
      title: 'audit event test',
      description: 'fixture',
      spec_body: '## Description\nfixture\n## Files\n- none\n## Success Criteria\n- none\n## Verification\n```\necho ok\n```',
    }],
  });
  const createdTask = Array.isArray(task.data) ? task.data[0] : task.data.tasks?.[0];
  const taskId = createdTask.id;
  const branchId = createdTask.branch_id;

  // SWE finishes the work first — bro can only close verified ('completed')
  // work, never jump a pending task straight to closed (#278).
  await call(client, 'task_update_status', {
    agent: 'swe', task_id: taskId, status: 'completed', commit_sha: 'abc1234',
  });

  // Bro's correct task-gate close sequence
  const verifEvent = await call(client, 'audit_log', {
    agent: 'bro',
    issue_id: issueId,
    branch_id: branchId,
    from_node: 'bro',
    event_type: 'bro_verification_pass',
    summary: 'V1 files match. V2 verification commands passed. V3 success criteria met.',
  });
  assert.equal(verifEvent.ok, true);

  const closed = await call(client, 'task_update_status', {
    agent: 'bro',
    task_id: taskId,
    status: 'closed',
    commit_sha: 'abc1234',
  });
  assert.equal(closed.ok, true);

  // Verify the audit table has the bro_verification_pass event
  const audit = await call(client, 'audit_log_list', { agent: 'bro', issue_id: issueId });
  const verifEvents = audit.data.filter(e => e.event_type === 'bro_verification_pass');
  assert.equal(verifEvents.length, 1, 'exactly one bro_verification_pass event recorded');
  assert.equal(verifEvents[0].from_node, 'bro');

  // Verify NO validation_attempts row exists (bro must not write to that table)
  const history = await call(client, 'validation_history', { agent: 'bro', task_id: taskId });
  assert.equal(history.data.length, 0, 'bro must never write to validation_attempts');
});
