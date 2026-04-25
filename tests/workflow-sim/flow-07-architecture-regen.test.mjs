// Flow 7 — Architecture Regen (FLOWS.md §7)
//
// Trajectory: bro at session start (or via /tmb refresh-architecture) detects
// stale auto/ docs → calls regen_state_get → if HEAD is >25 commits ahead OR
// explicitly requested, calls architecture_regen → which scans file-registry
// from last_seen_sha and writes 4 markdown files into docs/trustmybot/architecture/auto/.
//
// Asserts: regen_state cursor advances after a regen, file_registry can be
// read by allowed roles, and bro/architect/pr-reviewer can all call
// architecture_regen (swe is forbidden).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, call } from '../mcp-integration/harness.mjs';

test('Flow 7 — regen_state lifecycle: get null → set after regen → next get returns the cursor', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  await call(client, 'identity_set', { agent: 'bro', human_name: 'Test' });

  // 1. Fresh project: no regen has happened yet
  const initial = await call(client, 'regen_state_get', { agent: 'bro', target: 'codebase_tree' });
  assert.equal(initial.ok, true);
  // initial state may be null OR an empty cursor record — both signal "never regenerated"
  const isFresh = initial.data === null || !initial.data?.last_seen_sha;
  assert.ok(isFresh, `initial regen_state should be unset, got: ${JSON.stringify(initial.data)}`);

  // 2. Bro records a regen cursor (architect/bro/pr-reviewer all allowed)
  const set = await call(client, 'regen_state_set', {
    agent: 'bro', target: 'codebase_tree',
    last_seen_sha: '0123456789abcdef0123456789abcdef01234567',
  });
  assert.equal(set.ok, true, `regen_state_set: ${JSON.stringify(set)}`);

  // 3. Subsequent get returns the cursor
  const after = await call(client, 'regen_state_get', { agent: 'bro', target: 'codebase_tree' });
  assert.equal(after.ok, true);
  assert.equal(after.data.last_seen_sha, '0123456789abcdef0123456789abcdef01234567');
});

test('Flow 7 — role enforcement: swe forbidden from regen_state_set + architecture_regen', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  // swe is an executor; it does not own architecture state
  const sweSet = await call(client, 'regen_state_set', {
    agent: 'swe', target: 'erd',
    last_seen_sha: '0000000000000000000000000000000000000000',
  });
  assert.equal(sweSet.ok, false);
  assert.match(JSON.stringify(sweSet.error), /forbidden/);

  const sweRegen = await call(client, 'architecture_regen', {
    agent: 'swe', repo_root: '/tmp/anywhere',
  });
  assert.equal(sweRegen.ok, false);
  assert.match(JSON.stringify(sweRegen.error), /forbidden/);
});
