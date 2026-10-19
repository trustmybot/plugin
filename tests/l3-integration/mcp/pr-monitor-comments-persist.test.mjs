// pr_monitor_comments_get persists fetched PR comments server-side as
// discussions keyed by remote_comment_id, over the real JSON-RPC wire. `gh` is a
// stub script first on a PATH that holds no real gh, so nothing reaches the
// network; the server's live-CLI guard is lifted only for this stub. The DB
// holds one repo with a github remote, so the tool resolves its `-R` slug from
// that row (it never falls back to the cwd remote).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startClient, call, sqliteRun } from './harness.mjs';

const BRANCH = 'fix/pr-comments-l3';

function prPayload(comments) {
  return JSON.stringify({ state: 'OPEN', headRefName: BRANCH, comments, reviews: [] });
}

const C1 = { id: 'IC_1', author: { login: 'alice' }, body: 'Please handle null.', createdAt: '2024-01-15T10:00:00Z' };
const C2 = { id: 'IC_2', author: { login: 'bob' }, body: 'Rename this helper.', createdAt: '2024-01-15T11:00:00Z' };

test('pr_monitor_comments_get persists comments once and dedupes re-fetches (mocked gh)', async (t) => {
  const stubDir = mkdtempSync(path.join(tmpdir(), 'tmb-gh-stub-'));
  const fixture = path.join(stubDir, 'pr.json');
  const ghLog = path.join(stubDir, 'gh.log');
  writeFileSync(
    path.join(stubDir, 'gh'),
    `#!/bin/sh\necho "$*" >> "${ghLog}"\ncase "$1" in\n  auth) exit 0 ;;\n  pr) cat "${fixture}"; exit 0 ;;\nesac\nexit 1\n`,
  );
  chmodSync(path.join(stubDir, 'gh'), 0o755);
  writeFileSync(fixture, prPayload([C1, C2]));

  const env = { ...process.env, PATH: `${stubDir}:/usr/bin:/bin` };
  delete env.NODE_TEST_CONTEXT;
  delete env.TMB_FORBID_LIVE_SYNC;
  delete env.TMB_DISABLE_REMOTE_SYNC;

  const { client, close, dbPath } = await startClient({ env, fileDb: true });
  t.after(async () => {
    await close();
    rmSync(stubDir, { recursive: true, force: true });
  });
  sqliteRun(dbPath, `INSERT INTO repos (name, path) VALUES ('repo', '${path.join(stubDir, 'repo')}');
    INSERT INTO repo_remotes (repo, name, provider, url, is_primary) VALUES ('repo', 'origin', 'github', 'https://github.com/owner/repo.git', 1);`);

  const issue = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'PR comment persistence fixture',
    description: 'Carrier issue for the mocked PR.',
    labels: ['Test', 'Priority: Low'],
  });
  assert.equal(issue.ok, true, `issue_create: ${JSON.stringify(issue)}`);
  const issueId = issue.data.id;

  const batch = await call(client, 'task_create_batch', {
    waive_scope_gate: true, waive_scope_gate_reason: 'integration-test fixture; gate not under test',
    waive_branch_gate: true, waive_branch_gate_reason: 'integration-test fixture; branch gate not under test',
    waive_intent_gate: true, waive_intent_gate_reason: 'integration-test fixture; not under test',
    waive_decision_gate: true, waive_decision_gate_reason: 'integration-test fixture; not under test',
    agent: 'bro',
    issue_id: issueId,
    tasks: [{
      branch_id: BRANCH,
      title: 'Ship the PR',
      description: 'Task whose branch is the PR head.',
      spec_body: '# Task\n\n## Success Criteria\n- PR comments land on this issue',
    }],
  });
  assert.equal(batch.ok, true, `task_create_batch: ${JSON.stringify(batch)}`);

  const first = await call(client, 'pr_monitor_comments_get', { agent: 'bro', pr_number: 41 });
  assert.equal(first.ok, true, `first fetch: ${JSON.stringify(first)}`);
  assert.equal(first.data.comments.length, 2);
  assert.equal(first.data.persisted, 2, 'both comments persisted on the first fetch');
  assert.equal(first.data.duplicates, 0);
  assert.match(readFileSync(ghLog, 'utf8'), /^pr view -R github\.com\/owner\/repo 41 /m, 'gh got the slug from the seeded repo_remotes row');

  // The resolved slug keys a cursor whose last_fetched_at would filter out these
  // 2024 fixture comments; an explicit since re-reads them so dedupe is exercised.
  const refetch = { agent: 'bro', pr_number: 41, since: '2024-01-01T00:00:00Z' };
  const second = await call(client, 'pr_monitor_comments_get', refetch);
  assert.equal(second.ok, true, `second fetch: ${JSON.stringify(second)}`);
  assert.equal(second.data.persisted, 0, 're-fetch of the same comments inserts nothing');
  assert.equal(second.data.duplicates, 2);

  writeFileSync(fixture, prPayload([C1, C2, { id: 'IC_3', author: { login: 'carol' }, body: 'One more nit.', createdAt: '2024-01-15T12:00:00Z' }]));
  const third = await call(client, 'pr_monitor_comments_get', refetch);
  assert.equal(third.ok, true, `third fetch: ${JSON.stringify(third)}`);
  assert.equal(third.data.persisted, 1, 'only the new comment is persisted');
  assert.equal(third.data.duplicates, 2);

  const read = await call(client, 'issue_get_with_discussions', { agent: 'bro', issue_id: issueId });
  assert.equal(read.ok, true, `issue_get_with_discussions: ${JSON.stringify(read)}`);
  const prNotes = (read.data.discussions ?? []).filter((d) => String(d.body).startsWith('[PR #41 comment by '));
  assert.equal(prNotes.length, 3, `one discussion per remote comment: ${JSON.stringify(prNotes)}`);
  assert.deepEqual(prNotes.map((d) => d.author).sort(), ['alice', 'bob', 'carol']);
  for (const d of prNotes) assert.equal(d.kind, 'note');
});
