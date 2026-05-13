// Flow M — /monitor cursor (FLOWS.md §M)
//
// Trajectory: the user runs `/monitor 42` after their MR is open upstream.
// Bro routes to `tmb_review` §C and calls `pr_comments_get(pr_number=42)`.
// The server reads the prior cursor from `pr_review_runs.last_fetched_at`
// (none on first run), fetches the comments, then upserts the cursor with
// the new `last_fetched_at` + `last_comment_id`. A re-run of /monitor
// against the same PR reads the cursor back and passes it as `since=` to
// the backend, so only new comments are returned.
//
// L4 can't reach a real gh/glab backend, so this test exercises the
// MCP-side contract: the diagnostic `pr_review_runs_list` surface lets bro
// (or an L4 test) inspect cursor state. The full cursor read-write cycle
// against a mocked backend is covered at L2 in `pr-comments.test.ts`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, call } from '../mcp-integration/harness.mjs';

test('Flow M — /monitor cursor: pr_review_runs_list returns empty on fresh DB; bro-only', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  // Fresh DB has no cursors. Bro should get an empty list.
  const list = await call(client, 'pr_review_runs_list', { agent: 'bro' });
  assert.equal(list.ok, true, `bro should list cursors; got ${JSON.stringify(list)}`);
  assert.equal(list.data.count, 0, 'fresh DB has zero cursors');
  assert.deepEqual(list.data.rows, [], 'rows[] should be empty');

  // Filter by pr_number on empty DB still returns empty.
  const filtered = await call(client, 'pr_review_runs_list', {
    agent: 'bro',
    pr_number: 42,
  });
  assert.equal(filtered.ok, true);
  assert.equal(filtered.data.count, 0);

  // Other roles forbidden — the diagnostic surface is for bro only.
  for (const role of ['swe', 'pr-reviewer', 'architect']) {
    const r = await call(client, 'pr_review_runs_list', { agent: role });
    assert.equal(r.ok, false, `${role} must be forbidden from pr_review_runs_list`);
    assert.equal(r.error?.error, 'forbidden');
  }
});

test('Flow M — /monitor cursor: invalid pr_number filter rejects gracefully', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  // Non-positive integer should error structurally, not crash.
  const negative = await call(client, 'pr_review_runs_list', { agent: 'bro', pr_number: -1 });
  assert.equal(negative.ok, false, 'negative pr_number must error');
  assert.match(
    negative.error?.error ?? '',
    /positive integer/,
    `Expected 'positive integer' validation error, got ${JSON.stringify(negative)}`,
  );

  // String pr_number coerces — but only positive integers count.
  const zero = await call(client, 'pr_review_runs_list', { agent: 'bro', pr_number: 0 });
  assert.equal(zero.ok, false, 'zero pr_number must error');
});
