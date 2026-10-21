import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startClient, call, seedReviewerObservation } from './harness.mjs';

// Role matrix coverage for tools that wrap handlers with `requireRoles`. Every
// registered tool, gated or not, rejects a missing or invalid `agent`.

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

test('issue_snapshot_md — bro, pr-reviewer and consultants; swe forbidden', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const seed = await call(client, 'issue_create', { agent: 'bro', objective: 'x', description: 'y', labels: ['Feature', 'Priority: Medium'] });
  assert.equal(seed.ok, true, `seed issue: ${JSON.stringify(seed)}`);
  const issueId = seed.data.id;

  const res = await call(client, 'issue_snapshot_md', { agent: 'swe', issue_id: issueId });
  assert.equal(res.ok, false, 'swe must be forbidden');
  assert.equal(res.error?.error, 'forbidden');

  for (const role of ['pm', 'tmb:pm']) {
    const gate = await call(client, 'issue_snapshot_md', { agent: role, issue_id: issueId });
    assert.notEqual(gate.error?.error, 'forbidden', `${role} passes the role gate; got ${JSON.stringify(gate)}`);
  }
});

test('consultants read world_model_get, world_model_search, repos_list, task_brief; not task_update_status', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  for (const [tool, args] of [
    ['world_model_get', {}],
    ['world_model_search', { query: 'x' }],
    ['repos_list', {}],
    ['task_brief', { task_id: 999999 }],
  ]) {
    const res = await call(client, tool, { agent: 'pm', ...args });
    assert.notEqual(res.error?.error, 'forbidden', `pm passes the ${tool} gate; got ${JSON.stringify(res)}`);
  }

  const write = await call(client, 'task_update_status', { agent: 'pm', task_id: '1', status: 'running' });
  assert.equal(write.ok, false);
  assert.equal(write.error?.error, 'forbidden');
  assert.equal(write.error?.caller_role, 'consultant');
});

test('missing agent is rejected on a tool with no role gate', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const res = await call(client, 'issue_list', {});
  assert.equal(res.ok, false, 'issue_list without agent must fail');
  assert.equal(res.error?.reason, 'agent_missing_or_invalid');
  assert.equal(res.error?.tool, 'issue_list');

  const prefixed = await call(client, 'issue_list', { agent: 'tmb:swe' });
  assert.equal(prefixed.ok, true, `tmb:swe is swe; got ${JSON.stringify(prefixed)}`);
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

  // completed → closed via task_update_status is rejected (#1025): the only
  // path into 'closed' is the bro_atomic_close composite.
  const directClose = await call(client, 'task_update_status', { agent: 'bro', task_id: taskId, status: 'closed' });
  assert.equal(directClose.ok, false, `direct close must be rejected; got ${JSON.stringify(directClose)}`);
  assert.match(directClose.error?.error ?? '', /bro_atomic_close/, `rejection should name bro_atomic_close; got ${JSON.stringify(directClose)}`);

  // Bro is the closer, but only through the composite (bro-only role).
  const broClose = await call(client, 'bro_atomic_close', {
    agent: 'bro', task_id: taskId, commit_sha: 'abc1234',
    verification_summary: 'role-matrix: verified, closing via composite',
    waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test',
  });
  assert.equal(broClose.ok, true, `bro should close verified work via bro_atomic_close; got ${JSON.stringify(broClose)}`);
  assert.equal(broClose.data.base_moved, false, `the close result carries base_moved; got ${JSON.stringify(broClose)}`);

  // task_brief carries the latest close's scope record for pr-reviewer.
  const brief = await call(client, 'task_brief', { agent: 'pr-reviewer', task_id: taskId });
  assert.equal(brief.ok, true, `pr-reviewer reads task_brief; got ${JSON.stringify(brief)}`);
  assert.deepEqual(brief.data.scope, { files: [], extras_accepted: [], base_moved: false });
});

