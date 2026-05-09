// Flow 09 — Cold-restart after Anonymous onboarding (regression for issue #95)
//
// Trajectory: Human chooses "Anonymous" during first-run onboarding. Server
// MUST persist a row with human_name=NULL (not skip the write). On any
// subsequent cold session, identity_get must return created_at != null so
// bro's first-action chain skips re-onboarding.
//
// Pre-fix bug (v0.3.x): the onboarding skill said "skip identity_set if
// Anonymous", so no row was ever written. Cold restart found
// identity_get().created_at == null → re-triggered full onboarding every time.
//
// Post-fix (v0.4.1): identity_set(anonymous=true) writes a row with
// human_name=NULL. created_at populates. Cold restart sees the row → skips
// re-onboarding. The Anonymous choice is now durable.
//
// Also asserts the related #96 invariant: bro calling validation_record gets
// rejected with 'forbidden' (must use audit_log(kind='event', event_type='bro_verification_pass')
// instead).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, call } from '../mcp-integration/harness.mjs';

test('Flow 09 — Anonymous cold-restart: identity_set(anonymous=true) persists; created_at non-null', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  // Step 1: First-run onboarding — Human picks Anonymous
  const setResult = await call(client, 'identity_set', { agent: 'bro', anonymous: true });
  assert.equal(setResult.ok, true, 'identity_set(anonymous=true) must succeed');
  assert.equal(setResult.data.human_name, null);
  assert.ok(setResult.data.created_at, 'created_at must be set after Anonymous onboarding');

  // Step 2: Simulate cold session — bro's first-action chain calls identity_get
  const probe = await call(client, 'identity_get', {});
  assert.equal(probe.ok, true);
  assert.equal(probe.data.human_name, null, 'human_name stays null for Anonymous');
  assert.ok(
    probe.data.created_at,
    'created_at MUST be non-null — this is the "onboarded" signal that prevents re-onboarding (issue #95)',
  );
});

test('Flow 09b — Bro forbidden from validation_record (issue #96 server enforcement)', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  // Set up identity + an issue + task so validation_record has a valid target
  await call(client, 'identity_set', { agent: 'bro', human_name: 'Test' });
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
    tasks: [{
      branch_id: 'feat/role-test',
      title: 'role test',
      description: 'fixture',
      success_criteria: 'fixture',
      spec_body: '## Description\nfixture\n## Files\n- none\n## Success Criteria\n- none\n## Verification\n```\necho ok\n```',
    }],
  });
  assert.equal(task.ok, true);
  const taskId = task.data[0].id;

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

  await call(client, 'identity_set', { agent: 'bro', human_name: 'Test' });
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
    tasks: [{
      branch_id: 'feat/audit-event-test',
      title: 'audit event test',
      description: 'fixture',
      success_criteria: 'fixture',
      spec_body: '## Description\nfixture',
    }],
  });
  const taskId = task.data[0].id;
  const branchId = task.data[0].branch_id;

  // Bro's correct task-gate close sequence
  const verifEvent = await call(client, 'audit_log', {
    agent: 'bro',
    issue_id: issueId,
    branch_id: branchId,
    from_node: 'bro',
    kind: 'event',
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
  const audit = await call(client, 'audit_log_list', { agent: 'bro', issue_id: issueId, kind: 'event' });
  const verifEvents = audit.data.filter(e => e.event_type === 'bro_verification_pass');
  assert.equal(verifEvents.length, 1, 'exactly one bro_verification_pass event recorded');
  assert.equal(verifEvents[0].from_node, 'bro');

  // Verify NO validation_attempts row exists (bro must not write to that table)
  const history = await call(client, 'validation_history', { agent: 'bro', task_id: taskId });
  assert.equal(history.data.length, 0, 'bro must never write to validation_attempts');
});
