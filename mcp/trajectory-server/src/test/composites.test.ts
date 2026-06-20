import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrajectoryDB } from '../db.js';
import { tempDB } from './helpers.js';
import { compositeTools, filesToDirs } from '../tools/composites.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';
import { discussionTools } from '../tools/discussions.js';
import { auditTools } from '../tools/audit.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function parse(r: RawResult): Record<string, unknown> {
  return JSON.parse(r.content[0].text);
}

function parseBatch(r: RawResult): Array<Record<string, unknown>> {
  const raw = JSON.parse(r.content[0].text);
  return (raw.tasks ?? raw) as Array<Record<string, unknown>>;
}

async function call(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  name: string,
  args: Record<string, unknown>,
): Promise<RawResult> {
  const h = handlers[name];
  assert.ok(h, `handler not found: ${name}`);
  return h(args) as unknown as RawResult;
}

describe('branch_id_propose', () => {
  const db = tempDB();
  const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');

  it('maps "fix the auth crash" to fix/ prefix', async () => {
    const r = await call(composites.handlers, 'branch_id_propose', {
      agent: 'bro',
      intent: 'fix the auth crash',
      objective: 'auth crash',
    });
    const out = parse(r);
    assert.equal(out['branch_id'], 'fix/auth-crash');
  });

  it('maps "add export feature" to feat/ prefix', async () => {
    const r = await call(composites.handlers, 'branch_id_propose', {
      agent: 'bro',
      intent: 'add export feature',
    });
    const out = parse(r);
    assert.equal(out['branch_id'], 'feat/add-export-feature');
  });

  it('omits any triage field on the return shape', async () => {
    // The simple/difficult triage classifier was retired — branch_id_propose
    // returns only { branch_id, confidence } now.
    const r = await call(composites.handlers, 'branch_id_propose', {
      agent: 'bro',
      intent: 'add new public API for billing',
    });
    const out = parse(r);
    assert.equal(out['triage'], undefined);
  });

  it('rejects empty intent', async () => {
    const r = await call(composites.handlers, 'branch_id_propose', {
      agent: 'bro',
      intent: '   ',
    });
    assert.equal(r.isError, true);
  });

  it('rejects non-bro caller', async () => {
    const r = await call(composites.handlers, 'branch_id_propose', {
      agent: 'swe',
      intent: 'fix bug',
    });
    assert.equal(r.isError, true);
  });
});

