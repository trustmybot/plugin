/**
 * The task state groups readers test status by (GH 3224): every exported group
 * is a subset of TASK_STATUSES, every state is in some group, an unknown state
 * is in no group, and the SQL form of a group selects the same rows the JS
 * form admits.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { TASK_STATUSES } from '../task-status.js';
import * as taskStates from '../task-states.js';
import {
  ACTIONABLE,
  ACTIVE,
  AWAITING_CLOSE,
  DONE,
  IN_PROGRESS,
  LIVE,
  TASK_STATE,
  TERMINAL,
  TERMINAL_FAILED,
  inGroup,
  sqlList,
  statusIn,
  unionOf,
  type TaskStateGroup,
} from '../task-states.js';

const exportedGroups = (): [string, TaskStateGroup][] =>
  Object.entries(taskStates).filter(
    (entry): entry is [string, TaskStateGroup] => Array.isArray(entry[1]) && entry[0] !== 'TASK_STATUSES',
  );

describe('task state groups', () => {
  it('each named group holds exactly its states', () => {
    assert.deepEqual(IN_PROGRESS, ['pending', 'running', 'needs_validation']);
    assert.deepEqual(ACTIVE, ['pending', 'running']);
    assert.deepEqual(ACTIONABLE, ['pending', 'failed']);
    assert.deepEqual(AWAITING_CLOSE, ['needs_validation', 'completed']);
    assert.deepEqual(LIVE, ['pending', 'running', 'needs_validation', 'completed']);
    assert.deepEqual(DONE, ['closed']);
    assert.deepEqual(TERMINAL_FAILED, ['failed', 'escalated']);
    assert.deepEqual(TERMINAL, ['closed', 'failed', 'escalated']);
  });

  it('re-exports the one TASK_STATUSES list rather than a copy', () => {
    assert.equal(taskStates.TASK_STATUSES, TASK_STATUSES);
  });

  it('every exported group is a non-empty, duplicate-free subset of TASK_STATUSES', () => {
    const known = new Set<string>(TASK_STATUSES);
    for (const [name, group] of exportedGroups()) {
      assert.ok(group.length > 0, `${name} is not empty`);
      assert.equal(new Set(group).size, group.length, `${name} has no duplicates`);
      for (const state of group) assert.ok(known.has(state), `${name} member '${state}' is in TASK_STATUSES`);
    }
  });

  it('every state is in at least one exported group', () => {
    const grouped = new Set<string>(exportedGroups().flatMap(([, group]) => group));
    for (const state of TASK_STATUSES) assert.ok(grouped.has(state), `${state} is in a group`);
  });

  it('TASK_STATE names each state as itself', () => {
    assert.deepEqual(Object.keys(TASK_STATE).sort(), [...TASK_STATUSES].sort());
    for (const [name, value] of Object.entries(TASK_STATE)) assert.equal(value, name);
  });

  it('LIVE is IN_PROGRESS with AWAITING_CLOSE, and TERMINAL is DONE with TERMINAL_FAILED', () => {
    assert.deepEqual(unionOf(IN_PROGRESS, AWAITING_CLOSE), unionOf(LIVE));
    assert.deepEqual(unionOf(DONE, TERMINAL_FAILED), unionOf(TERMINAL));
  });

  it('no state is both live and terminal', () => {
    for (const state of LIVE) assert.ok(!inGroup(TERMINAL, state), `${state} is not terminal`);
  });

  it('every state is live or terminal', () => {
    for (const state of TASK_STATUSES) assert.ok(inGroup(LIVE, state) || inGroup(TERMINAL, state), `${state} is covered`);
  });
});

describe('inGroup', () => {
  it('admits members and refuses non-members', () => {
    assert.equal(inGroup(DONE, 'closed'), true);
    assert.equal(inGroup(DONE, 'completed'), false);
  });

  it('puts an unknown, null or missing status in no group', () => {
    for (const [, group] of exportedGroups()) {
      assert.equal(inGroup(group, 'archived'), false);
      assert.equal(inGroup(group, ''), false);
      assert.equal(inGroup(group, null), false);
      assert.equal(inGroup(group, undefined), false);
    }
  });
});

describe('unionOf', () => {
  it('returns each member once, in TASK_STATUSES order', () => {
    assert.deepEqual(unionOf(DONE, AWAITING_CLOSE, DONE), ['needs_validation', 'completed', 'closed']);
  });

  it('of no groups is empty', () => {
    assert.deepEqual(unionOf(), []);
  });
});

describe('statusIn and sqlList', () => {
  it('render the group as quoted SQL literals, with and without an alias', () => {
    assert.equal(sqlList(TERMINAL_FAILED), "'failed', 'escalated'");
    assert.equal(statusIn('t', TERMINAL_FAILED), "t.status IN ('failed', 'escalated')");
    assert.equal(statusIn('', TERMINAL_FAILED), "status IN ('failed', 'escalated')");
  });

  it('select in SQLite exactly the statuses inGroup admits', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY, status TEXT)');
    const insert = db.prepare('INSERT INTO tasks (status) VALUES (?)');
    for (const state of [...TASK_STATUSES, 'archived']) insert.run(state);
    for (const [name, group] of exportedGroups()) {
      const rows = db.prepare(`SELECT t.status FROM tasks t WHERE ${statusIn('t', group)} ORDER BY t.id`).all() as { status: string }[];
      const selected = rows.map((r) => r.status);
      assert.deepEqual(selected, [...TASK_STATUSES, 'archived'].filter((s) => inGroup(group, s)), `${name} SQL matches inGroup`);
    }
    db.close();
  });
});
