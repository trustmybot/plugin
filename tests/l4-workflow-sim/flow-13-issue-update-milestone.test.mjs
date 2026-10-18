// Flow 13 — issue_update (milestone move, labels, objective)
//
// Trajectory: bro creates an issue under one milestone → issue_update moves it
// to another milestone, replaces the label set and rewrites the objective →
// the stored issue carries the new values and the target milestone row exists.
// Remote sync is off, so nothing leaves the machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startClient, call } from '../l3-integration/mcp/harness.mjs';

function pinEnv(vars) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

test('Flow 13 — issue_update moves the milestone and replaces labels and objective', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'tmb-l4-flow13-'));
  const restoreEnv = pinEnv({ HOME: home, TMB_DISABLE_REMOTE_SYNC: '1' });
  const { client, close, dbPath } = await startClient({ fileDb: true });
  t.after(async () => {
    await close();
    restoreEnv();
    rmSync(home, { recursive: true, force: true });
  });
  const sql = (query) => JSON.parse(execFileSync('sqlite3', ['-json', dbPath, query]).toString() || '[]');

  const created = await call(client, 'issue_create', {
    agent: 'bro', objective: 'Original objective', description: 'issue_update flow.',
    labels: ['Feature', 'Priority: Medium'], milestone: 'v1.1.0',
  });
  assert.equal(created.ok, true, `issue_create: ${JSON.stringify(created)}`);
  const issueId = created.data.id;
  const row = () => sql(`SELECT objective, milestone, labels FROM issues WHERE id = ${issueId}`)[0];
  assert.equal(row().milestone, 'v1.1.0');

  const updated = await call(client, 'issue_update', {
    agent: 'bro', issue_id: String(issueId), milestone: 'v1.2.0',
    labels: ['Bug', 'Priority: High'], objective: 'Rewritten objective',
  });
  assert.equal(updated.ok, true, `issue_update: ${JSON.stringify(updated)}`);

  const after = row();
  assert.equal(after.milestone, 'v1.2.0');
  assert.equal(after.objective, 'Rewritten objective');
  assert.deepEqual([...JSON.parse(after.labels)].sort(), ['Bug', 'Priority: High']);

  const rejected = await call(client, 'issue_update', { agent: 'bro', issue_id: String(issueId) });
  assert.equal(rejected.ok, false, 'an update naming no field is refused');
  assert.equal(row().milestone, 'v1.2.0');
});
