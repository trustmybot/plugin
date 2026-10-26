/**
 * agent_runs.plugin_version (GH 1884): openSweRun records the plugin version of
 * the TrajectoryDB instance on the fresh and the resumed insert, NULL when the
 * instance has none, and closing the row leaves the value as inserted.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TrajectoryDB } from '../db.js';
import { closeOpenRunsForTask, openSweRun, SWE_RESUME_OBSERVE_FROM_NODE } from '../tools/agent-runs.js';

const ISSUE_ID = 9;
const TASK_ID = 3;
const CTX = { host: 'claude', projectRoot: null } as const;
const TASK = { id: TASK_ID, issue_id: ISSUE_ID, repo: null };

function db(pluginVersion: string | null): TrajectoryDB {
  const d = new TrajectoryDB(':memory:', { pluginVersion, serverLog: () => {}, sqlLog: () => {} });
  d.run(
    "INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (?, 'o', 'open', '2026-10-25T09:00:00.000Z', '2026-10-25T09:00:00.000Z')",
    [ISSUE_ID],
  );
  d.run(
    "INSERT INTO tasks (id, issue_id, branch_id, description, status, effort, created_at, updated_at) VALUES (?, ?, 'feat/3-x', 'd', 'running', 'high', '2026-10-25T09:00:00.000Z', '2026-10-25T09:00:00.000Z')",
    [TASK_ID, ISSUE_ID],
  );
  return d;
}

const rows = (d: TrajectoryDB) =>
  d
    .all<{ id: number; resumed_from: number | null; completed_at: string | null; plugin_version: string | null }>(
      'SELECT id, resumed_from, completed_at, plugin_version FROM agent_runs WHERE task_id = ? ORDER BY id',
      [TASK_ID],
    )
    .map((r) => ({ ...r }));

describe('openSweRun records agent_runs.plugin_version (GH 1884)', () => {
  it('writes the instance version on a fresh insert, and closing the row keeps it', () => {
    const d = db('9.8.7-test');
    const now = new Date().toISOString();
    assert.equal(openSweRun(d, TASK, now, CTX, '/wt'), true);
    const [opened] = rows(d);
    assert.equal(opened!.resumed_from, null);
    assert.equal(opened!.plugin_version, '9.8.7-test');

    assert.equal(closeOpenRunsForTask(d, TASK_ID, new Date().toISOString(), 'completed'), 1);
    const [closed] = rows(d);
    assert.notEqual(closed!.completed_at, null);
    assert.equal(closed!.plugin_version, '9.8.7-test');
    d.close();
  });

  it('writes the instance version on a resumed insert', () => {
    const d = db('9.8.7-test');
    d.run(
      `INSERT INTO agent_runs (id, task_id, issue_id, agent_type, started_at, completed_at, spawn_id, effort, exit_reason, plugin_version)
       VALUES (1, ?, ?, 'swe', '2026-10-25T09:05:00.000Z', '2026-10-25T09:50:00.000Z', 'agent-swe-1', 'high', 'completed', '1.0.0-old')`,
      [TASK_ID, ISSUE_ID],
    );
    const now = new Date().toISOString();
    d.run(
      `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
       VALUES (?, ?, 'swe_resume_observed', 's', json_object('task_id', ?, 'agent_id', 'agent-swe-1', 'observed_at', ?, 'consumed', 0), ?)`,
      [ISSUE_ID, SWE_RESUME_OBSERVE_FROM_NODE, TASK_ID, now, now],
    );
    assert.equal(openSweRun(d, TASK, now, CTX, '/wt'), true);
    const [previous, resumed] = rows(d);
    assert.equal(resumed!.resumed_from, 1);
    assert.equal(resumed!.plugin_version, '9.8.7-test');
    assert.equal(previous!.plugin_version, '1.0.0-old');
    d.close();
  });

  it('writes NULL when the instance was built with pluginVersion: null', () => {
    const d = db(null);
    assert.equal(openSweRun(d, TASK, new Date().toISOString(), CTX, '/wt'), true);
    const [opened] = rows(d);
    assert.equal(opened!.plugin_version, null);
    d.close();
  });
});
