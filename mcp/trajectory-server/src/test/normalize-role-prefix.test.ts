/**
 * Role-prefix regression guard (GH 38, GH 1692): require-task-spec gates a
 * tmb:swe spawn as it gates swe, and code-reviewer-no-worktree lets a
 * tmb:code-reviewer spawn without isolation through. Each case runs
 * `node dist/hooks.js <gate>` in a sandbox with its own HOME. The
 * tmb:code-reviewer worktree deny is in hooks-code-reviewer-spawn-gates.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { makeSandbox, runGate, type Sandbox } from './hook-sandbox.js';

describe('a tmb:-prefixed role is gated as the bare role', () => {
  let sb: Sandbox;
  let db: string;

  before(() => {
    sb = makeSandbox('normalize-role-prefix');
    db = join(sb.dir, 'trajectory.db');
    const d = new DatabaseSync(db);
    try {
      d.exec(`
        CREATE TABLE tasks (id INTEGER PRIMARY KEY, status TEXT NOT NULL, spec_body TEXT, files TEXT, branch_id TEXT, repo TEXT);
        CREATE TABLE repos (name TEXT, path TEXT);
        INSERT INTO tasks (id, status, spec_body, files) VALUES (1, 'pending', 'Do the thing.', NULL);
      `);
    } finally {
      d.close();
    }
  });

  after(() => sb.remove());

  const run = (gate: string, toolInput: Record<string, unknown>, tool?: string) =>
    runGate(gate, {
      cwd: sb.dir,
      input: JSON.stringify(tool === undefined ? { tool_input: toolInput } : { tool_name: tool, tool_input: toolInput }),
      env: { ...sb.env, TRAJECTORY_DB_PATH: db },
    }).stdout;

  it('require-task-spec: tmb:swe without a task_id is blocked', () => {
    const out = run('require-task-spec', { subagent_type: 'tmb:swe', prompt: 'do the thing' });
    assert.ok(out.includes('"permissionDecision":"deny"'), 'tmb:swe without task_id must be blocked');
    assert.ok(out.includes('SWE spawn requires task_id'), 'block reason cites missing task_id');
  });

  it('require-task-spec: tmb:swe with a valid task passes silently', () => {
    assert.equal(run('require-task-spec', { subagent_type: 'tmb:swe', prompt: 'task_id=1 do the thing' }), '');
  });

  it('code-reviewer-no-worktree: tmb:code-reviewer without isolation passes silently', () => {
    assert.equal(run('code-reviewer-no-worktree', { subagent_type: 'tmb:code-reviewer' }, 'Agent'), '');
  });
});
