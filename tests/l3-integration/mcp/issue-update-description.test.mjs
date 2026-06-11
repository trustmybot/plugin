import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, call } from './harness.mjs';

async function seedIssue(client, description = 'original description') {
  const result = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'backfill test issue',
    description,
  });
  assert.equal(result.ok, true, `seed issue: ${JSON.stringify(result)}`);
  return result.data;
}

test('issue_update_description — bro updates issue, verified via issue_get', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const issue = await seedIssue(client, 'truncated desc');

  const updateResult = await call(client, 'issue_update_description', {
    agent: 'bro',
    issue_id: String(issue.id),
    description: '# Full Description\n\nThis is the complete description that was truncated on import.',
  });
  assert.equal(updateResult.ok, true, `update should succeed: ${JSON.stringify(updateResult)}`);
  assert.equal(
    updateResult.data.description,
    '# Full Description\n\nThis is the complete description that was truncated on import.',
  );

  const getResult = await call(client, 'issue_get', {
    agent: 'bro',
    issue_id: String(issue.id),
    include_description: true,
  });
  assert.equal(getResult.ok, true, `issue_get: ${JSON.stringify(getResult)}`);
  assert.equal(
    getResult.data.description,
    '# Full Description\n\nThis is the complete description that was truncated on import.',
    'description should match after round-trip via issue_get',
  );
});

test('issue_update_description — agent=swe returns forbidden', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const issue = await seedIssue(client);

  const result = await call(client, 'issue_update_description', {
    agent: 'swe',
    issue_id: String(issue.id),
    description: 'swe trying to update',
  });
  assert.equal(result.ok, false, 'swe should be forbidden');
  assert.equal(result.error?.error, 'forbidden');
  assert.equal(result.error?.caller_role, 'swe');
});

test('issue_update_description — agent=architect (consultant) returns forbidden', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const issue = await seedIssue(client);

  const result = await call(client, 'issue_update_description', {
    agent: 'architect',
    issue_id: String(issue.id),
    description: 'architect trying to update',
  });
  assert.equal(result.ok, false, 'architect (consultant) should be forbidden');
  assert.equal(result.error?.error, 'forbidden');
  // Architect normalizes to 'consultant' role under the new role doctrine.
  assert.equal(result.error?.caller_role, 'consultant');
});

test('issue_update_description — agent=cto (consultant) also forbidden (consultant equivalence)', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const issue = await seedIssue(client);

  const result = await call(client, 'issue_update_description', {
    agent: 'cto',
    issue_id: String(issue.id),
    description: 'cto trying to update',
  });
  assert.equal(result.ok, false, 'cto (consultant) should be forbidden');
  assert.equal(result.error?.caller_role, 'consultant');
});

test('issue_update_description — agent=pr-reviewer returns forbidden', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const issue = await seedIssue(client);

  const result = await call(client, 'issue_update_description', {
    agent: 'pr-reviewer',
    issue_id: String(issue.id),
    description: 'pr-reviewer trying to update',
  });
  assert.equal(result.ok, false, 'pr-reviewer should be forbidden');
  assert.equal(result.error?.error, 'forbidden');
  assert.equal(result.error?.caller_role, 'pr-reviewer');
});

test('issue_update_description — missing agent returns forbidden (unknown role)', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const issue = await seedIssue(client);

  const result = await call(client, 'issue_update_description', {
    issue_id: String(issue.id),
    description: 'no agent provided',
  });
  assert.equal(result.ok, false, 'missing agent should be forbidden');
  assert.equal(result.error?.error, 'forbidden');
  assert.equal(result.error?.caller_role, 'unknown');
});

test('issue_update_description — missing issue_id returns validation error', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const result = await call(client, 'issue_update_description', {
    agent: 'bro',
    description: 'no issue_id',
  });
  assert.equal(result.ok, false, 'missing issue_id should error');
  assert.ok(
    result.error?.error?.includes('Missing required arg') || result.throw,
    `expected missing-arg error, got: ${JSON.stringify(result)}`,
  );
});
