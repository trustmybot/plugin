// Flow 3 — Difficult Task (FLOWS.md §3)
//
// Trajectory: bro triages difficult → issue_create → discussion (intent + triage) →
// LOOP { discussion(question) ↔ discussion(answer) } → discussion(decision) →
// (bro writes ADR file — bash, NOT MCP, so out of scope here) →
// task_create_batch (no waive_scope_gate; the Q+A *is* the scope-gate satisfaction) →
// SWE completes → bro closes.
//
// Asserts: scope-gate is satisfied by question rows (no waive needed),
// the discussion thread is queryable in order, and the decision rows
// are visible to issue_get_with_discussions for ADR generation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, call } from '../mcp-integration/harness.mjs';

test('Flow 3 — difficult task: Q+A discussions satisfy scope gate; decision row drives ADR', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  await call(client, 'identity_set', { agent: 'bro' });

  // 1. Issue
  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'Migrate auth from session-cookie to JWT',
    description: 'Cross-cutting refactor; touches docs/trustmybot/architecture/.',
  });
  assert.equal(issue.ok, true);
  const issueId = issue.data.id;

  // 2. Intent + triage note
  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, author: 'human', kind: 'intent',
    body: '@bro switch us to JWT auth', verified_human: true,
  });
  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, author: 'bro', kind: 'note',
    body: 'Triage: difficult — touches architecture, multiple services.',
  });

  // 3. Q+A loop — bro asks scope-clarifying questions one at a time
  const q1 = await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question',
    body: 'JWT signing key: HS256 with shared secret OR RS256 with key rotation?',
  });
  assert.equal(q1.ok, true);

  const a1 = await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, author: 'human', kind: 'answer',
    body: 'RS256 with rotation; we need this for compliance.', verified_human: true,
  });
  assert.equal(a1.ok, true);

  const q2 = await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question',
    body: 'Migrate existing sessions OR force re-login on cutover?',
  });
  assert.equal(q2.ok, true);

  const a2 = await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, author: 'human', kind: 'answer',
    body: 'Force re-login; cleaner cutover, acceptable UX cost.', verified_human: true,
  });
  assert.equal(a2.ok, true);

  // 4. Decision row (the ADR seed)
  const decision = await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, author: 'bro', kind: 'decision',
    body: 'Decision: RS256 + key rotation, force re-login on cutover. ADR-0042 will capture rationale.',
  });
  assert.equal(decision.ok, true);

  // 5. Task creation — NO waive_scope_gate (the Q+A satisfies it).
  // This is the structural difference from Flow 2: difficult triage MUST go
  // through the Q+A scope gate.
  const batch = await call(client, 'task_create_batch', {
    agent: 'bro',
    issue_id: issueId,
    waive_branch_gate: true,
    waive_branch_gate_reason: 'workflow-sim test; branch gate not under test in this flow',
    waive_intent_gate: true,
    waive_intent_gate_reason: 'workflow-sim test; intent gate not under test in this flow',
    waive_decision_gate: true,
    waive_decision_gate_reason: 'workflow-sim test; triage gate not under test in this flow',
    tasks: [{
      branch_id: 'refactor/jwt-auth',
      title: 'Replace session middleware with JWT (RS256)',
      description: 'Per ADR-0042: implement RS256, force re-login on cutover.',
      success_criteria: 'All routes accept JWT; old session middleware removed; integration tests green.',
      spec_body: '## Files\n- middleware/auth.py\n## Verification\n```\npytest tests/auth\n```\n## Success Criteria\n- JWT validates RS256\n- old session code removed',
    }],
  });
  assert.equal(batch.ok, true, `batch (no-waive): ${JSON.stringify(batch)}`);
  const taskId = Array.isArray(batch.data) ? batch.data[0]?.id : batch.data.tasks?.[0]?.id;
  assert.ok(taskId);

  // 6. Verify discussion thread is fully readable in order
  const list = await call(client, 'discussion_list', { agent: 'bro', issue_id: issueId });
  assert.equal(list.ok, true);
  const kinds = list.data.map(r => r.kind);
  assert.deepEqual(kinds, [
    'intent', 'note', 'question', 'answer', 'question', 'answer', 'decision',
  ], `discussion order broke: ${JSON.stringify(kinds)}`);

  // 7. Verify decision is queryable for ADR generation
  const withDiscussions = await call(client, 'issue_get_with_discussions', {
    agent: 'bro', issue_id: issueId,
  });
  assert.equal(withDiscussions.ok, true);
  const decisions = withDiscussions.data.discussions.filter(r => r.kind === 'decision');
  assert.equal(decisions.length, 1, 'exactly one decision row');
  assert.match(decisions[0].body, /ADR-0042/);
});

test('Flow 3 negative — task creation WITHOUT scope-gate Q+A is rejected', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  await call(client, 'identity_set', { agent: 'bro' });

  const issue = await call(client, 'issue_create', {
    agent: 'bro', objective: 'Difficult thing', description: 'd',
  });
  const issueId = issue.data.id;

  // Bro skips Q+A and tries task_create_batch without waive — should fail
  const batch = await call(client, 'task_create_batch', {
    agent: 'bro',
    issue_id: issueId,
    tasks: [{
      branch_id: 'refactor/x',
      title: 't', description: 'd', success_criteria: 's',
      spec_body: '## body',
    }],
  });
  assert.equal(batch.ok, false,
    'task_create_batch without Q+A AND without waive must be rejected by scope gate');
  assert.match(JSON.stringify(batch.error), /scope.gate|question/i,
    `error should mention scope gate / questions: ${JSON.stringify(batch.error)}`);
});
