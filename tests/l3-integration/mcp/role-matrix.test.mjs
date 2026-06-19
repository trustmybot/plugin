import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, call } from './harness.mjs';

// Role matrix coverage for tools that currently wrap handlers with `requireRoles`.
// Tools without requireRoles (task_*, validation_*, issue_*, audit_*, audit_*,
// skill_*) accept any caller — that's tracked as a protection gap (see issue
// filed alongside this test file). When requireRoles is added there, add tests
// to this file covering them.

test('onboard_apply — bro allowed, others forbidden, missing agent forbidden', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const missing = await call(client, 'onboard_apply', { shape: 'local' });
  assert.equal(missing.ok, false, 'call without agent must fail');
  assert.equal(missing.error?.error, 'forbidden');
  assert.equal(missing.error?.caller_role, 'unknown');

  // Architect normalizes to 'consultant' role; first-class roles keep their literal name.
  const expectedRole = (n) => (n === 'architect' ? 'consultant' : n);
  for (const wrongRole of ['architect', 'swe', 'pr-reviewer']) {
    const res = await call(client, 'onboard_apply', { agent: wrongRole, shape: 'local' });
    assert.equal(res.ok, false, `${wrongRole} must be forbidden from onboard_apply`);
    assert.equal(res.error?.error, 'forbidden');
    assert.equal(res.error?.caller_role, expectedRole(wrongRole));
  }

  const allowed = await call(client, 'onboard_apply', { agent: 'bro', shape: 'local' });
  assert.equal(allowed.ok, true, `bro should be allowed; got ${JSON.stringify(allowed)}`);
  assert.equal(allowed.data?.applied?.onboarded, true);
});

test('config_set — bro only; architect/swe/pr-reviewer all forbidden', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const allowed = await call(client, 'config_set', {
    agent: 'bro',
    key: 'smoke_bro',
    value: 'ok',
  });
  assert.equal(allowed.ok, true, `bro should set config; got ${JSON.stringify(allowed)}`);

  for (const wrongRole of ['architect', 'swe', 'pr-reviewer']) {
    const res = await call(client, 'config_set', {
      agent: wrongRole,
      key: 'smoke',
      value: 'x',
    });
    assert.equal(res.ok, false, `${wrongRole} must be forbidden from config_set`);
    assert.equal(res.error?.error, 'forbidden');
  }
});

test('issue_snapshot_md — bro & pr-reviewer only; consultants forbidden', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  // Seed an issue so the handler has something to snapshot.
  const seed = await call(client, 'issue_create', { agent: 'bro', objective: 'x', description: 'y', labels: ['Feature', 'Priority: Medium'] });
  assert.equal(seed.ok, true, `seed issue: ${JSON.stringify(seed)}`);
  const issueId = seed.data.id;

  // Architect (now consultant role under the new doctrine) is dropped from the
  // requireRoles list; only bro + pr-reviewer can call this report tool.
  for (const wrongRole of ['swe', 'architect', 'cto']) {
    const res = await call(client, 'issue_snapshot_md', { agent: wrongRole, issue_id: issueId });
    assert.equal(res.ok, false, `${wrongRole} must be forbidden`);
    assert.equal(res.error?.error, 'forbidden');
  }
});

test('discussion_append — workflow agents (bro/architect) can append questions; swe scope-restricted', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  // Seed: architect creates an issue.
  const issue = await call(client, 'issue_create', { agent: 'bro', objective: 'x', description: 'y', labels: ['Feature', 'Priority: Medium'] });
  assert.equal(issue.ok, true, `seed: ${JSON.stringify(issue)}`);
  const issueId = issue.data.id;

  for (const role of ['architect', 'bro']) {
    const res = await call(client, 'discussion_append', {
      agent: role,
      issue_id: issueId,
      kind: 'note',
      author: role,
      body: `${role} testing discussion append`,
    });
    assert.equal(res.ok, true, `${role} should append; got ${JSON.stringify(res)}`);
  }
});

