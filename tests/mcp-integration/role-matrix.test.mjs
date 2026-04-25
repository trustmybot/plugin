import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, call } from './harness.mjs';

// Role matrix coverage for tools that currently wrap handlers with `requireRoles`.
// Tools without requireRoles (task_*, validation_*, issue_*, ledger_*, audit_*,
// skill_*) accept any caller — that's tracked as a protection gap (see issue
// filed alongside this test file). When requireRoles is added there, add tests
// to this file covering them.

test('identity_set — bro allowed, others forbidden, missing agent forbidden', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const missing = await call(client, 'identity_set', { human_name: 'X' });
  assert.equal(missing.ok, false, 'call without agent must fail');
  assert.equal(missing.error?.error, 'forbidden');
  assert.equal(missing.error?.caller_role, 'unknown');

  for (const wrongRole of ['architect', 'swe', 'pr-reviewer']) {
    const res = await call(client, 'identity_set', { agent: wrongRole, human_name: 'X' });
    assert.equal(res.ok, false, `${wrongRole} must be forbidden from identity_set`);
    assert.equal(res.error?.error, 'forbidden');
    assert.equal(res.error?.caller_role, wrongRole);
  }

  const allowed = await call(client, 'identity_set', { agent: 'bro', human_name: 'Alice' });
  assert.equal(allowed.ok, true, `bro should be allowed; got ${JSON.stringify(allowed)}`);
  assert.equal(allowed.data?.human_name, 'Alice');
});

test('identity_reset — bro only', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  for (const wrongRole of ['architect', 'swe', 'pr-reviewer']) {
    const res = await call(client, 'identity_reset', { agent: wrongRole });
    assert.equal(res.ok, false);
    assert.equal(res.error?.error, 'forbidden');
  }
  const allowed = await call(client, 'identity_reset', { agent: 'bro' });
  assert.equal(allowed.ok, true, `bro should reset; got ${JSON.stringify(allowed)}`);
});

test('config_set — bro & architect allowed, swe & pr-reviewer forbidden', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  for (const allowedRole of ['bro', 'architect']) {
    const res = await call(client, 'config_set', {
      agent: allowedRole,
      key: `smoke_${allowedRole}`,
      value: 'ok',
    });
    assert.equal(res.ok, true, `${allowedRole} should set config; got ${JSON.stringify(res)}`);
  }

  for (const wrongRole of ['swe', 'pr-reviewer']) {
    const res = await call(client, 'config_set', {
      agent: wrongRole,
      key: 'smoke',
      value: 'x',
    });
    assert.equal(res.ok, false, `${wrongRole} must be forbidden from config_set`);
    assert.equal(res.error?.error, 'forbidden');
  }
});

test('file_registry_upsert — architect & bro allowed, swe & pr-reviewer forbidden', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  for (const wrongRole of ['swe', 'pr-reviewer']) {
    const res = await call(client, 'file_registry_upsert', {
      agent: wrongRole,
      path: 'x.py',
      type: 'file',
    });
    assert.equal(res.ok, false, `${wrongRole} must be forbidden`);
    assert.equal(res.error?.error, 'forbidden');
  }
});

test('file_registry_delete — architect & bro allowed, swe & pr-reviewer forbidden', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  for (const wrongRole of ['swe', 'pr-reviewer']) {
    const res = await call(client, 'file_registry_delete', {
      agent: wrongRole,
      path: 'x.py',
    });
    assert.equal(res.ok, false);
    assert.equal(res.error?.error, 'forbidden');
  }
});

test('issue_snapshot_md — architect & pr-reviewer only', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  // Seed an issue so the handler has something to snapshot.
  const seed = await call(client, 'issue_create', { agent: 'architect', objective: 'x', description: 'y' });
  assert.equal(seed.ok, true, `seed issue: ${JSON.stringify(seed)}`);
  const issueId = seed.data.id;

  for (const wrongRole of ['bro', 'swe']) {
    const res = await call(client, 'issue_snapshot_md', { agent: wrongRole, issue_id: issueId });
    assert.equal(res.ok, false, `${wrongRole} must be forbidden`);
    assert.equal(res.error?.error, 'forbidden');
  }
});

test('discussion_append — workflow agents (bro/architect) can append questions; swe scope-restricted', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  // Seed: architect creates an issue.
  const issue = await call(client, 'issue_create', { agent: 'architect', objective: 'x', description: 'y' });
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

test('architecture_regen — architect/bro/pr-reviewer allowed, swe forbidden', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const res = await call(client, 'architecture_regen', { agent: 'swe' });
  assert.equal(res.ok, false, `swe must be forbidden`);
  assert.equal(res.error?.error, 'forbidden');
});

test('regen_state_set — architect/bro/pr-reviewer allowed, swe forbidden', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const res = await call(client, 'regen_state_set', {
    agent: 'swe',
    target: 'file_registry',
    last_seen_sha: 'abc1234',
  });
  assert.equal(res.ok, false, `swe must be forbidden`);
  assert.equal(res.error?.error, 'forbidden');
});