test('validation_record — pr-reviewer only; architect/bro/swe all forbidden', async (t) => {
  const { client, close, dbPath } = await startClient({ fileDb: true });
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

  const unobserved = await call(client, 'validation_record', {
    agent: 'pr-reviewer', task_id: taskId, attempt_n: 1, verdict: 'pass', mcp_available: true, feedback: 'lgtm',
    subagent_session_id: 'role-matrix-test-session',
  });
  assert.equal(unobserved.ok, false, 'pr-reviewer without an observed identity must be refused');
  assert.match(String(unobserved.error?.error), /^subagent_session_unavailable/);

  seedReviewerObservation(dbPath, taskId, 1, { agentId: 'role-matrix-reviewer', sessionId: 'role-matrix-main' });
  const ok = await call(client, 'validation_record', {
    agent: 'pr-reviewer', task_id: taskId, attempt_n: 1, verdict: 'pass', mcp_available: true, feedback: 'lgtm',
    subagent_session_id: 'role-matrix-test-session',
  });
  assert.equal(ok.ok, true, `pr-reviewer should record after an observed row; got ${JSON.stringify(ok)}`);
  assert.equal(ok.data?.reviewer_agent_id, 'role-matrix-reviewer');
  assert.equal(ok.data?.subagent_session_id, 'role-matrix-main', 'caller value ignored');
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

// task_reopen / task_update_spec amend a task's fences and lifecycle: bro only.
test('task_reopen + task_update_spec — bro only; swe/pr-reviewer/architect forbidden', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  for (const tool of ['task_reopen', 'task_update_spec']) {
    for (const wrongRole of ['architect', 'swe', 'pr-reviewer']) {
      const res = await call(client, tool, { agent: wrongRole, task_id: 1, reason: 'x', files: ['a'] });
      assert.equal(res.ok, false, `${wrongRole} must be forbidden from ${tool}`);
      assert.equal(res.error?.error, 'forbidden');
    }
    const bro = await call(client, tool, { agent: 'bro', task_id: 999999, reason: 'x', files: ['a'] });
    assert.equal(bro.ok, false, `${tool} on a missing task is an error`);
    assert.notEqual(bro.error?.error, 'forbidden', `bro passes the role gate on ${tool}`);
  }
});

// agent_runs_backfill rewrites metering history: bro only; a dry run writes nothing.
test('agent_runs_backfill — bro only; dry run over an empty transcripts dir reports zero', async (t) => {
  const { client, close } = await startClient();
  const dir = mkdtempSync(join(tmpdir(), 'tmb-l3-backfill-'));
  t.after(async () => { await close(); rmSync(dir, { recursive: true, force: true }); });

  for (const wrongRole of ['architect', 'swe', 'pr-reviewer']) {
    const res = await call(client, 'agent_runs_backfill', { agent: wrongRole, transcripts_dir: dir });
    assert.equal(res.ok, false, `${wrongRole} must be forbidden from agent_runs_backfill`);
    assert.equal(res.error?.error, 'forbidden');
  }
  const bro = await call(client, 'agent_runs_backfill', { agent: 'bro', transcripts_dir: dir });
  assert.equal(bro.ok, true, `bro should be allowed; got ${JSON.stringify(bro)}`);
  assert.equal(bro.data.dry_run, true);
  assert.equal(bro.data.transcripts_seen, 0);
  assert.equal(bro.data.rows_inserted, 0);
});

test('trajectory_doctor — bro only; read-only unless record:true', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  for (const wrongRole of ['architect', 'swe', 'pr-reviewer']) {
    const res = await call(client, 'trajectory_doctor', { agent: wrongRole });
    assert.equal(res.ok, false, `${wrongRole} must be forbidden from trajectory_doctor`);
    assert.equal(res.error?.error, 'forbidden');
  }

  const allowed = await call(client, 'trajectory_doctor', { agent: 'bro' });
  assert.equal(allowed.ok, true, `bro should run trajectory_doctor; got ${JSON.stringify(allowed)}`);
  assert.equal(typeof allowed.data?.healthy, 'boolean');
  assert.ok(Array.isArray(allowed.data?.violations));
  assert.ok(Array.isArray(allowed.data?.skipped));
  assert.equal(allowed.data?.audit_id, undefined, 'record defaults to false');

  const recorded = await call(client, 'trajectory_doctor', { agent: 'bro', record: true, ids: ['fk_check_empty'] });
  assert.equal(recorded.ok, true, `record:true should succeed; got ${JSON.stringify(recorded)}`);
  assert.equal(typeof recorded.data?.audit_id, 'number');
});

