// Layer 2 agent-workflow: architect's MCP responsibilities end-to-end.
// Covers the simple-task flow: issue_create → discussion_append (triage note)
// → task_create_batch → task_get → validation_history → issue_close.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, call } from './harness.mjs';

test('architect — simple task workflow: issue → discussion → tasks → close', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  // 1. Create issue
  const issue = await call(client, 'issue_create', {
    agent: 'architect',
    objective: 'Implement hello-world endpoint',
    description: 'Full spec: add /hello returning 200 OK with {msg:"hello"}.',
  });
  assert.equal(issue.ok, true, `issue_create: ${JSON.stringify(issue)}`);
  const issueId = issue.data.id;

  // 2. Append triage discussion
  const triage = await call(client, 'discussion_append', {
    agent: 'architect',
    issue_id: issueId,
    kind: 'note',
    author: 'architect',
    body: 'Triage: simple — single-file endpoint, no arch impact.',
  });
  assert.equal(triage.ok, true);

  // 3. Create a task
  const batch = await call(client, 'task_create_batch', {
    agent: 'architect',
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

  // 4. Read task back (would be how architect double-checks)
  const getTask = await call(client, 'task_get', { agent: 'architect', task_id: taskId });
  assert.equal(getTask.ok, true);
  assert.equal(getTask.data.branch_id, 'feat/hello-endpoint');
  assert.match(getTask.data.spec_body, /Task: \/hello endpoint/);

  // 5. Check validation_history — empty pre-SWE
  const preValidation = await call(client, 'validation_history', {
    agent: 'architect', task_id: taskId,
  });
  assert.equal(preValidation.ok, true);
  assert.equal(
    Array.isArray(preValidation.data) ? preValidation.data.length : 0,
    0,
    'validation_history must be empty before pr-reviewer runs',
  );

  // 6. Close the issue (simulate end-of-work)
  const closed = await call(client, 'issue_close', {
    agent: 'architect',
    issue_id: issueId,
    post_git_sha: 'abc1234',
  });
  assert.equal(closed.ok, true, `issue_close: ${JSON.stringify(closed)}`);
});

test('architect — difficult-task flow: issue + ADR-style discussion thread', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const issue = await call(client, 'issue_create', {
    agent: 'architect',
    objective: 'Introduce new auth module',
    description: 'Refactor session handling into its own module with OIDC support.',
  });
  assert.equal(issue.ok, true);
  const issueId = issue.data.id;

  // Multi-round alignment loop — architect surfaces concerns.
  const questions = [
    { kind: 'note', body: 'Triage: difficult — touches docs/trustmybot/architecture/.' },
    { kind: 'question', body: 'Is OIDC fine, or do you need SAML compat?' },
    { kind: 'answer', body: 'OIDC only is fine.' },
    { kind: 'decision', body: 'Going with OIDC. New module at src/auth/.' },
  ];

  for (const entry of questions) {
    const append = await call(client, 'discussion_append', {
      agent: 'architect',
      issue_id: issueId,
      author: 'architect',
      ...entry,
    });
    assert.equal(append.ok, true, `discussion_append ${entry.kind}: ${JSON.stringify(append)}`);
  }

  // Read discussions back
  const readBack = await call(client, 'issue_get_with_discussions', {
    agent: 'architect',
    issue_id: issueId,
  });
  assert.equal(readBack.ok, true, `read back: ${JSON.stringify(readBack)}`);
  const discussions = readBack.data.discussions ?? [];
  assert.equal(discussions.length, 4, `expected 4 discussions, got ${discussions.length}`);
});

test('architect — skill_register + skill_promote lifecycle', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const reg = await call(client, 'skill_register', {
    agent: 'architect',
    name: 'test-skill',
    description: 'smoke',
    file_path: 'skills/test-skill/SKILL.md',
    trust_tier: 'curated',
    created_by: 'architect',
  });
  assert.equal(reg.ok, true, `skill_register: ${JSON.stringify(reg)}`);

  // Valid promote path: draft → pending_review
  const promote = await call(client, 'skill_promote', {
    agent: 'architect',
    name: 'test-skill',
    from_status: 'draft',
    to_status: 'pending_review',
  });
  assert.equal(promote.ok, true, `skill_promote: ${JSON.stringify(promote)}`);
});