describe('task_retry_batch', () => {
  it('clones a failed task with corrected spec, links rationale + audit', async () => {
    const db = tempDB();
    const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
    const tasks = taskTools(db);
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const discussions = discussionTools(db);
    const audit = auditTools(db);

    const issueResult = parse(await call(issues.handlers, 'issue_create', {
      labels: ['Bug', 'Priority: High'],
      agent: 'bro',
      objective: 'composite retry test',
      description: 'desc',
    }));
    const issueId = String(issueResult['id']);

    // Pre-seed scope-gate question + branch_id_proposed audit so
    // task_create_batch is allowed.
    await call(discussions.handlers, 'discussion_append', {
      agent: 'bro',
      issue_id: issueId,
      author: 'bro',
      kind: 'question',
      body: 'scope?',
    });
    await call(audit.handlers, 'audit_log', {
      agent: 'bro',
      issue_id: issueId,
      kind: 'event',
      event_type: 'branch_id_proposed',
      from_node: 'bro',
      branch_id: 'fix/initial',
      summary: 'branch proposed',
    });

    const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
      agent: 'bro',
      issue_id: issueId,
      waive_intent_gate: true,
      waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
      waive_decision_gate: true,
      waive_decision_gate_reason: 'unit-test synthetic decision; not under test', waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
      tasks: [{
        branch_id: 'fix/initial',
        description: 'do thing',
        spec_body: 'placeholder',
      }],
    }));
    const failedId = String(created[0]!.id);

    // Mark it failed.
    await call(tasks.handlers, 'task_update_status', {
      agent: 'swe',
      task_id: failedId,
      status: 'failed',
    });

    const retry = await call(composites.handlers, 'task_retry_batch', {
      agent: 'bro',
      failed_task_id: failedId,
      new_branch_id: 'fix/initial-v2',
      corrected_spec_body: 'fixed approach',
      retry_rationale: 'wrong path; use approach B',
      description: 'retry desc',
    });
    assert.equal(retry.isError, undefined);
    const out = parse(retry) as { task_id: number; branch_id: string };
    assert.equal(out.branch_id, 'fix/initial-v2');

    const decisions = db.all<{ body: string }>(
      `SELECT body FROM discussions WHERE issue_id = ? AND kind = 'decision'`,
      [issueId],
    );
    assert.ok(decisions.some((d) => d.body.includes('Retry rationale')));

    const auditRows = db.all<{ event_type: string }>(
      `SELECT event_type FROM audit WHERE issue_id = ?`,
      [issueId],
    );
    assert.ok(auditRows.some((r) => r.event_type === 'task_retry_attempted'));
  });

  it('rejects retry on a task whose status is not failed', async () => {
    const db = tempDB();
    const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
    const tasks = taskTools(db);
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const discussions = discussionTools(db);
    const audit = auditTools(db);

    const issueId = String((parse(await call(issues.handlers, 'issue_create', {
      labels: ['Bug', 'Priority: High'],
      agent: 'bro', objective: 'test', description: 'x',
    }))['id']));
    await call(discussions.handlers, 'discussion_append', {
      agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
    });
    await call(audit.handlers, 'audit_log', {
      agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
      from_node: 'bro', branch_id: 'fix/x', summary: 's',
    });
    const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
      agent: 'bro', issue_id: issueId,
      waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test', waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
      tasks: [{ branch_id: 'fix/x', description: 'd', spec_body: 's' }],
    }));
    const id = String(created[0]!.id);

    const r = await call(composites.handlers, 'task_retry_batch', {
      agent: 'bro',
      failed_task_id: id,
      new_branch_id: 'fix/x-v2',
      corrected_spec_body: 's',
      retry_rationale: 'r',
      description: 'd',
    });
    assert.equal(r.isError, true);
    assert.match(parse(r)['error'] as string, /status is "pending"/);
  });

  it('#474: repo override lands on the new task; omitted repo inherits from failed task', async () => {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path) VALUES ('plugin', '/tmp/plugin')`);
    const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
    const tasks = taskTools(db);
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const discussions = discussionTools(db);
    const audit = auditTools(db);

    const issueId = String((parse(await call(issues.handlers, 'issue_create', {
      labels: ['Bug', 'Priority: High'],
      agent: 'bro', objective: 'repo override test', description: 'x',
    }))['id']));
    await call(discussions.handlers, 'discussion_append', {
      agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
    });
    await call(audit.handlers, 'audit_log', {
      agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
      from_node: 'bro', branch_id: 'fix/base', summary: 's',
    });
    // Create the initial task with no repo (null) — simulates single-repo workflow.
    const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
      agent: 'bro', issue_id: issueId,
      waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
      tasks: [{ branch_id: 'fix/base', description: 'd', spec_body: 's' }],
    }));
    const failedId = String(created[0]!.id);
    await call(tasks.handlers, 'task_update_status', { agent: 'swe', task_id: failedId, status: 'failed' });

    // With repo override: new task carries the override ('plugin').
    const retryWithOverride = await call(composites.handlers, 'task_retry_batch', {
      agent: 'bro', failed_task_id: failedId, new_branch_id: 'fix/base-v2',
      corrected_spec_body: 'fixed', retry_rationale: 'wrong repo; switch to plugin', description: 'd',
      repo: 'plugin',
    });
    assert.ok(!retryWithOverride.isError, `expected ok: ${JSON.stringify(parse(retryWithOverride))}`);
    const newId = (parse(retryWithOverride) as { task_id: number }).task_id;
    const newTask = db.get<{ repo: string | null }>('SELECT repo FROM tasks WHERE id = ?', [newId]);
    assert.equal(newTask!.repo, 'plugin', 'repo override lands on new task');

    // Without repo override: new task inherits 'plugin' from the previous task.
    await call(tasks.handlers, 'task_update_status', { agent: 'swe', task_id: String(newId), status: 'failed' });
    const retryInherited = await call(composites.handlers, 'task_retry_batch', {
      agent: 'bro', failed_task_id: String(newId), new_branch_id: 'fix/base-v3',
      corrected_spec_body: 'fixed again', retry_rationale: 'another attempt', description: 'd',
    });
    assert.ok(!retryInherited.isError);
    const inheritedId = (parse(retryInherited) as { task_id: number }).task_id;
    const inheritedTask = db.get<{ repo: string | null }>('SELECT repo FROM tasks WHERE id = ?', [inheritedId]);
    assert.equal(inheritedTask!.repo, 'plugin', 'repo inherited from previous task when omitted');

    db.close();
  });

  it('#474: repo override rejects ".." in path', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'task_retry_batch', {
      agent: 'bro', failed_task_id: '1', new_branch_id: 'fix/x-v2',
      corrected_spec_body: 's', retry_rationale: 'r', description: 'd',
      repo: '../etc/passwd',
    });
    assert.ok(r.isError);
    assert.match(parse(r)['error'] as string, /must not contain/);
  });

  it('#474: repo override rejects leading "/"', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'task_retry_batch', {
      agent: 'bro', failed_task_id: '1', new_branch_id: 'fix/x-v2',
      corrected_spec_body: 's', retry_rationale: 'r', description: 'd',
      repo: '/absolute/path',
    });
    assert.ok(r.isError);
    assert.match(parse(r)['error'] as string, /must not start with/);
  });

  it('retry cap: rejects the 4th retry attempt (3 prior in lineage)', async () => {
    const db = tempDB();
    const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
    const tasks = taskTools(db);
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const discussions = discussionTools(db);
    const audit = auditTools(db);

    const issueId = String((parse(await call(issues.handlers, 'issue_create', {
      labels: ['Bug', 'Priority: High'],
      agent: 'bro', objective: 'retry cap test', description: 'x',
    }))['id']));
    await call(discussions.handlers, 'discussion_append', {
      agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
    });

    const mkBranch = async (branch: string) => {
      await call(audit.handlers, 'audit_log', {
        agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
        from_node: 'bro', branch_id: branch, summary: 's',
      });
    };

    const mkTask = async (branch: string): Promise<string> => {
      await mkBranch(branch);
      const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
        agent: 'bro', issue_id: issueId,
        waive_intent_gate: true, waive_intent_gate_reason: 'not under test',
        waive_decision_gate: true, waive_decision_gate_reason: 'not under test',
        waive_spec_shape: true, waive_spec_shape_reason: 'not under test',
        tasks: [{ branch_id: branch, description: 'd', spec_body: 's' }],
      }));
      return String(created[0]!.id);
    };

    const retryFrom = async (failedId: string, newBranch: string): Promise<string> => {
      await call(tasks.handlers, 'task_update_status', { agent: 'swe', task_id: failedId, status: 'failed' });
      await mkBranch(newBranch);
      const r = await call(composites.handlers, 'task_retry_batch', {
        agent: 'bro', failed_task_id: failedId, new_branch_id: newBranch,
        corrected_spec_body: 's', retry_rationale: 'new approach', description: 'd',
      });
      assert.ok(!r.isError, `Retry should succeed for attempt on ${newBranch}: ${JSON.stringify(parse(r))}`);
      return String((parse(r) as { task_id: number }).task_id);
    };

    const id0 = await mkTask('fix/cap-v1');
    const id1 = await retryFrom(id0, 'fix/cap-v2');
    const id2 = await retryFrom(id1, 'fix/cap-v3');
    const id3 = await retryFrom(id2, 'fix/cap-v4');

    await call(tasks.handlers, 'task_update_status', { agent: 'swe', task_id: id3, status: 'failed' });
    await mkBranch('fix/cap-v5');

    const denied = await call(composites.handlers, 'task_retry_batch', {
      agent: 'bro', failed_task_id: id3, new_branch_id: 'fix/cap-v5',
      corrected_spec_body: 's', retry_rationale: 'fourth retry', description: 'd',
    });
    assert.ok(denied.isError, '4th retry must be rejected by the retry cap');
    assert.match(parse(denied)['error'] as string, /retry limit reached \(3\)/);
    assert.match(parse(denied)['error'] as string, /escalate to Human/);

    db.close();
  });
});

describe('bro_atomic_close', () => {
  it('rejects when task is not in completed/needs_validation', async () => {
    const db = tempDB();
    const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
    const tasks = taskTools(db);
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const discussions = discussionTools(db);
    const audit = auditTools(db);

    const issueId = String((parse(await call(issues.handlers, 'issue_create', {
      labels: ['Bug', 'Priority: High'],
      agent: 'bro', objective: 'test', description: 'x',
    }))['id']));
    await call(discussions.handlers, 'discussion_append', {
      agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
    });
    await call(audit.handlers, 'audit_log', {
      agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
      from_node: 'bro', branch_id: 'fix/x', summary: 's',
    });
    const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
      agent: 'bro', issue_id: issueId,
      waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test', waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
      tasks: [{ branch_id: 'fix/x', description: 'd', spec_body: 's' }],
    }));
    const id = String(created[0]!.id);

    const r = await call(composites.handlers, 'bro_atomic_close', {
      agent: 'bro',
      task_id: id,
      commit_sha: 'abcdef1234567',
      verification_summary: 'ok',
    });
    assert.equal(r.isError, true);
    assert.match(parse(r)['error'] as string, /expected "completed" or "needs_validation"/);
  });

  it('rejects malformed commit_sha', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'bro_atomic_close', {
      agent: 'bro',
      task_id: '1',
      commit_sha: 'not-a-sha',
      verification_summary: 'ok',
    });
    assert.equal(r.isError, true);
  });

  it('rejects non-bro caller', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'bro_atomic_close', {
      agent: 'swe',
      task_id: '1',
      commit_sha: 'abcdef1',
      verification_summary: 'ok',
    });
    assert.equal(r.isError, true);
    assert.equal(parse(r)['error'], 'forbidden');
  });

  it('rejects missing verification_summary with a named validation error (#396)', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'bro_atomic_close', {
      agent: 'bro',
      task_id: '1',
      commit_sha: 'abcdef1234567',
    });
    assert.ok(r.isError, 'Expected error when verification_summary is missing');
    const errMsg = parse(r)['error'] as string;
    assert.ok(
      errMsg.includes('verification_summary'),
      `error should mention verification_summary, got: ${errMsg}`,
    );
  });

  it('sets closed_at on parent issue when close_issue_if_last_task=true (regression: Bug 1)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'bac-closed-at-'));
    const repoRoot = join(ws, 'app');
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, 'a.ts'), 'export const x = 1;\n');
    mkdirSync(join(ws, '.claude', 'tmb'), { recursive: true });
    const dbPath = join(ws, '.claude', 'tmb', 'trajectory.db');

    const db = tempDB();
    db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [repoRoot]);

    const issues = issueTools(db, dbPath);
    const tasks = taskTools(db);
    const composites = compositeTools(db, dbPath);
    const discussions = discussionTools(db);
    const audit = auditTools(db);

    try {
      const issueId = String((parse(await call(issues.handlers, 'issue_create', {
        labels: ['Bug', 'Priority: High'],
        agent: 'bro', objective: 'closed_at regression', description: 'x',
      }))['id']));

      await call(discussions.handlers, 'discussion_append', {
        agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
      });
      await call(audit.handlers, 'audit_log', {
        agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
        from_node: 'bro', branch_id: 'fix/closed-at', summary: 's',
      });
      const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
        agent: 'bro', issue_id: issueId,
        waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
        waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test', waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
        tasks: [{ branch_id: 'fix/closed-at', description: 'd', spec_body: 's', repo: 'app' }],
      }));
      const taskId = String(created[0]!.id);

      await call(tasks.handlers, 'task_update_status', {
        agent: 'swe', task_id: taskId, status: 'running',
      });
      await call(tasks.handlers, 'task_update_status', {
        agent: 'swe', task_id: taskId, status: 'completed', commit_sha: 'abc1234',
      });

      const r = await call(composites.handlers, 'bro_atomic_close', {
        agent: 'bro',
        task_id: taskId,
        commit_sha: 'abc1234',
        verification_summary: 'ok',
        close_issue_if_last_task: true,
      });
      assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
      assert.equal(parse(r)['issue_closed'], true);

      const row = db.get<{ status: string; closed_at: string | null }>(
        `SELECT status, closed_at FROM issues WHERE id = ?`,
        [issueId],
      );
      assert.ok(row, 'issue row must exist');
      assert.equal(row!.status, 'closed');
      assert.ok(row!.closed_at !== null, 'closed_at must be set by bro_atomic_close auto-close');
    } finally {
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('#277: mirrors the auto-close to the linked remote (no local/remote drift)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'bac-remote-'));
    const repoRoot = join(ws, 'app');
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, 'a.ts'), 'export const x = 1;\n');
    mkdirSync(join(ws, '.claude', 'tmb'), { recursive: true });
    const dbPath = join(ws, '.claude', 'tmb', 'trajectory.db');

    const db = tempDB();
    db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [repoRoot]);
    const issues = issueTools(db, dbPath);
    const tasks = taskTools(db);
    const composites = compositeTools(db, dbPath);
    const discussions = discussionTools(db);
    const audit = auditTools(db);

    // Record every spawn so we can assert the remote close actually fired.
    const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = (cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args });
      return { status: 0, stdout: '', stderr: '' };
    };

    try {
      const issueId = String((parse(await call(issues.handlers, 'issue_create', {
        labels: ['Bug', 'Priority: High'],
        agent: 'bro', objective: 'remote close mirror', description: 'x',
      }))['id']));
      // Simulate an issue already synced to a GitHub remote (iid 42).
      db.run(`UPDATE issues SET gh_iid = 42, remote_kind = 'github' WHERE id = ?`, [issueId]);

      await call(discussions.handlers, 'discussion_append', {
        agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
      });
      await call(audit.handlers, 'audit_log', {
        agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
        from_node: 'bro', branch_id: 'fix/remote-close', summary: 's',
      });
      const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
        agent: 'bro', issue_id: issueId,
        waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
        waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test', waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
        tasks: [{ branch_id: 'fix/remote-close', description: 'd', spec_body: 's', repo: 'app' }],
      }));
      const taskId = String(created[0]!.id);

      await call(tasks.handlers, 'task_update_status', {
        agent: 'swe', task_id: taskId, status: 'completed', commit_sha: 'abc1234',
      });

      const r = await call(composites.handlers, 'bro_atomic_close', {
        agent: 'bro', task_id: taskId, commit_sha: 'abc1234', verification_summary: 'ok',
        close_issue_if_last_task: true, _spawnFn: spawnFn,
      });
      assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
      assert.equal(parse(r)['issue_closed'], true);

      const closeCall = spawnCalls.find((c) => c.args.includes('issue') && c.args.includes('close'));
      assert.ok(closeCall, `expected a remote 'issue close' spawn; got ${JSON.stringify(spawnCalls)}`);
      assert.equal(closeCall!.cmd, 'gh', 'github remote closes via gh');
      assert.ok(closeCall!.args.includes('42'), 'remote close must target gh_iid 42');
    } finally {
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('task_recover', () => {
  async function seedPendingTask(): Promise<{
    db: TrajectoryDB;
    composites: ReturnType<typeof compositeTools>;
    tasks: ReturnType<typeof taskTools>;
    issueId: string;
    taskId: string;
  }> {
    const db = tempDB();
    const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
    const tasks = taskTools(db);
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const discussions = discussionTools(db);
    const audit = auditTools(db);

    const issueId = String((parse(await call(issues.handlers, 'issue_create', {
      labels: ['Bug', 'Priority: High'],
      agent: 'bro', objective: 'recover test', description: 'x',
    }))['id']));
    await call(discussions.handlers, 'discussion_append', {
      agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
    });
    await call(audit.handlers, 'audit_log', {
      agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
      from_node: 'bro', branch_id: 'fix/recover', summary: 's',
    });
    const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
      agent: 'bro', issue_id: issueId,
      waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test', waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
      tasks: [{ branch_id: 'fix/recover', description: 'd', spec_body: 's' }],
    }));
    const taskId = String(created[0]!.id);
    return { db, composites, tasks, issueId, taskId };
  }

  it('recover-with-commit: advances a pending task to closed + writes task_recovered + bro_verification_pass', async () => {
    const { db, composites, taskId } = await seedPendingTask();

    const r = await call(composites.handlers, 'task_recover', {
      agent: 'bro', task_id: taskId, commit_sha: 'abc1234', verification_summary: 'verified independently',
    });
    assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
    const out = parse(r);
    assert.equal(out['recovered'], true);
    assert.equal(out['action'], 'closed');
    assert.equal(out['commit_sha'], 'abc1234');

    const row = db.get<{ status: string; commit_sha: string | null }>(
      'SELECT status, commit_sha FROM tasks WHERE id = ?', [taskId],
    );
    assert.equal(row!.status, 'closed');
    assert.equal(row!.commit_sha, 'abc1234');

    const recovered = db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM audit WHERE event_type = 'task_recovered'",
    );
    assert.equal(recovered!.c, 1);
    const pass = db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM audit WHERE event_type = 'bro_verification_pass'",
    );
    assert.equal(pass!.c, 1);
  });

  it('idempotent-already-closed: re-call on a closed task returns a no-op naming the status', async () => {
    const { db, composites, taskId } = await seedPendingTask();

    const first = parse(await call(composites.handlers, 'task_recover', {
      agent: 'bro', task_id: taskId, commit_sha: 'abc1234', verification_summary: 'ok',
    }));
    assert.equal(first['recovered'], true);

    const r = await call(composites.handlers, 'task_recover', {
      agent: 'bro', task_id: taskId, commit_sha: 'abc1234', verification_summary: 'ok',
    });
    assert.ok(!r.isError, 'idempotent re-call must not error');
    const out = parse(r);
    assert.equal(out['recovered'], false);
    assert.equal(out['action'], 'noop');
    assert.equal(out['status'], 'closed');

    // No duplicate audit rows on re-call.
    const recovered = db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM audit WHERE event_type = 'task_recovered'",
    );
    assert.equal(recovered!.c, 1);
  });

  it('re-dispatch-no-commit: pending with no commit returns re-dispatch without changing status', async () => {
    const { db, composites, taskId } = await seedPendingTask();

    const r = await call(composites.handlers, 'task_recover', {
      agent: 'bro', task_id: taskId,
    });
    assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
    const out = parse(r);
    assert.equal(out['recovered'], false);
    assert.equal(out['action'], 're-dispatch');
    assert.match(out['reason'] as string, /re-dispatch SWE/);

    const row = db.get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
    assert.equal(row!.status, 'pending', 'status must be unchanged');
  });

  it('rejects non-bro caller', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'task_recover', {
      agent: 'swe', task_id: '1', commit_sha: 'abc1234',
    });
    assert.equal(r.isError, true);
    assert.equal(parse(r)['error'], 'forbidden');
  });
});

describe('headless_intent_start', () => {
  it('writes audit + note + intent in one transaction', async () => {
    const db = tempDB();
    const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');

    const issueId = String((parse(await call(issues.handlers, 'issue_create', {
      labels: ['Bug', 'Priority: High'],
      agent: 'bro', objective: 'headless test', description: 'x',
    }))['id']));

    const r = await call(composites.handlers, 'headless_intent_start', {
      agent: 'bro',
      issue_id: Number(issueId),
      branch_id: 'feat/headless-test',
      intent_verbatim: 'add export feature',
      fallback_summary: 'defaults applied: base_branch=dev',
    });
    assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
    const out = parse(r);
    assert.deepEqual(out['written'], ['audit', 'note', 'intent']);

    const auditRows = db.all<{ event_type: string }>(
      `SELECT event_type FROM audit WHERE issue_id = ?`, [issueId],
    );
    assert.ok(auditRows.some((a) => a.event_type === 'headless_fallback'));

    const discussions = db.all<{ kind: string; body: string }>(
      `SELECT kind, body FROM discussions WHERE issue_id = ?`, [issueId],
    );
    assert.ok(discussions.some((d) => d.kind === 'note' && d.body.includes('Headless fallback')));
    assert.ok(discussions.some((d) => d.kind === 'intent' && d.body.includes('add export feature')));
  });

  it('rejects non-bro caller', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'headless_intent_start', {
      agent: 'swe', issue_id: 1, branch_id: 'feat/x', intent_verbatim: 'do thing',
    });
    assert.equal(r.isError, true);
    assert.equal(parse(r)['error'], 'forbidden');
  });

  it('rejects empty intent_verbatim', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'headless_intent_start', {
      agent: 'bro', issue_id: 1, branch_id: 'feat/x', intent_verbatim: '   ',
    });
    assert.equal(r.isError, true);
  });
});

describe('intent_start — active-milestone default (#154)', () => {
  function setActiveMilestone(db: ReturnType<typeof tempDB>, value: string): void {
    db.run(
      `INSERT INTO plugin_config (key, value_json) VALUES ('tmb_active_milestone', ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      [JSON.stringify(value)],
    );
  }

  it('defaults the created issue milestone from tmb_active_milestone', async () => {
    const db = tempDB();
    setActiveMilestone(db, 'v0.10.0');
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');

    const r = await call(composites.handlers, 'intent_start', {
      agent: 'bro',
      objective: 'intent default milestone',
      intent_verbatim: 'do the thing',
      branch_id: 'feat/intent-default-ms',
    });
    assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
    const issueId = parse(r)['issue_id'];

    const row = db.get<{ milestone: string | null }>(
      'SELECT milestone FROM issues WHERE id = ?',
      [issueId],
    );
    assert.equal(row?.milestone, 'v0.10.0', 'intent_start applies the config default');

    db.close();
  });

  it('stays NULL when tmb_active_milestone is unset', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');

    const r = await call(composites.handlers, 'intent_start', {
      agent: 'bro',
      objective: 'intent no milestone',
      intent_verbatim: 'do the thing',
      branch_id: 'feat/intent-no-ms',
    });
    assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
    const issueId = parse(r)['issue_id'];

    const row = db.get<{ milestone: string | null }>(
      'SELECT milestone FROM issues WHERE id = ?',
      [issueId],
    );
    assert.equal(row?.milestone, null, 'unset config → null');

    db.close();
  });

  it('upserts the FK milestones row for the sole repo', async () => {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path) VALUES ('app', '/tmp/app')`);
    setActiveMilestone(db, 'v0.10.0');
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');

    const r = await call(composites.handlers, 'intent_start', {
      agent: 'bro',
      objective: 'intent default milestone fk',
      intent_verbatim: 'do the thing',
      branch_id: 'feat/intent-default-ms-fk',
    });
    assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
    const issueId = parse(r)['issue_id'];

    const row = db.get<{ milestone: string | null; repo: string | null }>(
      'SELECT milestone, repo FROM issues WHERE id = ?',
      [issueId],
    );
    assert.equal(row?.milestone, 'v0.10.0');
    assert.equal(row?.repo, 'app');
    const ms = db.get<{ name: string }>(
      `SELECT name FROM milestones WHERE name = 'v0.10.0' AND repo = 'app'`,
    );
    assert.ok(ms, 'milestones row upserted so the FK insert succeeds');

    db.close();
  });
});

describe('bro_verification_fail_record', () => {
  it('writes audit + note in one transaction', async () => {
    const db = tempDB();
    const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
    const tasks = taskTools(db);
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const discussions = discussionTools(db);
    const audit = auditTools(db);

    const issueId = String((parse(await call(issues.handlers, 'issue_create', {
      labels: ['Bug', 'Priority: High'],
      agent: 'bro', objective: 'fail record test', description: 'x',
    }))['id']));
    await call(discussions.handlers, 'discussion_append', {
      agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
    });
    await call(audit.handlers, 'audit_log', {
      agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
      from_node: 'bro', branch_id: 'fix/fail-rec', summary: 's',
    });
    const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
      agent: 'bro', issue_id: issueId,
      waive_intent_gate: true, waive_intent_gate_reason: 'unit-test; not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'unit-test; not under test',
      waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
      tasks: [{ branch_id: 'fix/fail-rec', description: 'd', spec_body: 's' }],
    }));
    const taskId = String(created[0]!.id);

    const r = await call(composites.handlers, 'bro_verification_fail_record', {
      agent: 'bro',
      task_id: taskId,
      which_check: 'V2 — tests',
      details: 'test_auth failed with exit code 1',
    });
    assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
    const out = parse(r);
    assert.deepEqual(out['written'], ['audit', 'note']);

    const auditRows = db.all<{ event_type: string }>(
      `SELECT event_type FROM audit WHERE issue_id = ?`, [issueId],
    );
    assert.ok(auditRows.some((a) => a.event_type === 'bro_verification_fail'));

    const notes = db.all<{ kind: string; body: string }>(
      `SELECT kind, body FROM discussions WHERE issue_id = ? AND kind='note'`, [issueId],
    );
    assert.ok(notes.some((n) => n.body.includes('V2 — tests')));
  });

  it('rejects non-bro caller', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'bro_verification_fail_record', {
      agent: 'pr-reviewer', task_id: '1', which_check: 'V2', details: 'failed',
    });
    assert.equal(r.isError, true);
    assert.equal(parse(r)['error'], 'forbidden');
  });

  it('rejects details exceeding 500 chars', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'bro_verification_fail_record', {
      agent: 'bro', task_id: '1', which_check: 'V2', details: 'x'.repeat(501),
    });
    assert.equal(r.isError, true);
    assert.match(parse(r)['error'] as string, /≤500/);
  });

  it('rejects missing task', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claire/tmb/trajectory.db');
    const r = await call(composites.handlers, 'bro_verification_fail_record', {
      agent: 'bro', task_id: '99999', which_check: 'V3', details: 'not found',
    });
    assert.equal(r.isError, true);
    assert.match(parse(r)['error'] as string, /No task/);
  });
});

describe('pr_monitor_worktree', () => {
  it('rejects non-pr-reviewer caller', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'pr_monitor_worktree', {
      agent: 'bro', commit_sha: 'abc1234', repo_path: '/tmp', command: 'echo ok',
    });
    assert.equal(r.isError, true);
    assert.equal(parse(r)['error'], 'forbidden');
  });

  it('rejects malformed commit_sha', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'pr_monitor_worktree', {
      agent: 'pr-reviewer', commit_sha: 'not-a-sha', repo_path: '/tmp', command: 'echo ok',
    });
    assert.equal(r.isError, true);
    assert.match(parse(r)['error'] as string, /hex SHA/);
  });

  it('rejects relative repo_path', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'pr_monitor_worktree', {
      agent: 'pr-reviewer', commit_sha: 'abc1234', repo_path: 'relative/path', command: 'echo ok',
    });
    assert.equal(r.isError, true);
    assert.match(parse(r)['error'] as string, /absolute path/);
  });

  it('rejects empty command', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'pr_monitor_worktree', {
      agent: 'pr-reviewer', commit_sha: 'abc1234', repo_path: '/tmp', command: '   ',
    });
    assert.equal(r.isError, true);
    assert.match(parse(r)['error'] as string, /non-empty/);
  });
});

describe('reap_and_review_prep', () => {
  it('rejects non-bro caller', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'reap_and_review_prep', {
      agent: 'swe', task_ids: ['1'], repo_path: '/tmp',
    });
    assert.equal(r.isError, true);
    assert.equal(parse(r)['error'], 'forbidden');
  });

  it('rejects empty task_ids', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'reap_and_review_prep', {
      agent: 'bro', task_ids: [], repo_path: '/tmp',
    });
    assert.equal(r.isError, true);
    assert.match(parse(r)['error'] as string, /non-empty/);
  });

  it('rejects relative repo_path', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'reap_and_review_prep', {
      agent: 'bro', task_ids: ['1'], repo_path: 'relative',
    });
    assert.equal(r.isError, true);
    assert.match(parse(r)['error'] as string, /absolute/);
  });

  it('surfaces a missing task as isError with the raw id preserved (#283)', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'reap_and_review_prep', {
      agent: 'bro', task_ids: ['99999'], repo_path: '/tmp',
    });
    // A failed reap must not read as success (#283): isError + all_reaped=false.
    assert.ok(r.isError, `a missing task must surface isError; got: ${JSON.stringify(parse(r))}`);
    const out = parse(r) as {
      all_reaped: boolean;
      reaped: Array<{ task_id: number | string; reaped: boolean; error: string }>;
    };
    assert.equal(out.all_reaped, false);
    assert.equal(out.reaped[0]!.reaped, false);
    assert.equal(out.reaped[0]!.task_id, '99999', 'raw tid preserved, not NaN');
    assert.match(out.reaped[0]!.error, /No task/);
  });

  it('no-ops (no fetch) when the branch ref already resolves to the commit_sha in the main checkout (#156)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'reap-noop-'));
    const repoRoot = join(ws, 'app');
    mkdirSync(repoRoot, { recursive: true });
    const git = (cwd: string, ...a: string[]) =>
      execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    try {
      git(repoRoot, 'init', '-q', '-b', 'main');
      git(repoRoot, 'config', 'user.email', 't@t.t');
      git(repoRoot, 'config', 'user.name', 't');
      writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
      git(repoRoot, 'add', '.');
      git(repoRoot, 'commit', '-q', '-m', 'base');
      // Create the feature branch ref pointing at a real commit in the MAIN
      // checkout — as if SWE's commit had already landed on the shared ref.
      git(repoRoot, 'branch', 'fix/already-reaped');
      const sha = git(repoRoot, 'rev-parse', 'refs/heads/fix/already-reaped');

      const db = tempDB();
      db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [repoRoot]);
      db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
              VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
      db.run(
        `INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, commit_sha, repo, created_at, updated_at)
         VALUES (1, 'fix/already-reaped', 't', 'd', 'completed', 's', ?, 'app', datetime('now'), datetime('now'))`,
        [sha],
      );
      const taskId = String(db.get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id);

      const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
      const r = await call(composites.handlers, 'reap_and_review_prep', {
        agent: 'bro', task_ids: [taskId], repo_path: repoRoot,
      });
      assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
      const out = parse(r) as { all_reaped: boolean; reaped: Array<{ reaped: boolean; commit_sha: string }> };
      assert.equal(out.all_reaped, true);
      assert.equal(out.reaped[0]!.reaped, true);
      // The ref still points at the same SHA — the no-op did not move it, and no
      // worktree existed to fetch from (it would have errored if it tried).
      assert.equal(git(repoRoot, 'rev-parse', 'refs/heads/fix/already-reaped'), sha);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('reaps from a linked worktree under the REPO root via update-ref (worktree .git is a file, not a remote) (#156)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'reap-wt-'));
    const repoRoot = join(ws, 'app');
    mkdirSync(repoRoot, { recursive: true });
    const git = (cwd: string, ...a: string[]) =>
      execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    try {
      git(repoRoot, 'init', '-q', '-b', 'main');
      git(repoRoot, 'config', 'user.email', 't@t.t');
      git(repoRoot, 'config', 'user.name', 't');
      writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
      git(repoRoot, 'add', '.');
      git(repoRoot, 'commit', '-q', '-m', 'base');

      // Create the feature branch + a linked worktree UNDER THE REPO ROOT, then
      // commit inside the worktree (the commit only lives on the worktree's
      // branch ref). The main checkout has NO such ref yet.
      const slug = 'wt-feature';
      const branch = `fix/${slug}`;
      const wtPath = join(repoRoot, '.claude', 'worktrees', slug);
      git(repoRoot, 'worktree', 'add', '-q', '-b', branch, wtPath, 'main');
      writeFileSync(join(wtPath, 'b.txt'), 'two\n');
      git(wtPath, 'add', '.');
      git(wtPath, 'commit', '-q', '-m', 'swe work');
      const sha = git(wtPath, 'rev-parse', 'HEAD');

      // Detach the worktree's branch so the main checkout's branch ref is the
      // only place the reap can set it — and prove update-ref (not fetch-from-
      // worktree) is what makes the SHA visible on refs/heads/<branch>.
      git(wtPath, 'checkout', '-q', '--detach');
      git(repoRoot, 'branch', '-q', '-D', branch);

      const db = tempDB();
      db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [repoRoot]);
      db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
              VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
      db.run(
        `INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, commit_sha, repo, created_at, updated_at)
         VALUES (1, ?, 't', 'd', 'completed', 's', ?, 'app', datetime('now'), datetime('now'))`,
        [branch, sha],
      );
      const taskId = String(db.get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id);

      const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
      const r = await call(composites.handlers, 'reap_and_review_prep', {
        agent: 'bro', task_ids: [taskId], repo_path: repoRoot,
      });
      assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
      const out = parse(r) as { all_reaped: boolean; reaped: Array<{ reaped: boolean }> };
      assert.equal(out.all_reaped, true);
      assert.equal(out.reaped[0]!.reaped, true);
      // The branch ref now resolves to the worktree commit in the main checkout.
      assert.equal(git(repoRoot, 'rev-parse', `refs/heads/${branch}`), sha);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});



describe('intent_start (#426)', () => {
  it('creates issue + intent + note + branch_id_proposed audit atomically', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');

    const r = await call(composites.handlers, 'intent_start', {
      agent: 'bro',
      objective: 'add export feature',
      intent_verbatim: 'I want to export data as CSV',
      branch_id: 'feat/add-export-feature',
    });
    assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
    const out = parse(r) as { issue_id: number; branch_id: string };
    assert.equal(typeof out.issue_id, 'number');
    assert.equal(out.branch_id, 'feat/add-export-feature');

    const discussions = db.all<{ kind: string; body: string }>(
      `SELECT kind, body FROM discussions WHERE issue_id = ? ORDER BY id ASC`,
      [out.issue_id],
    );
    assert.ok(discussions.some((d) => d.kind === 'note' && d.body.includes('Beginning planning on feat/add-export-feature')));
    assert.ok(discussions.some((d) => d.kind === 'intent' && d.body.includes('I want to export data as CSV')));

    const auditRows = db.all<{ event_type: string; branch_id: string }>(
      `SELECT event_type, branch_id FROM audit WHERE issue_id = ?`,
      [out.issue_id],
    );
    assert.ok(auditRows.some((a) => a.event_type === 'branch_id_proposed' && a.branch_id === 'feat/add-export-feature'));

    const issue = db.get<{ objective: string; status: string }>(
      `SELECT objective, status FROM issues WHERE id = ?`,
      [out.issue_id],
    );
    assert.equal(issue!.objective, 'add export feature');
    assert.equal(issue!.status, 'open');

    db.close();
  });

  it('rejects non-bro caller', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'intent_start', {
      agent: 'swe',
      objective: 'do thing',
      intent_verbatim: 'x',
      branch_id: 'feat/do-thing',
    });
    assert.equal(r.isError, true);
    assert.equal(parse(r)['error'], 'forbidden');
  });

  it('rejects invalid branch_id', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'intent_start', {
      agent: 'bro',
      objective: 'do thing',
      intent_verbatim: 'x',
      branch_id: 'not valid branch',
    });
    assert.equal(r.isError, true);
    assert.match(parse(r)['error'] as string, /conventional format/);
  });

  it('rolls back all writes when the transaction fails mid-way', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');

    // Poison the audit table so the 4th write (audit_log) throws.
    db.run(`DROP TABLE audit`);

    const r = await call(composites.handlers, 'intent_start', {
      agent: 'bro',
      objective: 'rollback test',
      intent_verbatim: 'test rollback',
      branch_id: 'feat/rollback-test',
    });
    assert.equal(r.isError, true);

    // If the transaction rolled back, no issue was created.
    const issues = db.all<{ id: number }>(`SELECT id FROM issues WHERE id != -1`);
    assert.equal(issues.length, 0, 'transaction must roll back: no issue row must survive');

    db.close();
  });
});

describe('headless_fallback_record (#426)', () => {
  it('writes audit + note atomically; defaults to most recent open issue', async () => {
    const db = tempDB();
    const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');

    const issueId = Number((parse(await call(issues.handlers, 'issue_create', {
      labels: ['Bug', 'Priority: High'],
      agent: 'bro', objective: 'headless fallback target', description: 'x',
    }))['id']));

    const r = await call(composites.handlers, 'headless_fallback_record', {
      agent: 'bro',
      question: 'Should we use feat/ or fix/ prefix?',
      chosen_default: 'feat/',
      skill: 'tmb_planning',
    });
    assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
    const out = parse(r) as { issue_id: number; written: string[] };
    assert.equal(out.issue_id, issueId);
    assert.deepEqual(out.written, ['audit', 'note']);

    const auditRows = db.all<{ event_type: string; content_json: string }>(
      `SELECT event_type, content_json FROM audit WHERE issue_id = ?`,
      [issueId],
    );
    const fallbackRow = auditRows.find((a) => a.event_type === 'headless_fallback');
    assert.ok(fallbackRow, 'headless_fallback audit row must exist');
    const content = JSON.parse(fallbackRow!.content_json) as { skill: string; chosen_default: string };
    assert.equal(content.skill, 'tmb_planning');
    assert.equal(content.chosen_default, 'feat/');

    const notes = db.all<{ kind: string; body: string }>(
      `SELECT kind, body FROM discussions WHERE issue_id = ? AND kind = 'note'`,
      [issueId],
    );
    assert.ok(notes.some((n) => n.body.includes('tmb_planning') && n.body.includes('feat/')));

    db.close();
  });

  it('falls back to system issue (-1) when no open issue exists', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');

    const r = await call(composites.handlers, 'headless_fallback_record', {
      agent: 'bro',
      question: 'Which base branch?',
      chosen_default: 'dev',
      skill: 'tmb_recovery',
    });
    assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
    const out = parse(r) as { issue_id: number };
    assert.equal(out.issue_id, -1, 'must target system issue when no open issues exist');

    db.close();
  });

  it('respects explicit issue_id override', async () => {
    const db = tempDB();
    const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');

    await call(issues.handlers, 'issue_create', { labels: ['Bug', 'Priority: High'], agent: 'bro', objective: 'issue A', description: 'x' });
    const issueB = Number((parse(await call(issues.handlers, 'issue_create', {
      labels: ['Bug', 'Priority: High'],
      agent: 'bro', objective: 'issue B', description: 'x',
    }))['id']));

    // Pass an explicit issue_id pointing to B even though there's a newer issue.
    const r = await call(composites.handlers, 'headless_fallback_record', {
      agent: 'bro',
      question: 'Which branch?',
      chosen_default: 'fix/',
      skill: 'tmb_recovery',
      issue_id: issueB,
    });
    assert.ok(!r.isError);
    const out = parse(r) as { issue_id: number };
    assert.equal(out.issue_id, issueB);

    db.close();
  });

  it('rolls back when the second write (note) fails', async () => {
    const db = tempDB();
    const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');

    const issueId = Number((parse(await call(issues.handlers, 'issue_create', {
      labels: ['Bug', 'Priority: High'],
      agent: 'bro', objective: 'rollback test', description: 'x',
    }))['id']));

    // Poison discussions so the second write throws mid-transaction.
    db.run(`DROP TABLE discussions`);

    const r = await call(composites.handlers, 'headless_fallback_record', {
      agent: 'bro',
      question: 'Which branch?',
      chosen_default: 'feat/',
      skill: 'tmb_planning',
      issue_id: issueId,
    });
    assert.equal(r.isError, true);

    // The audit row must also be absent (rolled back).
    const auditRows = db.all<{ id: number }>(
      `SELECT id FROM audit WHERE issue_id = ? AND event_type = 'headless_fallback'`,
      [issueId],
    );
    assert.equal(auditRows.length, 0, 'transaction must roll back: no audit row must survive');

    db.close();
  });

  it('rejects non-bro caller', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'headless_fallback_record', {
      agent: 'swe', question: 'q', chosen_default: 'x', skill: 'tmb_planning',
    });
    assert.equal(r.isError, true);
    assert.equal(parse(r)['error'], 'forbidden');
  });
});

describe('intent_start + headless_intent_start non-duplication (#426)', () => {
  it('calling intent_start then headless_intent_start on same issue produces no duplicate intent rows', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');

    // First: intent_start (interactive path) creates the issue + intent row.
    const r1 = await call(composites.handlers, 'intent_start', {
      agent: 'bro',
      objective: 'dup guard test',
      intent_verbatim: 'add CSV export',
      branch_id: 'feat/dup-guard-test',
    });
    assert.ok(!r1.isError);
    const { issue_id } = parse(r1) as { issue_id: number; branch_id: string };

    // Second: headless_intent_start on the same issue with the same verbatim.
    const r2 = await call(composites.handlers, 'headless_intent_start', {
      agent: 'bro',
      issue_id,
      branch_id: 'feat/dup-guard-test',
      intent_verbatim: 'add CSV export',
      fallback_summary: 'headless retry',
    });
    assert.ok(!r2.isError);
    // The written array must NOT include 'intent' (it was de-duped).
    const out2 = parse(r2) as { written: string[] };
    assert.ok(!out2.written.includes('intent'), `intent must not be re-written; got: ${JSON.stringify(out2.written)}`);

    // Exactly one intent row with this verbatim must exist.
    const intentRows = db.all<{ id: number }>(
      `SELECT id FROM discussions
        WHERE issue_id = ? AND kind = 'intent' AND body = ?`,
      [issue_id, 'Human intent verbatim: "add CSV export"'],
    );
    assert.equal(intentRows.length, 1, 'exactly one intent row must exist after both calls');

    db.close();
  });
});

describe('filesToDirs (#300)', () => {
  it('derives unique dirs from a typed files[] array', () => {
    const files = [
      'src/api/handler.ts',
      'src/api/util.ts',
      'docs/guide.md',
      'README.md',
    ];
    assert.deepEqual(filesToDirs(files).sort(), ['', 'docs', 'src/api']);
  });
});

function seedTask(db: TrajectoryDB, opts: { repo?: string | null; spec: string; files?: string[] }): number {
  if (opts.repo) {
    db.run(`INSERT OR IGNORE INTO repos (name, path) VALUES (?, ?)`, [opts.repo, `/tmp/${opts.repo}`]);
  }
  db.run(
    `INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
     VALUES (1, 'brief test obj', 'd', 'open', datetime('now'), datetime('now'))`,
  );
  db.run(
    `INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, files, commit_sha, repo, created_at, updated_at)
     VALUES (1, 'fix/1-brief', 'brief task', 'd', 'open', ?, ?, 'abc123def', ?, datetime('now'), datetime('now'))`,
    [opts.spec, JSON.stringify(opts.files ?? []), opts.repo ?? null],
  );
  const row = db.get<{ id: number }>('SELECT last_insert_rowid() AS id');
  db.run(
    `INSERT INTO discussions (issue_id, author, kind, body, created_at)
     VALUES (1, 'bro', 'decision', 'Use approach B', datetime('now'))`,
  );
  return row!.id;
}

describe('task_brief (#300)', () => {
  const SPEC = ['## Files', '- `src/api/handler.ts` — edit', '', '## Success Criteria', '- works'].join('\n');

  it('bundles task meta + spec + discussions; flags world model unavailable when graph is null', async () => {
    const db = tempDB();
    const id = seedTask(db, { repo: 'app', spec: SPEC });
    const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
    const r = (await tools.handlers['task_brief']!({ agent: 'swe', task_id: id })) as RawResult;
    const out = parse(r) as Record<string, unknown>;
    assert.equal(out['task_id'], id);
    assert.equal(out['branch_id'], 'fix/1-brief');
    assert.equal(out['spec_body'], SPEC);
    assert.equal(out['commit_sha'], 'abc123def', 'commit_sha in brief (pr-reviewer needs it for the diff)');
    assert.equal(out['world_model_warning'], 'world-model-unavailable');
    const disc = out['task_discussions'] as Array<{ kind: string; body: string }>;
    assert.ok(disc.some((d) => d.kind === 'decision' && d.body === 'Use approach B'));
    db.close();
  });

  it('populates scope_world_model from the typed files[] dirs via the graph', async () => {
    const db = tempDB();
    const id = seedTask(db, { repo: 'app', spec: SPEC, files: ['src/api/handler.ts'] });
    // Stub graph: only allDirectoriesForRepo is exercised by task_brief.
    const stubGraph = {
      allDirectoriesForRepo: () => [
        { key: 'app:src/api', repo: 'app', path: 'src/api', parent_path: 'src', summary: 'api layer', summary_source: 'readme', summary_updated_at: null, file_count: 3 },
        { key: 'app:src/api/v2', repo: 'app', path: 'src/api/v2', parent_path: 'src/api', summary: 'v2 handlers', summary_source: 'llm', summary_updated_at: null, file_count: 1 },
      ],
    } as unknown as Parameters<typeof compositeTools>[2];
    const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', stubGraph);
    const r = (await tools.handlers['task_brief']!({ agent: 'swe', task_id: id })) as RawResult;
    const out = parse(r) as Record<string, unknown>;
    assert.equal(out['world_model_warning'], undefined);
    const scope = out['scope_world_model'] as Array<{ dir: string; summary: string | null; children: Array<{ path: string }> }>;
    const apiDir = scope.find((sc) => sc.dir === 'src/api');
    assert.ok(apiDir, 'src/api in scope');
    assert.equal(apiDir!.summary, 'api layer');
    assert.ok(apiDir!.children.some((c) => c.path === 'src/api/v2'), 'child surfaced');
    db.close();
  });

  it('errors on a missing task', async () => {
    const db = tempDB();
    const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
    const r = (await tools.handlers['task_brief']!({ agent: 'swe', task_id: 99999 })) as RawResult;
    assert.ok(r.isError);
    assert.match(parse(r)['error'] as string, /No task/);
    db.close();
  });

  it('bounds discussions: decision/intent kept full, other kinds truncated + capped', async () => {
    const db = tempDB();
    const id = seedTask(db, { repo: 'app', spec: SPEC });
    const longBody = 'x'.repeat(2000);
    db.run(
      `INSERT INTO discussions (issue_id, author, kind, body, created_at)
       VALUES (1, 'bro', 'decision', ?, datetime('now', '+1 second'))`,
      [longBody],
    );
    for (let i = 0; i < 12; i++) {
      db.run(
        `INSERT INTO discussions (issue_id, author, kind, body, created_at)
         VALUES (1, 'swe', 'note', ?, datetime('now', ?))`,
        [`note ${i}`, `+${10 + i} seconds`],
      );
    }
    db.run(
      `INSERT INTO discussions (issue_id, author, kind, body, created_at)
       VALUES (1, 'swe', 'note', ?, datetime('now', '+30 seconds'))`,
      [longBody],
    );
    const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
    const r = (await tools.handlers['task_brief']!({ agent: 'swe', task_id: id })) as RawResult;
    const out = parse(r) as Record<string, unknown>;
    const disc = out['task_discussions'] as Array<{ kind: string; body: string; truncated?: boolean }>;

    const longDecision = disc.find((d) => d.kind === 'decision' && d.body.length > 1000);
    assert.ok(longDecision, 'a long decision is present');
    assert.equal(longDecision!.body.length, 2000, 'decision body kept full');
    assert.equal(longDecision!.truncated, undefined, 'decision not truncated');

    const truncatedNote = disc.find((d) => d.truncated === true);
    assert.ok(truncatedNote, 'the long note was truncated');
    assert.ok(truncatedNote!.body.length < 700, 'truncated body capped near 500 + pointer');
    assert.match(truncatedNote!.body, /truncated; discussion_search\(issue_id=1\)/);

    const noteCount = disc.filter((d) => d.kind === 'note').length;
    assert.ok(noteCount <= 8, `non-full kinds capped to last 8 (got ${noteCount})`);
    db.close();
  });
});

describe('plan_task (#157)', () => {
  const SPEC = ['## Description', 'do the thing', '', '## Success Criteria', '- works'].join('\n');

  // Build a real git repo with an `origin/main` remote-tracking ref. The DB's
  // default plugin_config pr_target is 'main', so the composite branches from
  // origin/main unless an explicit `base` is passed.
  function makeRepo(): { ws: string; repoRoot: string; git: (cwd: string, ...a: string[]) => string } {
    const ws = mkdtempSync(join(tmpdir(), 'plan-task-'));
    const repoRoot = join(ws, 'app');
    mkdirSync(repoRoot, { recursive: true });
    const git = (cwd: string, ...a: string[]) =>
      execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    git(repoRoot, 'init', '-q', '-b', 'main');
    git(repoRoot, 'config', 'user.email', 't@t.t');
    git(repoRoot, 'config', 'user.name', 't');
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    git(repoRoot, 'add', '.');
    git(repoRoot, 'commit', '-q', '-m', 'base');
    // Fabricate the remote-tracking ref the composite branches from.
    git(repoRoot, 'update-ref', 'refs/remotes/origin/main', git(repoRoot, 'rev-parse', 'HEAD'));
    return { ws, repoRoot, git };
  }

  function seedIssue(db: TrajectoryDB, repoRoot: string): void {
    db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [repoRoot]);
    db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
            VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
  }

  it('happy path: writes decision + task + branch + worktree and returns the spawn-ready shape', async () => {
    const { ws, repoRoot, git } = makeRepo();
    try {
      const db = tempDB();
      seedIssue(db, repoRoot);
      const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));

      const r = await call(composites.handlers, 'plan_task', {
        agent: 'bro',
        issue_id: 1,
        branch_id: 'feat/the-thing',
        decision_body: 'Chosen approach: build X because Y; trade-off Z.',
        task: {
          title: 'Do X',
          description: 'implement X',
          spec_body: SPEC,
          files: ['src/x.ts'],
          verification: ['bun run build'],
          repo: 'app',
        },
      });
      assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
      const out = parse(r) as Record<string, unknown>;

      assert.equal(typeof out['task_id'], 'number');
      assert.equal(out['branch_id'], 'feat/the-thing');
      assert.equal(out['repo'], 'app');
      assert.equal(out['slug'], 'the-thing');
      assert.equal(out['git_setup'], 'created');
      assert.equal(out['worktree_path'], join(repoRoot, '.claude', 'worktrees', 'the-thing'));
      assert.equal(out['diagnostic'], undefined);

      // Decision discussion written.
      const decision = db.get<{ body: string; author: string }>(
        `SELECT body, author FROM discussions WHERE issue_id = 1 AND kind = 'decision' LIMIT 1`,
      );
      assert.ok(decision);
      assert.match(decision!.body, /Chosen approach/);
      assert.equal(decision!.author, 'bro');

      // Task row written with typed fields.
      const task = db.get<{ id: number; status: string; files: string; verification: string; repo: string }>(
        `SELECT id, status, files, verification, repo FROM tasks WHERE id = ?`,
        [out['task_id']],
      );
      assert.ok(task);
      assert.equal(task!.status, 'pending');
      assert.deepEqual(JSON.parse(task!.files), ['src/x.ts']);
      assert.deepEqual(JSON.parse(task!.verification), ['bun run build']);

      // planning_complete audit + bro agent_run row written.
      const audit = db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM audit WHERE issue_id = 1 AND event_type = 'planning_complete'`,
      );
      assert.equal(audit!.c, 1);
      const run = db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM agent_runs WHERE task_id = ? AND agent_type = 'bro'`,
        [out['task_id']],
      );
      assert.equal(run!.c, 1);

      // Branch ref + worktree created on disk.
      assert.equal(git(repoRoot, 'rev-parse', '--verify', 'refs/heads/feat/the-thing').length, 40);
      const wtList = git(repoRoot, 'worktree', 'list', '--porcelain');
      assert.match(wtList, /the-thing/);
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('idempotent re-run reuses the existing branch + worktree (git_setup: reused)', async () => {
    const { ws, repoRoot } = makeRepo();
    try {
      const db = tempDB();
      seedIssue(db, repoRoot);
      // Two issues sharing one branch_id: the (issue_id, branch_id) UNIQUE
      // constraint means a re-run must use a DIFFERENT issue. The git setup,
      // keyed on branch_id/slug, is what must be idempotent.
      db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
              VALUES (2, 'o2', 'd', 'open', datetime('now'), datetime('now'))`);
      const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
      const baseArgs = {
        agent: 'bro',
        branch_id: 'feat/reuse-me',
        decision_body: 'approach: reuse path; trade-off none.',
        task: {
          description: 'd',
          spec_body: SPEC,
          files: ['src/x.ts'],
          verification: ['true'],
          repo: 'app',
        },
      };
      const first = parse(await call(composites.handlers, 'plan_task', { ...baseArgs, issue_id: 1 }));
      assert.equal(first['git_setup'], 'created');

      const second = parse(await call(composites.handlers, 'plan_task', { ...baseArgs, issue_id: 2 }));
      assert.equal(second['git_setup'], 'reused', 'existing branch + worktree reused, not error');
      assert.equal(second['worktree_path'], first['worktree_path']);
      assert.notEqual(second['task_id'], first['task_id']);
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('git failure keeps the task (git_setup: error + diagnostic, DB not rolled back)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'plan-task-nogit-'));
    try {
      const db = tempDB();
      // Point the repo at a non-git directory so the branch command fails.
      const notARepo = join(ws, 'notgit');
      mkdirSync(notARepo, { recursive: true });
      db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [notARepo]);
      db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
              VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
      const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));

      const r = await call(composites.handlers, 'plan_task', {
        agent: 'bro',
        issue_id: 1,
        branch_id: 'feat/no-git',
        decision_body: 'approach: x; trade-off y.',
        task: {
          description: 'd',
          spec_body: SPEC,
          files: ['src/x.ts'],
          verification: ['true'],
          repo: 'app',
        },
      });
      assert.ok(!r.isError, 'composite returns ok — git failure is fail-soft, not a tool error');
      const out = parse(r) as Record<string, unknown>;
      assert.equal(out['git_setup'], 'error');
      assert.ok(typeof out['diagnostic'] === 'string' && (out['diagnostic'] as string).length > 0);

      // The task survives — the DB row is the source of truth.
      const task = db.get<{ id: number }>(`SELECT id FROM tasks WHERE id = ?`, [out['task_id']]);
      assert.ok(task, 'task row persisted despite the git failure');
      const decision = db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM discussions WHERE issue_id = 1 AND kind = 'decision'`,
      );
      assert.equal(decision!.c, 1, 'decision discussion persisted');
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('rejects a non-bro caller', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'plan_task', {
      agent: 'swe',
      issue_id: 1,
      branch_id: 'feat/nope',
      decision_body: 'x',
      task: { description: 'd', spec_body: SPEC, files: ['a'], verification: ['true'] },
    });
    assert.equal(r.isError, true);
    db.close();
  });
});