// agent_resolve is bro only; agent_register / agent_list take a root-marked
// file_path and every returned agent row carries resolved_path, never scope.
test('agent_resolve — bro only; agent_register/agent_list speak plugin:/project: file_path with resolved_path', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  for (const wrongRole of ['architect', 'swe', 'pr-reviewer']) {
    const res = await call(client, 'agent_resolve', { agent: wrongRole, name: 'legal-reviewer' });
    assert.equal(res.ok, false, `${wrongRole} must be forbidden from agent_resolve`);
    assert.equal(res.error?.error, 'forbidden');
  }
  const resolved = await call(client, 'agent_resolve', { agent: 'bro', name: 'legal-reviewer' });
  assert.equal(resolved.ok, true, `bro should be allowed; got ${JSON.stringify(resolved)}`);
  assert.equal(resolved.data.file_path, 'project:.claude/agents/legal-reviewer.md');
  assert.ok('resolved_path' in resolved.data);

  const unmarked = await call(client, 'agent_register', {
    agent: 'bro', name: 'legal-reviewer', kind: 'consultant', file_path: '.claude/agents/legal-reviewer.md',
  });
  assert.equal(unmarked.ok, false);
  assert.match(unmarked.error?.error ?? '', /^invalid_file_path:/);

  const shadow = await call(client, 'agent_register', {
    agent: 'bro', name: 'swe', kind: 'backbone', file_path: 'project:.claude/agents/swe.md',
  });
  assert.equal(shadow.ok, false);
  assert.match(shadow.error?.error ?? '', /backbone agent whose file_path must be plugin:/);

  const registered = await call(client, 'agent_register', {
    agent: 'bro', name: 'legal-reviewer', kind: 'consultant', file_path: 'project:.claude/agents/legal-reviewer.md',
  });
  assert.equal(registered.ok, true, `agent_register: ${JSON.stringify(registered)}`);
  assert.equal(registered.data.file_path, 'project:.claude/agents/legal-reviewer.md');
  assert.ok(!('scope' in registered.data), 'agent_register row carries no scope key');

  const listed = await call(client, 'agent_list', { agent: 'bro' });
  assert.equal(listed.ok, true, `agent_list: ${JSON.stringify(listed)}`);
  assert.equal(listed.data.agents.length, 7);
  for (const row of listed.data.agents) {
    assert.ok(!('scope' in row), `${row.name} carries no scope key`);
    assert.ok('resolved_path' in row, `${row.name} carries resolved_path`);
    assert.match(row.file_path, /^(plugin|project):/);
  }
  const swe = listed.data.agents.find((a) => a.name === 'swe');
  assert.match(swe.resolved_path, /\/agents\/swe\.md$/);

  const plugin = await call(client, 'agent_list', { agent: 'bro', root: 'plugin' });
  assert.equal(plugin.data.agents.length, 6);
  const project = await call(client, 'agent_list', { agent: 'bro', root: 'project' });
  assert.deepEqual(project.data.agents.map((a) => a.name), ['legal-reviewer']);
});

// audit_append admits a caller only for events whose writers list its role,
// and records from_node as that caller.
test('audit_append — per-event writers decide who may write; from_node is the caller', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const bro = await call(client, 'audit_append', {
    agent: 'bro', issue_id: '-1', event_type: 'scope_gate_waived', summary: 'bro waiver',
  });
  assert.equal(bro.ok, true, JSON.stringify(bro));
  assert.equal(bro.data.from_node, 'bro');

  for (const agent of ['pr-reviewer', 'swe', 'architect']) {
    const res = await call(client, 'audit_append', {
      agent, issue_id: '-1', from_node: 'bro', event_type: 'scope_gate_waived', summary: 'forged waiver',
    });
    assert.equal(res.ok, false, `${agent} must not write scope_gate_waived`);
    assert.equal(res.error?.error, 'audit_event_not_writable_by_role');
    assert.deepEqual(res.error?.allowed_writers, ['bro']);
  }

  const spoof = await call(client, 'audit_append', {
    agent: 'bro', issue_id: '-1', from_node: 'hook:swe-verification-gate', event_type: 'scope_gate_waived', summary: 'x',
  });
  assert.equal(spoof.ok, false, 'from_node other than the caller is refused');

  const hookOnly = await call(client, 'audit_append', {
    agent: 'bro', issue_id: '-1', event_type: 'verification_gate_waived', summary: 'x',
  });
  assert.equal(hookOnly.error?.error, 'audit_event_not_writable_by_role');

  const reviewer = await call(client, 'audit_append', {
    agent: 'pr-reviewer', issue_id: '-1', event_type: 'mcp_unavailable_fallback_invoked', summary: 'fallback',
  });
  assert.equal(reviewer.ok, true, JSON.stringify(reviewer));
  assert.equal(reviewer.data.from_node, 'pr-reviewer');
});
