// Layer 2 agent-workflow: bro's planner MCP responsibilities end-to-end.
// Covers the simple-task flow: issue_create → discussion_append (triage note)
// → task_create_batch → task_get → validation_history → issue_close.
// Bro is the planner; architect is consultant-only (see role-matrix.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, call } from './harness.mjs';

test('bro (planner) — simple task workflow: issue → discussion → tasks → close', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  // 1. Create issue
  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'Implement hello-world endpoint',
    description: 'Full spec: add /hello returning 200 OK with {msg:"hello"}.',
  });
  assert.equal(issue.ok, true, `issue_create: ${JSON.stringify(issue)}`);
  const issueId = issue.data.id;

  // 2. Append triage discussion
  const triage = await call(client, 'discussion_append', {
    agent: 'bro',
    issue_id: issueId,
    kind: 'note',
    author: 'bro',
    body: 'Triage: simple — single-file endpoint, no arch impact.',
  });
  assert.equal(triage.ok, true);

  // 3. Create a task
  const batch = await call(client, 'task_create_batch', {
    waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
    agent: 'bro',
    issue_id: issueId,
    tasks: [{
      branch_id: 'feat/hello-endpoint',
      title: 'Add /hello endpoint',
      description: 'Wire up a 200 OK handler returning {msg:"hello"}.',
      success_criteria: '200 OK body matches',
      spec_body: '# Task: /hello endpoint\n\nAdd handler, test, commit.',
    }],
  });
  assert.equal(batch.ok, true, `task_create_batch: ${JSON.stringify(batch)}`);
  const taskId = Array.isArray(batch.data) ? batch.data[0]?.id : batch.data.tasks?.[0]?.id;
  assert.ok(taskId, `task id not returned: ${JSON.stringify(batch.data)}`);

  // 4. Read task back (would be how bro double-checks)
  const getTask = await call(client, 'task_get', { agent: 'bro', task_id: taskId });
  assert.equal(getTask.ok, true);
  assert.equal(getTask.data.branch_id, 'feat/hello-endpoint');
  assert.match(getTask.data.spec_body, /Task: \/hello endpoint/);

  // 5. Check validation_history — empty pre-SWE
  const preValidation = await call(client, 'validation_history', {
    agent: 'bro', task_id: taskId,
  });
  assert.equal(preValidation.ok, true);
  assert.equal(
    Array.isArray(preValidation.data) ? preValidation.data.length : 0,
    0,
    'validation_history must be empty before pr-reviewer runs',
  );

  // 6. Close the issue (simulate end-of-work)
  const closed = await call(client, 'issue_close', {
    agent: 'bro',
    issue_id: issueId,
    post_git_sha: 'abc1234',
  });
  assert.equal(closed.ok, true, `issue_close: ${JSON.stringify(closed)}`);
});

test('bro (planner) — difficult-task flow: issue + ADR-style discussion thread', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'Introduce new auth module',
    description: 'Refactor session handling into its own module with OIDC support.',
  });
  assert.equal(issue.ok, true);
  const issueId = issue.data.id;

  // Multi-round alignment loop — bro surfaces concerns to the Human.
  const questions = [
    { kind: 'note', body: 'Triage: difficult — touches docs/trustmybot/architecture/.' },
    { kind: 'question', body: 'Is OIDC fine, or do you need SAML compat?' },
    { kind: 'answer', body: 'OIDC only is fine.' },
    { kind: 'decision', body: 'Going with OIDC. New module at src/auth/.' },
  ];

  for (const entry of questions) {
    const append = await call(client, 'discussion_append', {
      agent: 'bro',
      issue_id: issueId,
      author: 'bro',
      ...entry,
    });
    assert.equal(append.ok, true, `discussion_append ${entry.kind}: ${JSON.stringify(append)}`);
  }

  // Read discussions back
  const readBack = await call(client, 'issue_get_with_discussions', {
    agent: 'bro',
    issue_id: issueId,
  });
  assert.equal(readBack.ok, true, `read back: ${JSON.stringify(readBack)}`);
  const discussions = readBack.data.discussions ?? [];
  assert.equal(discussions.length, 4, `expected 4 discussions, got ${discussions.length}`);
});

test('bro (planner) — skill_register + skill_promote lifecycle', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const reg = await call(client, 'skill_register', {
    agent: 'bro',
    name: 'test-skill',
    description: 'smoke',
    file_path: 'skills/test-skill/SKILL.md',
    trust_tier: 'curated',
    created_by: 'bro',
  });
  assert.equal(reg.ok, true, `skill_register: ${JSON.stringify(reg)}`);

  // Valid promote path: draft → pending_review
  const promote = await call(client, 'skill_promote', {
    agent: 'bro',
    name: 'test-skill',
    from_status: 'draft',
    to_status: 'pending_review',
  });
  assert.equal(promote.ok, true, `skill_promote: ${JSON.stringify(promote)}`);
});
