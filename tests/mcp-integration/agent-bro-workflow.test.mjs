// Layer 2 agent-workflow: bro's MCP responsibilities end-to-end.
// Asserts the exact sequence of MCP calls bro makes during first-run
// onboarding, from empty DB to fully-configured project.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, call } from './harness.mjs';

test('bro — first-run onboarding sequence end-to-end', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  // --- Pre-state: empty DB ---
  const initialIdentity = await call(client, 'identity_get', { agent: 'bro' });
  assert.equal(initialIdentity.ok, true);
  assert.equal(initialIdentity.data.human_name, null, 'identity must start empty');
  assert.equal(initialIdentity.data.created_at, null);

  const initialConfig = await call(client, 'config_list', { agent: 'bro' });
  assert.equal(initialConfig.ok, true);
  const initialKeys = Object.keys(initialConfig.data ?? {});
  assert.equal(
    initialKeys.filter((k) => ['branching_model', 'pr_target', 'protected_branches'].includes(k)).length,
    0,
    'onboarding keys must start unset',
  );

  // --- Step 1: identity_set ---
  const setName = await call(client, 'identity_set', { agent: 'bro', human_name: 'Zax' });
  assert.equal(setName.ok, true, `identity_set failed: ${JSON.stringify(setName)}`);
  assert.equal(setName.data.human_name, 'Zax');

  // --- Step 2-4: three config_set calls (the onboarding writes) ---
  const setBranching = await call(client, 'config_set', {
    agent: 'bro', key: 'branching_model', value: 'github-flow',
  });
  assert.equal(setBranching.ok, true, `config_set branching_model: ${JSON.stringify(setBranching)}`);

  const setPrTarget = await call(client, 'config_set', {
    agent: 'bro', key: 'pr_target', value: 'main',
  });
  assert.equal(setPrTarget.ok, true);

  const setProtected = await call(client, 'config_set', {
    agent: 'bro', key: 'protected_branches', value: ['main'],
  });
  assert.equal(setProtected.ok, true);

  // --- Verify post-state ---
  const finalIdentity = await call(client, 'identity_get', { agent: 'bro' });
  assert.equal(finalIdentity.data.human_name, 'Zax');
  assert.ok(finalIdentity.data.created_at, 'created_at must be set after identity_set');

  const finalConfig = await call(client, 'config_list', { agent: 'bro' });
  assert.equal(finalConfig.data.branching_model, 'github-flow');
  assert.equal(finalConfig.data.pr_target, 'main');
  assert.deepEqual(finalConfig.data.protected_branches, ['main']);
});

test('bro — reonboard rename sequence', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  // Seed: initial onboarding.
  await call(client, 'identity_set', { agent: 'bro', human_name: 'Alice' });
  await call(client, 'config_set', { agent: 'bro', key: 'branching_model', value: 'github-flow' });
  await call(client, 'config_set', { agent: 'bro', key: 'pr_target', value: 'main' });

  // Rename flow: reset + new set.
  const reset = await call(client, 'identity_reset', { agent: 'bro' });
  assert.equal(reset.ok, true);

  const afterReset = await call(client, 'identity_get', { agent: 'bro' });
  assert.equal(afterReset.data.human_name, null, 'identity_reset must clear name');

  const rename = await call(client, 'identity_set', { agent: 'bro', human_name: 'Bob' });
  assert.equal(rename.ok, true);

  const final = await call(client, 'identity_get', { agent: 'bro' });
  assert.equal(final.data.human_name, 'Bob');

  // Verify config is untouched by identity_reset.
  const configAfter = await call(client, 'config_list', { agent: 'bro' });
  assert.equal(configAfter.data.branching_model, 'github-flow', 'config must survive identity_reset');
});

test('bro — issue_resume returns latest open issue for session-start check', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  // Architect seeds an open issue.
  const create = await call(client, 'issue_create', {
    agent: 'bro', objective: 'seed for resume test', description: 'x',
  });
  assert.equal(create.ok, true);
  const issueId = create.data.id;

  // bro calls issue_resume with the known issue_id.
  const resume = await call(client, 'issue_resume', { agent: 'bro', issue_id: issueId });
  assert.equal(resume.ok, true, `issue_resume: ${JSON.stringify(resume)}`);
  assert.ok(resume.data, 'issue_resume must return structured data');
});
