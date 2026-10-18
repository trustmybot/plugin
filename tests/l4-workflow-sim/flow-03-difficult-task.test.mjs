// Flow 3 — Difficult Task (FLOWS.md §3)
//
// Trajectory: bro triages difficult → issue_create → discussion (intent + triage) →
// LOOP { discussion(question) ↔ discussion(answer) } →
// task_provision (its decision_body is the decision discussion; bro writes the
// ADR file from it — bash, NOT MCP, so out of scope here) →
// SWE completes → bro closes.
//
// Asserts: the Q+A thread and the task_provision decision are queryable in
// order, the decision row is visible to issue_get_with_discussions for ADR
// generation, and task creation without Q+A is still rejected by the scope gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, startProjectClient, call } from '../l3-integration/mcp/harness.mjs';

test('Flow 3 — difficult task: Q+A discussions precede task_provision; its decision_body drives ADR', async (t) => {
  const { client, close, project } = await startProjectClient();
  t.after(async () => { await close(); });

  // 1. Issue
  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'Migrate auth from session-cookie to JWT',
    description: 'Cross-cutting refactor; touches the auth module across handlers.',
    labels: ['Feature', 'Priority: Medium'],
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

  // 4. Task creation through task_provision: its decision_body is the decision
  // row (the ADR seed), written in the same call that creates the task, branch
  // and worktree.
  const provisioned = await call(client, 'task_provision', {
    agent: 'bro',
    issue_id: issueId,
    branch_id: 'refactor/jwt-auth',
    decision_body: 'Decision: RS256 + key rotation, force re-login on cutover. ADR-0042 will capture rationale.',
    task: {
      title: 'Replace session middleware with JWT (RS256)',
      description: 'Per ADR-0042: implement RS256, force re-login on cutover.',
      spec_body: '## Success Criteria\n- JWT validates RS256\n- old session code removed',
      files: ['auth/'],
      verification: ['test -d auth'],
      repo: project.name,
    },
  });
  assert.equal(provisioned.ok, true, `task_provision: ${JSON.stringify(provisioned)}`);
  const taskId = provisioned.data.task_id;
  assert.ok(taskId);

  // 5. Verify discussion thread is fully readable in order
  const list = await call(client, 'discussion_list', { agent: 'bro', issue_id: issueId });
  assert.equal(list.ok, true);
  const kinds = list.data.map(r => r.kind);
  assert.deepEqual(kinds, [
    'intent', 'note', 'question', 'answer', 'question', 'answer', 'decision',
  ], `discussion order broke: ${JSON.stringify(kinds)}`);

  // 6. Verify decision is queryable for ADR generation
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

  const issue = await call(client, 'issue_create', {
    agent: 'bro', objective: 'Difficult thing', description: 'd',
    labels: ['Feature', 'Priority: Medium'],
  });
  const issueId = issue.data.id;

  // Bro skips Q+A and tries task_create_batch without waive — should fail
  const batch = await call(client, 'task_create_batch', {
    agent: 'bro',
    issue_id: issueId,
    tasks: [{
      branch_id: 'refactor/x',
      title: 't', description: 'd',
      spec_body: '## Success Criteria\n- x refactored',
    }],
  });
  assert.equal(batch.ok, false,
    'task_create_batch without Q+A AND without waive must be rejected by scope gate');
  assert.match(JSON.stringify(batch.error), /scope.gate|question/i,
    `error should mention scope gate / questions: ${JSON.stringify(batch.error)}`);
});