// Legacy scan-side drift-cache + standalone arch-refresh MCP tools were
// retired 2026-05 (#2881 follow-up); scan_run is the single scan-side
// surface now. Tests for the retired tools were removed with them.

// --- bro-as-planner role contract (Human → bro → SWE; everyone else consults) ---

test('issue_create — bro only; architect/swe/pr-reviewer all forbidden', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const ok = await call(client, 'issue_create', { agent: 'bro', objective: 'planner test', description: 'd', labels: ['Feature', 'Priority: Medium'] });
  assert.equal(ok.ok, true, `bro should create issue; got ${JSON.stringify(ok)}`);

  // Architect normalizes to 'consultant' role; first-class roles keep their literal name.
  const expectedRole = (n) => (n === 'architect' ? 'consultant' : n);
  for (const wrongRole of ['architect', 'swe', 'pr-reviewer']) {
    const res = await call(client, 'issue_create', { agent: wrongRole, objective: 'x', description: 'y', labels: ['Feature', 'Priority: Medium'] });
    assert.equal(res.ok, false, `${wrongRole} must be forbidden from issue_create`);
    assert.equal(res.error?.error, 'forbidden');
    assert.equal(res.error?.caller_role, expectedRole(wrongRole));
  }
});

test('issue_close — bro only; architect/swe/pr-reviewer all forbidden', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const seed = await call(client, 'issue_create', { agent: 'bro', objective: 's', description: 'd', labels: ['Feature', 'Priority: Medium'] });
  const issueId = seed.data.id;

  for (const wrongRole of ['architect', 'swe', 'pr-reviewer']) {
    const res = await call(client, 'issue_close', { agent: wrongRole, issue_id: issueId });
    assert.equal(res.ok, false, `${wrongRole} must be forbidden from issue_close`);
    assert.equal(res.error?.error, 'forbidden');
  }
});

test('task_create_batch — bro only; architect/swe/pr-reviewer all forbidden', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const seed = await call(client, 'issue_create', { agent: 'bro', objective: 'plan', description: 'd', labels: ['Feature', 'Priority: Medium'] });
  const issueId = seed.data.id;
  const taskInput = {
    waive_scope_gate: true,
    waive_scope_gate_reason: 'role-matrix test; gate not under test here',
    waive_branch_gate: true,
    waive_branch_gate_reason: 'role-matrix test; branch gate not under test here',
    waive_intent_gate: true,
    waive_intent_gate_reason: 'role-matrix test; intent gate not under test here',
    waive_decision_gate: true,
    waive_decision_gate_reason: 'role-matrix test; decision gate not under test here',
    waive_spec_shape: true,
    waive_spec_shape_reason: 'fixture targets another gate',
    issue_id: issueId,
    tasks: [{
      branch_id: 'feat/role-matrix-task',
      title: 't',
      description: 'd',
      spec_body: '# spec',
    }],
  };

  for (const wrongRole of ['architect', 'swe', 'pr-reviewer']) {
    const res = await call(client, 'task_create_batch', { agent: wrongRole, ...taskInput });
    assert.equal(res.ok, false, `${wrongRole} must be forbidden from task_create_batch`);
    assert.equal(res.error?.error, 'forbidden');
  }

  const ok = await call(client, 'task_create_batch', { agent: 'bro', ...taskInput });
  assert.equal(ok.ok, true, `bro must succeed; got ${JSON.stringify(ok)}`);
});

test('task_update_status — bro and swe allowed; architect/pr-reviewer forbidden', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const seed = await call(client, 'issue_create', { agent: 'bro', objective: 'plan', description: 'd', labels: ['Feature', 'Priority: Medium'] });
  const batch = await call(client, 'task_create_batch', {
    agent: 'bro',
    waive_scope_gate: true, waive_scope_gate_reason: 'role-matrix test seed',
    waive_branch_gate: true, waive_branch_gate_reason: 'role-matrix test; branch gate not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic triage; not under test',
    waive_spec_shape: true, waive_spec_shape_reason: 'fixture targets another gate',
    issue_id: seed.data.id,
    tasks: [{ branch_id: 'feat/tus-test', title: 't', description: 'd', spec_body: '# spec' }],
  });
  const taskId = Array.isArray(batch.data) ? batch.data[0]?.id : batch.data.tasks?.[0]?.id;

  for (const wrongRole of ['architect', 'pr-reviewer']) {
    const res = await call(client, 'task_update_status', { agent: wrongRole, task_id: taskId, status: 'running' });
    assert.equal(res.ok, false, `${wrongRole} must be forbidden from task_update_status`);
    assert.equal(res.error?.error, 'forbidden');
  }

  const sweRun = await call(client, 'task_update_status', { agent: 'swe', task_id: taskId, status: 'running' });
  assert.equal(sweRun.ok, true, `swe should drive running; got ${JSON.stringify(sweRun)}`);

  const sweDone = await call(client, 'task_update_status', { agent: 'swe', task_id: taskId, status: 'completed', commit_sha: 'abc1234' });
  assert.equal(sweDone.ok, true, `swe should complete; got ${JSON.stringify(sweDone)}`);

  const broClose = await call(client, 'task_update_status', { agent: 'bro', task_id: taskId, status: 'closed' });
  assert.equal(broClose.ok, true, `bro should close verified work; got ${JSON.stringify(broClose)}`);
});

test('validation_record — pr-reviewer only; architect/bro/swe all forbidden', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const seed = await call(client, 'issue_create', { agent: 'bro', objective: 'plan', description: 'd', labels: ['Feature', 'Priority: Medium'] });
  const batch = await call(client, 'task_create_batch', {
    agent: 'bro',
    waive_scope_gate: true, waive_scope_gate_reason: 'role-matrix test seed',
    waive_branch_gate: true, waive_branch_gate_reason: 'role-matrix test; branch gate not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic triage; not under test',
    waive_spec_shape: true, waive_spec_shape_reason: 'fixture targets another gate',
    issue_id: seed.data.id,
    tasks: [{ branch_id: 'feat/vr-test', title: 't', description: 'd', spec_body: '# spec' }],
  });
  const taskId = Array.isArray(batch.data) ? batch.data[0]?.id : batch.data.tasks?.[0]?.id;
  await call(client, 'task_update_status', { agent: 'swe', task_id: taskId, status: 'running' });
  await call(client, 'task_update_status', { agent: 'swe', task_id: taskId, status: 'completed' });

  for (const wrongRole of ['architect', 'bro', 'swe']) {
    const res = await call(client, 'validation_record', {
      agent: wrongRole, task_id: taskId, attempt_n: 1, verdict: 'pass', feedback: 'try',
    });
    assert.equal(res.ok, false, `${wrongRole} must be forbidden from validation_record`);
    assert.equal(res.error?.error, 'forbidden');
  }

  const ok = await call(client, 'validation_record', {
    agent: 'pr-reviewer', task_id: taskId, attempt_n: 1, verdict: 'pass', feedback: 'MCP available: yes\nlgtm',
    subagent_session_id: 'role-matrix-test-session',
  });
  assert.equal(ok.ok, true, `pr-reviewer should record; got ${JSON.stringify(ok)}`);
});

// pr_monitor_runs_list — read-side companion to pr_monitor_comments_get's cursor
// wire-up. Bro-only diagnostic surface; other roles must be forbidden.
test('pr_monitor_runs_list — bro allowed, others forbidden', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  for (const wrongRole of ['architect', 'swe', 'pr-reviewer']) {
    const res = await call(client, 'pr_monitor_runs_list', { agent: wrongRole });
    assert.equal(res.ok, false, `${wrongRole} must be forbidden from pr_monitor_runs_list`);
    assert.equal(res.error?.error, 'forbidden');
  }

  const ok = await call(client, 'pr_monitor_runs_list', { agent: 'bro' });
  assert.equal(ok.ok, true, `bro should be allowed; got ${JSON.stringify(ok)}`);
  assert.equal(ok.data.count, 0, 'fresh DB has no cursors yet');
});
