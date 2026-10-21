import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrajectoryDB } from '../db.js';
import { pinScanEnv, tempDB } from './helpers.js';
import { compositeTools, filesToDirs, scopeCheckCommit, scopeSurface } from '../tools/composites.js';
import { GraphHolder, type WorldModelGraph } from '../graph.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';
import { discussionTools } from '../tools/discussions.js';
import { auditTools } from '../tools/audit.js';
import { embed } from '../embeddings/model.js';
import { upsertRepoRemotes } from '../repos/remotes.js';

const scanPin = pinScanEnv();
after(() => scanPin.restore());

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

describe('task_retry', () => {
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
    await call(audit.handlers, 'audit_append', {
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

    const retry = await call(composites.handlers, 'task_retry', {
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

  it('records task_retry_attempted and task_effort_raised with the calling agent', async () => {
    const db = tempDB();
    const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const caller = 'bro';

    const issueId = Number(parse(await call(issues.handlers, 'issue_create', {
      labels: ['Bug', 'Priority: High'],
      agent: 'bro', objective: 'retry audit author', description: 'x',
    }))['id']);
    db.run(
      `INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, effort, created_at, updated_at)
       VALUES (?, 'fix/audit-author', '', 'd', 'failed', 's', 'medium', datetime('now'), datetime('now'))`,
      [issueId],
    );
    const failedId = db.get<{ id: number }>(`SELECT id FROM tasks WHERE branch_id = 'fix/audit-author'`)!.id;

    const retry = await call(composites.handlers, 'task_retry', {
      agent: caller,
      failed_task_id: String(failedId),
      new_branch_id: 'fix/audit-author-v2',
      corrected_spec_body: 'fixed approach',
      retry_rationale: 'raise effort',
      description: 'retry desc',
      effort: 'high',
    });
    assert.equal(retry.isError, undefined, JSON.stringify(parse(retry)));

    const attempted = db.get<{ from_node: string }>(
      `SELECT from_node FROM audit WHERE issue_id = ? AND event_type = 'task_retry_attempted'`,
      [issueId],
    )!;
    assert.equal(attempted.from_node, caller);
    const raised = db.get<{ from_node: string; content_json: string }>(
      `SELECT from_node, content_json FROM audit WHERE issue_id = ? AND event_type = 'task_effort_raised'`,
      [issueId],
    )!;
    assert.equal(raised.from_node, caller);
    const content = JSON.parse(raised.content_json) as { from: string; to: string; failed_task_id: number };
    assert.equal(content.from, 'medium');
    assert.equal(content.to, 'high');
    assert.equal(content.failed_task_id, failedId);
    db.close();
  });

  it('copies files, verification and prompt_bearing from the failed task', async () => {
    const db = tempDB();
    const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');

    const issueId = Number(parse(await call(issues.handlers, 'issue_create', {
      labels: ['Bug', 'Priority: High'],
      agent: 'bro', objective: 'retry fences', description: 'x',
    }))['id']);
    const filesJson = JSON.stringify(['src/a.ts', 'agents/swe.md']);
    const verificationJson = JSON.stringify(['npm test', 'bash tests/l1-lint/dist-fresh.sh']);
    db.run(
      `INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body,
                          prompt_bearing, files, verification, created_at, updated_at)
       VALUES (?, 'fix/fenced', '', 'd', 'failed', 's', 1, ?, ?, datetime('now'), datetime('now'))`,
      [issueId, filesJson, verificationJson],
    );
    const failed = db.get<{ id: number; files: string; verification: string; prompt_bearing: number }>(
      `SELECT id, files, verification, prompt_bearing FROM tasks WHERE branch_id = 'fix/fenced'`,
    )!;

    const retry = await call(composites.handlers, 'task_retry', {
      agent: 'bro',
      failed_task_id: String(failed.id),
      new_branch_id: 'fix/fenced-v2',
      corrected_spec_body: 'fixed approach',
      retry_rationale: 'retry keeps fences',
      description: 'retry desc',
    });
    assert.equal(retry.isError, undefined, JSON.stringify(parse(retry)));
    const newId = (parse(retry) as { task_id: number }).task_id;
    const row = db.get<{ files: string; verification: string; prompt_bearing: number }>(
      `SELECT files, verification, prompt_bearing FROM tasks WHERE id = ?`,
      [newId],
    )!;
    assert.equal(row.files, failed.files);
    assert.equal(row.verification, failed.verification);
    assert.equal(row.prompt_bearing, failed.prompt_bearing);
    assert.equal(row.files, filesJson);
    assert.equal(row.verification, verificationJson);
    assert.equal(row.prompt_bearing, 1);
    db.close();
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
    await call(audit.handlers, 'audit_append', {
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

    const r = await call(composites.handlers, 'task_retry', {
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
    await call(audit.handlers, 'audit_append', {
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
    const retryWithOverride = await call(composites.handlers, 'task_retry', {
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
    const retryInherited = await call(composites.handlers, 'task_retry', {
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
    const r = await call(composites.handlers, 'task_retry', {
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
    const r = await call(composites.handlers, 'task_retry', {
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
      await call(audit.handlers, 'audit_append', {
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
      const r = await call(composites.handlers, 'task_retry', {
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

    const denied = await call(composites.handlers, 'task_retry', {
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
    await call(audit.handlers, 'audit_append', {
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
      await call(audit.handlers, 'audit_append', {
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

      seedReviewedCommit(db, issueId, taskId, 'abc1234');

      const r = await call(composites.handlers, 'bro_atomic_close', {
        agent: 'bro',
        task_id: taskId,
        commit_sha: 'abc1234',
        verification_summary: 'ok',
        close_issue_if_last_task: true,
        waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test',
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
    upsertRepoRemotes(db, 'app', [{ name: 'origin', provider: 'github', url: 'https://github.com/owner/repo.git' }]);
    db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"auto"')`);
    const savedEnv = process.env.TMB_DISABLE_REMOTE_SYNC;
    delete process.env.TMB_DISABLE_REMOTE_SYNC;
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
      await call(audit.handlers, 'audit_append', {
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

      seedReviewedCommit(db, issueId, taskId, 'abc1234');

      const r = await call(composites.handlers, 'bro_atomic_close', {
        agent: 'bro', task_id: taskId, commit_sha: 'abc1234', verification_summary: 'ok',
        close_issue_if_last_task: true, waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test', _spawnFn: spawnFn,
      });
      assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
      assert.equal(parse(r)['issue_closed'], true);

      const closeCall = spawnCalls.find((c) => c.args.includes('issue') && c.args.includes('close'));
      assert.ok(closeCall, `expected a remote 'issue close' spawn; got ${JSON.stringify(spawnCalls)}`);
      assert.equal(closeCall!.cmd, 'gh', 'github remote closes via gh');
      assert.ok(closeCall!.args.includes('42'), 'remote close must target gh_iid 42');
      assert.deepEqual((parse(r)['remote'] as Record<string, unknown>)['synced'], true);
    } finally {
      if (savedEnv === undefined) delete process.env.TMB_DISABLE_REMOTE_SYNC;
      else process.env.TMB_DISABLE_REMOTE_SYNC = savedEnv;
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

// A prior bro verification of the commit followed by a pr-reviewer pass: the
// review evidence close_issue_if_last_task requires before it closes an issue.
function seedReviewedCommit(db: TrajectoryDB, issueId: string, taskId: string, sha: string): void {
  const earlier = new Date(Date.now() - 60_000).toISOString();
  const later = new Date(Date.now() - 30_000).toISOString();
  db.run(
    `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, 'bro', 'bro_verification_pass', 'ok', ?, ?)`,
    [issueId, JSON.stringify({ task_id: Number(taskId), commit_sha: sha }), earlier],
  );
  db.run(
    `INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, created_at) VALUES (?, 1, 'pr-reviewer', 'pass', 1, ?)`,
    [taskId, later],
  );
}

describe('scopeCheckCommit (#157)', () => {
  it('covers listed dirs (a file entry covers its directory, a trailing slash the directory itself); flags the rest', () => {
    const ws = mkdtempSync(join(tmpdir(), 'scopecheck-'));
    const git = (cwd: string, ...a: string[]) =>
      execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    try {
      git(ws, 'init', '-q', '-b', 'main');
      git(ws, 'config', 'user.email', 't@t.t');
      git(ws, 'config', 'user.name', 't');
      writeFileSync(join(ws, 'seed.txt'), 'seed\n');
      git(ws, 'add', '.');
      git(ws, 'commit', '-q', '-m', 'base');
      git(ws, 'update-ref', 'refs/remotes/origin/dev', git(ws, 'rev-parse', 'HEAD'));

      mkdirSync(join(ws, 'src'), { recursive: true });
      mkdirSync(join(ws, 'dist'), { recursive: true });
      writeFileSync(join(ws, 'src', 'a.ts'), 'a\n');
      writeFileSync(join(ws, 'dist', 'index.js'), 'i\n');
      writeFileSync(join(ws, 'rogue.ts'), 'r\n');
      git(ws, 'add', '.');
      git(ws, 'commit', '-q', '-m', 'work');
      const sha = git(ws, 'rev-parse', 'HEAD');

      const res = scopeCheckCommit(ws, 'origin/dev', sha, ['src/b.ts', 'dist/']);
      assert.equal(res.checked, true);
      assert.deepEqual(res.outOfScope, ['rogue.ts'], 'dist/ covers dist/index.js; src/b.ts covers src/; rogue.ts is out');
      assert.equal(res.baseMoved, false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('returns checked:false with a reason when the repo/commit is unresolvable', () => {
    const ws = mkdtempSync(join(tmpdir(), 'scopecheck-nogit-'));
    try {
      const res = scopeCheckCommit(ws, 'origin/dev', 'deadbeef', ['src/a.ts']);
      assert.equal(res.checked, false);
      assert.ok(typeof res.reason === 'string' && res.reason.length > 0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('bro_atomic_close — scope gate (#157)', () => {
  // Build a real repo with an origin/dev ref, a base commit, and a work commit
  // that changes `changedFiles`. Returns the work commit SHA + a DB seeded with
  // a completed task whose typed files[] is `taskFiles`.
  async function setup(
    taskFiles: string[],
    changedFiles: string[],
    opts: { withRemote?: boolean; devAdvance?: string[]; sibling?: string[] } = {},
  ): Promise<{
    db: TrajectoryDB;
    composites: ReturnType<typeof compositeTools>;
    taskId: string;
    issueId: string;
    sha: string;
    baseSha: string;
    siblingSha: string | null;
    cleanup: () => void;
  }> {
    const withRemote = opts.withRemote !== false;
    const ws = mkdtempSync(join(tmpdir(), 'bac-scope-'));
    const repoRoot = join(ws, 'app');
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(join(ws, '.claude', 'tmb'), { recursive: true });
    const dbPath = join(ws, '.claude', 'tmb', 'trajectory.db');
    const git = (cwd: string, ...a: string[]) =>
      execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

    git(repoRoot, 'init', '-q', '-b', 'dev');
    git(repoRoot, 'config', 'user.email', 't@t.t');
    git(repoRoot, 'config', 'user.name', 't');
    writeFileSync(join(repoRoot, 'seed.txt'), 'seed\n');
    git(repoRoot, 'add', '.');
    git(repoRoot, 'commit', '-q', '-m', 'base');
    // A remoteless repo (withRemote:false) exercises the local-<base> fallback:
    // the scope gate must diff against the local parent ref, not origin/dev.
    if (withRemote) git(repoRoot, 'update-ref', 'refs/remotes/origin/dev', git(repoRoot, 'rev-parse', 'HEAD'));

    const baseSha = git(repoRoot, 'rev-parse', 'HEAD');
    const commitFiles = (paths: string[], message: string): string => {
      for (const rel of paths) {
        const abs = join(repoRoot, rel);
        mkdirSync(join(abs, '..'), { recursive: true });
        writeFileSync(abs, `${rel} ${message}\n`);
      }
      git(repoRoot, 'add', '.');
      git(repoRoot, 'commit', '-q', '-m', message);
      return git(repoRoot, 'rev-parse', 'HEAD');
    };

    // A sibling branch the task is stacked on (its recorded base).
    let siblingSha: string | null = null;
    if (opts.sibling) {
      git(repoRoot, 'checkout', '-q', '-b', 'feat/sibling');
      siblingSha = commitFiles(opts.sibling, 'sibling');
      if (withRemote) git(repoRoot, 'update-ref', 'refs/remotes/origin/feat/sibling', siblingSha);
    }

    // Put the work commit on a feature branch so the local `dev` ref stays at
    // the base — the remoteless fallback then diffs a real parent...work range.
    git(repoRoot, 'checkout', '-q', '-b', 'feat/work');
    const sha = commitFiles(changedFiles, 'work');

    // dev advances with unrelated files after the task branched.
    if (opts.devAdvance) {
      git(repoRoot, 'checkout', '-q', 'dev');
      const devTip = commitFiles(opts.devAdvance, 'dev advance');
      if (withRemote) git(repoRoot, 'update-ref', 'refs/remotes/origin/dev', devTip);
      git(repoRoot, 'checkout', '-q', 'feat/work');
    }

    const db = tempDB();
    db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'dev')`, [repoRoot]);
    const issues = issueTools(db, dbPath);
    const tasks = taskTools(db);
    const composites = compositeTools(db, dbPath);
    const discussions = discussionTools(db);
    const audit = auditTools(db);

    const issueId = String((parse(await call(issues.handlers, 'issue_create', {
      labels: ['Bug', 'Priority: High'],
      agent: 'bro', objective: 'scope gate', description: 'x',
    }))['id']));
    await call(discussions.handlers, 'discussion_append', {
      agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
    });
    await call(audit.handlers, 'audit_append', {
      agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
      from_node: 'bro', branch_id: 'feat/scope', summary: 's',
    });
    const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
      agent: 'bro', issue_id: issueId,
      waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
      tasks: [{ branch_id: 'feat/scope', description: 'd', spec_body: 's', repo: 'app' }],
    }));
    const taskId = String(created[0]!.id);
    db.run(`UPDATE tasks SET parent_branch_id=?, files=? WHERE id=?`, [
      opts.sibling ? 'feat/sibling' : 'dev',
      JSON.stringify(taskFiles),
      taskId,
    ]);
    await call(tasks.handlers, 'task_update_status', {
      agent: 'swe', task_id: taskId, status: 'completed', commit_sha: sha.slice(0, 12),
    });

    return {
      db, composites, taskId, issueId, sha, baseSha, siblingSha,
      cleanup: () => { db.close(); rmSync(ws, { recursive: true, force: true }); },
    };
  }

  it('closes when every changed file is within files[]', async () => {
    const { db, composites, taskId, sha, cleanup } = await setup(['src/a.ts'], ['src/a.ts']);
    try {
      const r = await call(composites.handlers, 'bro_atomic_close', {
        agent: 'bro', task_id: taskId, commit_sha: sha.slice(0, 12), verification_summary: 'ok',
      });
      assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
      const row = db.get<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [taskId]);
      assert.equal(row!.status, 'closed');
    } finally {
      cleanup();
    }
  });

  it('a dir-prefix files[] entry (dist/) covers files beneath it (dist/index.js)', async () => {
    const { db, composites, taskId, sha, cleanup } = await setup(['dist/'], ['dist/index.js']);
    try {
      const r = await call(composites.handlers, 'bro_atomic_close', {
        agent: 'bro', task_id: taskId, commit_sha: sha.slice(0, 12), verification_summary: 'ok',
      });
      assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
      const row = db.get<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [taskId]);
      assert.equal(row!.status, 'closed');
    } finally {
      cleanup();
    }
  });

  it('refuses to close an out-of-scope commit, names the path, leaves the task open', async () => {
    const { db, composites, taskId, sha, cleanup } = await setup(['src/a.ts'], ['src/a.ts', 'rogue.ts']);
    try {
      const r = await call(composites.handlers, 'bro_atomic_close', {
        agent: 'bro', task_id: taskId, commit_sha: sha.slice(0, 12), verification_summary: 'ok',
      });
      assert.equal(r.isError, true);
      assert.match(parse(r)['error'] as string, /rogue\.ts/);
      assert.match(parse(r)['error'] as string, /waive_scope_gate=true/);
      const row = db.get<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [taskId]);
      assert.equal(row!.status, 'completed', 'task stays open when the gate rejects');
    } finally {
      cleanup();
    }
  });

  it('waive_scope_gate=true closes an out-of-scope commit and logs the waive', async () => {
    const { db, composites, taskId, issueId, sha, cleanup } = await setup(['src/a.ts'], ['src/a.ts', 'rogue.ts']);
    try {
      const r = await call(composites.handlers, 'bro_atomic_close', {
        agent: 'bro', task_id: taskId, commit_sha: sha.slice(0, 12), verification_summary: 'ok',
        waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test',
      });
      assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
      const row = db.get<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [taskId]);
      assert.equal(row!.status, 'closed');
      const waive = db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM audit WHERE issue_id = ? AND event_type = 'scope_gate_waived'`,
        [issueId],
      );
      assert.equal(waive!.c, 1, 'waive audit note recorded');
    } finally {
      cleanup();
    }
  });

  it('dev advancing with unrelated files after the task base does not count: close passes', async () => {
    const { db, composites, taskId, sha, cleanup } = await setup(['src/a.ts'], ['src/a.ts'], {
      devAdvance: ['docs/elsewhere.md', 'scripts/hooks/other.sh'],
    });
    try {
      const r = await call(composites.handlers, 'bro_atomic_close', {
        agent: 'bro', task_id: taskId, commit_sha: sha.slice(0, 12), verification_summary: 'ok',
      });
      assert.ok(!r.isError, `dev's own commits must not be extras, got: ${JSON.stringify(parse(r))}`);
      assert.equal(parse(r)['base_moved'], false);
      const row = db.get<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [taskId]);
      assert.equal(row!.status, 'closed');
    } finally {
      cleanup();
    }
  });

  it('refusal names only the task commit path outside files[], grouped by surface', async () => {
    const { composites, taskId, sha, cleanup } = await setup(
      ['src/a.ts'],
      ['src/a.ts', 'scripts/hooks/rogue.sh'],
      { devAdvance: ['docs/elsewhere.md'] },
    );
    try {
      const r = await call(composites.handlers, 'bro_atomic_close', {
        agent: 'bro', task_id: taskId, commit_sha: sha.slice(0, 12), verification_summary: 'ok',
      });
      assert.equal(r.isError, true);
      const out = parse(r);
      assert.deepEqual(out['extras_by_surface'], { scripts: { count: 1, paths: ['scripts/hooks/rogue.sh'] } });
      assert.match(out['error'] as string, /scripts \(1\): scripts\/hooks\/rogue\.sh/);
      assert.doesNotMatch(out['error'] as string, /elsewhere/);
      assert.match(out['error'] as string, /scope_waiver_reason/);
    } finally {
      cleanup();
    }
  });

  it('waive_scope_gate without a scope_waiver_reason of 10+ chars is refused', async () => {
    const { db, composites, taskId, sha, cleanup } = await setup(['src/a.ts'], ['src/a.ts', 'rogue.ts']);
    try {
      for (const reason of [undefined, 'short']) {
        const r = await call(composites.handlers, 'bro_atomic_close', {
          agent: 'bro', task_id: taskId, commit_sha: sha.slice(0, 12), verification_summary: 'ok',
          waive_scope_gate: true, ...(reason ? { scope_waiver_reason: reason } : {}),
        });
        assert.equal(r.isError, true);
        assert.match(parse(r)['error'] as string, /scope_waiver_reason/);
      }
      const row = db.get<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [taskId]);
      assert.equal(row!.status, 'completed');
    } finally {
      cleanup();
    }
  });

  it('a waiver records the accepted paths, reason, base_moved, recorded_base and merge_base; task_brief exposes scope', async () => {
    const { db, composites, taskId, issueId, sha, baseSha, siblingSha, cleanup } = await setup(
      ['src/a.ts'],
      ['src/a.ts', 'tests/rogue.test.ts'],
      { sibling: ['docs/sibling.md'] },
    );
    try {
      const r = await call(composites.handlers, 'bro_atomic_close', {
        agent: 'bro', task_id: taskId, commit_sha: sha.slice(0, 12), verification_summary: 'ok',
        waive_scope_gate: true, scope_waiver_reason: 'sibling docs land with the stack; test needed',
      });
      assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
      const out = parse(r);
      assert.equal(out['base_moved'], true);
      assert.equal(out['recorded_base'], siblingSha);
      assert.equal(out['merge_base'], baseSha);
      assert.deepEqual(out['extras_accepted'], ['docs/sibling.md', 'tests/rogue.test.ts']);

      const waive = db.get<{ summary: string; content_json: string }>(
        `SELECT summary, content_json FROM audit WHERE issue_id = ? AND event_type = 'scope_gate_waived'`,
        [issueId],
      );
      const payload = JSON.parse(waive!.content_json) as Record<string, unknown>;
      assert.deepEqual(payload['accepted_paths'], ['docs/sibling.md', 'tests/rogue.test.ts']);
      assert.equal(payload['reason'], 'sibling docs land with the stack; test needed');
      assert.equal(payload['base_moved'], true);
      assert.equal(payload['recorded_base'], siblingSha);
      assert.equal(payload['merge_base'], baseSha);

      const brief = parse(await call(composites.handlers, 'task_brief', { agent: 'pr-reviewer', task_id: Number(taskId) }));
      assert.deepEqual(brief['scope'], {
        files: ['src/a.ts'],
        extras_accepted: ['docs/sibling.md', 'tests/rogue.test.ts'],
        base_moved: true,
      });
    } finally {
      cleanup();
    }
  });

  it('base_moved is reported without extras when the recorded base differs from the merge-base', async () => {
    const { composites, taskId, sha, cleanup } = await setup(['src/', 'docs/'], ['src/a.ts'], { sibling: ['docs/sibling.md'] });
    try {
      const r = await call(composites.handlers, 'bro_atomic_close', {
        agent: 'bro', task_id: taskId, commit_sha: sha.slice(0, 12), verification_summary: 'ok',
      });
      assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
      assert.equal(parse(r)['base_moved'], true);
      const brief = parse(await call(composites.handlers, 'task_brief', { agent: 'bro', task_id: Number(taskId) }));
      assert.deepEqual(brief['scope'], { files: ['src/', 'docs/'], extras_accepted: [], base_moved: true });
    } finally {
      cleanup();
    }
  });

  it('fails closed when the repo/commit cannot be resolved (no git checkout)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'bac-nogit-'));
    const notARepo = join(ws, 'notgit');
    mkdirSync(notARepo, { recursive: true });
    mkdirSync(join(ws, '.claude', 'tmb'), { recursive: true });
    const dbPath = join(ws, '.claude', 'tmb', 'trajectory.db');
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [notARepo]);
    const issues = issueTools(db, dbPath);
    const tasks = taskTools(db);
    const composites = compositeTools(db, dbPath);
    const discussions = discussionTools(db);
    const audit = auditTools(db);
    try {
      const issueId = String((parse(await call(issues.handlers, 'issue_create', {
        labels: ['Bug', 'Priority: High'], agent: 'bro', objective: 'fail closed', description: 'x',
      }))['id']));
      await call(discussions.handlers, 'discussion_append', {
        agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
      });
      await call(audit.handlers, 'audit_append', {
        agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
        from_node: 'bro', branch_id: 'feat/fc', summary: 's',
      });
      const created = parseBatch(await call(tasks.handlers, 'task_create_batch', {
        agent: 'bro', issue_id: issueId,
        waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
        waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
        waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
        tasks: [{ branch_id: 'feat/fc', description: 'd', spec_body: 's', repo: 'app' }],
      }));
      const taskId = String(created[0]!.id);
      db.run(`UPDATE tasks SET parent_branch_id='dev', files=? WHERE id=?`, [JSON.stringify(['src/a.ts']), taskId]);
      await call(tasks.handlers, 'task_update_status', {
        agent: 'swe', task_id: taskId, status: 'completed', commit_sha: 'abcdef1',
      });

      const r = await call(composites.handlers, 'bro_atomic_close', {
        agent: 'bro', task_id: taskId, commit_sha: 'abcdef1', verification_summary: 'ok',
      });
      assert.equal(r.isError, true, 'fail-closed: unresolvable repo/commit must not silently close');
      assert.match(parse(r)['error'] as string, /cannot resolve/);
      assert.match(parse(r)['error'] as string, /waive_scope_gate=true/);
      const row = db.get<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [taskId]);
      assert.equal(row!.status, 'completed', 'task stays open on fail-closed');
    } finally {
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('remoteless repo: scope gate diffs against the local parent ref and still closes (#1063)', async () => {
    // No origin/dev exists — resolveBaseRef falls back to local dev, so the gate
    // computes its three-dot diff against the local parent ref rather than
    // fail-closing.
    const { db, composites, taskId, sha, cleanup } = await setup(['src/a.ts'], ['src/a.ts'], { withRemote: false });
    try {
      const r = await call(composites.handlers, 'bro_atomic_close', {
        agent: 'bro', task_id: taskId, commit_sha: sha.slice(0, 12), verification_summary: 'ok',
      });
      assert.ok(!r.isError, `remoteless close must pass via the local base fallback, got: ${JSON.stringify(parse(r))}`);
      const row = db.get<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [taskId]);
      assert.equal(row!.status, 'closed');
    } finally {
      cleanup();
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
    await call(audit.handlers, 'audit_append', {
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

describe('intent_start — per-repo milestone default + repo param (#15)', () => {
  it('defaults the created issue milestone to the sole repo\'s sole OPEN milestone', async () => {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path) VALUES ('app', '/tmp/app')`);
    db.run(`INSERT INTO milestones (name, repo, state) VALUES ('v0.10.0', 'app', 'open')`);
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');

    const r = await call(composites.handlers, 'intent_start', {
      agent: 'bro',
      objective: 'intent default milestone',
      intent_verbatim: 'do the thing',
      branch_id: 'feat/intent-default-ms',
    });
    assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
    const issueId = parse(r)['issue_id'];

    const row = db.get<{ milestone: string | null; repo: string | null }>(
      'SELECT milestone, repo FROM issues WHERE id = ?',
      [issueId],
    );
    assert.equal(row?.milestone, 'v0.10.0', 'intent_start applies the sole open milestone');
    assert.equal(row?.repo, 'app', 'sole repo bound when repo omitted');

    db.close();
  });

  it('stays NULL when the repo has no open milestone', async () => {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path) VALUES ('app', '/tmp/app')`);
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
    assert.equal(row?.milestone, null, 'no open milestone → null');

    db.close();
  });

  it('binds issues.repo to an explicit repo arg and resolves its milestone', async () => {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path) VALUES ('frontend', '/tmp/frontend')`);
    db.run(`INSERT INTO repos (name, path) VALUES ('backend', '/tmp/backend')`);
    db.run(`INSERT INTO milestones (name, repo, state) VALUES ('v2.0.0', 'backend', 'open')`);
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');

    const r = await call(composites.handlers, 'intent_start', {
      agent: 'bro',
      objective: 'intent explicit repo',
      intent_verbatim: 'do the thing',
      branch_id: 'feat/intent-explicit-repo',
      repo: 'backend',
    });
    assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
    const issueId = parse(r)['issue_id'];

    const row = db.get<{ milestone: string | null; repo: string | null }>(
      'SELECT milestone, repo FROM issues WHERE id = ?',
      [issueId],
    );
    assert.equal(row?.repo, 'backend', 'explicit repo bound on the issue');
    assert.equal(row?.milestone, 'v2.0.0', 'milestone resolved from the explicit repo');

    db.close();
  });

  it('returns a named error for an explicit repo with no matching repos row', async () => {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path) VALUES ('app', '/tmp/app')`);
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');

    const r = await call(composites.handlers, 'intent_start', {
      agent: 'bro',
      objective: 'intent unknown repo',
      intent_verbatim: 'do the thing',
      branch_id: 'feat/intent-unknown-repo',
      repo: 'ghost',
    });
    assert.ok(r.isError, 'unknown repo must be a named error');
    assert.match(parse(r)['error'] as string, /repo "ghost" has no matching repos row/);

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
    await call(audit.handlers, 'audit_append', {
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

describe('pr_monitor_worktree — containment', () => {
  it('refuses a repo_path outside the project with outside_project', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/proj/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'pr_monitor_worktree', {
      agent: 'pr-reviewer', commit_sha: 'abc1234', repo_path: '/var/elsewhere', command: 'echo ok',
    });
    assert.equal(r.isError, true);
    const out = parse(r);
    assert.equal(out['error'], 'outside_project');
    assert.equal(out['path'], '/var/elsewhere');
    assert.equal(out['project_root'], '/tmp/proj');
  });

  it('checks the commit out under the repo, never in /tmp', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'prmon-'));
    try {
      const git = (...a: string[]) => execFileSync('git', ['-C', ws, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 't@t.t');
      git('config', 'user.name', 't');
      writeFileSync(join(ws, 'a.txt'), 'one\n');
      git('add', '.');
      git('commit', '-q', '-m', 'base');
      const sha = git('rev-parse', 'HEAD');
      const db = tempDB();
      const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
      const r = await call(composites.handlers, 'pr_monitor_worktree', {
        agent: 'pr-reviewer', commit_sha: sha, repo_path: ws, command: 'pwd',
      });
      assert.ok(!r.isError, JSON.stringify(parse(r)));
      assert.equal(parse(r)['worktree'], `${ws}/.claude/worktrees/pr-review-${sha}`);
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('worktree_commits_fetch', () => {
  it('rejects non-bro caller', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'worktree_commits_fetch', {
      agent: 'swe', task_ids: ['1'], repo_path: '/tmp',
    });
    assert.equal(r.isError, true);
    assert.equal(parse(r)['error'], 'forbidden');
  });

  it('rejects empty task_ids', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'worktree_commits_fetch', {
      agent: 'bro', task_ids: [], repo_path: '/tmp',
    });
    assert.equal(r.isError, true);
    assert.match(parse(r)['error'] as string, /non-empty/);
  });

  it('rejects relative repo_path', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'worktree_commits_fetch', {
      agent: 'bro', task_ids: ['1'], repo_path: 'relative',
    });
    assert.equal(r.isError, true);
    assert.match(parse(r)['error'] as string, /absolute/);
  });

  it('surfaces a missing task as isError with the raw id preserved (#283)', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'worktree_commits_fetch', {
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
      const r = await call(composites.handlers, 'worktree_commits_fetch', {
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
      const r = await call(composites.handlers, 'worktree_commits_fetch', {
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

    // Poison the audit table so the 4th write (audit_append) throws.
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

  it('persists supplied labels on the issue row', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'intent_start', {
      agent: 'bro',
      objective: 'labelled intent',
      intent_verbatim: 'x',
      branch_id: 'fix/labelled-intent',
      labels: ['Bug', 'Priority: High'],
    });
    assert.ok(!r.isError, JSON.stringify(parse(r)));
    const issueId = (parse(r) as { issue_id: number }).issue_id;
    const row = db.get<{ labels: string | null }>(`SELECT labels FROM issues WHERE id = ?`, [issueId]);
    assert.equal(row!.labels, '["Bug","Priority: High"]');
    db.close();
  });

  it('derives the taxonomy default labels when omitted', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'intent_start', {
      agent: 'bro',
      objective: 'unlabelled intent',
      intent_verbatim: 'x',
      branch_id: 'fix/unlabelled-intent',
    });
    assert.ok(!r.isError, JSON.stringify(parse(r)));
    const issueId = (parse(r) as { issue_id: number }).issue_id;
    const row = db.get<{ labels: string | null }>(`SELECT labels FROM issues WHERE id = ?`, [issueId]);
    assert.notEqual(row!.labels, null);
    const labels = JSON.parse(row!.labels!) as string[];
    const classification = ['Bug', 'Feature', 'Improvement', 'Docs', 'Test', 'Chore'];
    const priority = ['Priority: Urgent', 'Priority: High', 'Priority: Medium', 'Priority: Low'];
    assert.equal(labels.filter((l) => classification.includes(l)).length, 1);
    assert.equal(labels.filter((l) => priority.includes(l)).length, 1);
    db.close();
  });

  it('rejects invalid labels with missing_required_labels', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'intent_start', {
      agent: 'bro',
      objective: 'bad labels',
      intent_verbatim: 'x',
      branch_id: 'fix/bad-labels',
      labels: ['nonsense'],
    });
    assert.equal(r.isError, true);
    assert.match(parse(r)['error'] as string, /missing_required_labels/);
    const count = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM issues WHERE id != -1`);
    assert.equal(count!.n, 0);
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

function seedTask(
  db: TrajectoryDB,
  opts: { repo?: string | null; spec: string; files?: string[]; verification?: string[] },
): number {
  if (opts.repo) {
    db.run(`INSERT OR IGNORE INTO repos (name, path) VALUES (?, ?)`, [opts.repo, `/tmp/${opts.repo}`]);
  }
  db.run(
    `INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
     VALUES (1, 'brief test obj', 'd', 'open', datetime('now'), datetime('now'))`,
  );
  db.run(
    `INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, files, verification, commit_sha, repo, created_at, updated_at)
     VALUES (1, 'fix/1-brief', 'brief task', 'd', 'pending', ?, ?, ?, 'abc123def', ?, datetime('now'), datetime('now'))`,
    [opts.spec, JSON.stringify(opts.files ?? []), JSON.stringify(opts.verification ?? []), opts.repo ?? null],
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
    } as unknown as WorldModelGraph;
    const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', GraphHolder.fixed(stubGraph));
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

  it('emits the typed files[] + verification[] contract; [] for a legacy default-verification row', async () => {
    const db = tempDB();
    const files = ['src/api/handler.ts', 'src/api/'];
    const verification = ['bun test', 'bash tests/l1-lint/dist-fresh.sh'];
    const id = seedTask(db, { repo: 'app', spec: SPEC, files, verification });
    const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
    const r = (await tools.handlers['task_brief']!({ agent: 'swe', task_id: id })) as RawResult;
    const out = parse(r) as Record<string, unknown>;
    assert.deepEqual(out['files'], files, 'typed files[] round-trips');
    assert.deepEqual(out['verification'], verification, 'typed verification[] round-trips');
    db.close();

    // Legacy row: verification unset → schema DEFAULT '[]' → [] without error.
    const db2 = tempDB();
    const legacyId = seedTask(db2, { repo: 'app', spec: SPEC, files });
    const tools2 = compositeTools(db2, '/tmp/.claude/tmb/trajectory.db', null);
    const lr = (await tools2.handlers['task_brief']!({ agent: 'swe', task_id: legacyId })) as RawResult;
    const lout = parse(lr) as Record<string, unknown>;
    assert.deepEqual(lout['verification'], [], 'unset verification yields []');
    db2.close();
  });

  it('verification_run is null without a recorded run, else the latest run with its commands in order', async () => {
    const db = tempDB();
    const id = seedTask(db, { repo: 'app', spec: SPEC, verification: ['npm test', 'bash lint.sh'] });
    const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
    const brief = async (): Promise<Record<string, unknown>> =>
      parse((await tools.handlers['task_brief']!({ agent: 'pr-reviewer', task_id: id })) as RawResult) as Record<string, unknown>;

    assert.equal((await brief())['verification_run'], null, 'no run recorded yet');

    db.run(
      `INSERT INTO verification_runs (id, task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out)
       VALUES (7, ?, 'old0000', 'gate', '2026-10-01T00:00:00.000Z', '2026-10-01T00:01:00.000Z', 1, 900, 0),
              (8, ?, 'abc123def', 'gate', '2026-10-02T00:00:00.000Z', '2026-10-02T00:03:00.000Z', 0, 1200, 0)`,
      [id, id],
    );
    db.run(
      `INSERT INTO verification_run_commands (run_id, ordinal, command, exit_code, elapsed_s, output_tail)
       VALUES (8, 2, 'bash lint.sh', 0, 0.5, 'ok'), (8, 1, 'npm test', 0, 170.25, 'pass'), (7, 1, 'npm test', 1, 3, 'fail')`,
    );

    const out = await brief();
    assert.deepEqual(out['verification'], ['npm test', 'bash lint.sh'], 'verification[] commands are unchanged');
    assert.deepEqual(out['verification_run'], {
      run_id: 8,
      commit_sha: 'abc123def',
      source: 'gate',
      started_at: '2026-10-02T00:00:00.000Z',
      finished_at: '2026-10-02T00:03:00.000Z',
      exit_code: 0,
      timed_out: false,
      budget_s: 1200,
      commands: [
        { ordinal: 1, command: 'npm test', exit_code: 0, elapsed_s: 170.25 },
        { ordinal: 2, command: 'bash lint.sh', exit_code: 0, elapsed_s: 0.5 },
      ],
    });
    db.close();
  });

  it('a swe caller records the swe_brief_fetched sentinel once; bro and pr-reviewer record none', async () => {
    const db = tempDB();
    const id = seedTask(db, { repo: 'app', spec: SPEC });
    const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
    const sentinels = (): Array<{ from_node: string; content_json: string }> =>
      db.all<{ from_node: string; content_json: string }>(
        `SELECT from_node, content_json FROM audit WHERE event_type = 'swe_brief_fetched'`,
      );

    await tools.handlers['task_brief']!({ agent: 'bro', task_id: id });
    await tools.handlers['task_brief']!({ agent: 'pr-reviewer', task_id: id });
    assert.equal(sentinels().length, 0, 'bro and pr-reviewer write no sentinel');

    await tools.handlers['task_brief']!({ agent: 'swe', task_id: id });
    const rows = sentinels();
    assert.equal(rows.length, 1, 'first swe call writes exactly one row');
    assert.equal(rows[0]!.from_node, 'swe');
    assert.deepEqual(JSON.parse(rows[0]!.content_json), { task_id: id, agent_type: 'swe' });

    await tools.handlers['task_brief']!({ agent: 'swe', task_id: id });
    assert.equal(sentinels().length, 1, 'a second swe call adds none');
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

describe('task_provision (#157)', () => {
  const SPEC = ['## Description', 'do the thing', '', '## Success Criteria', '- works'].join('\n');

  // Build a real git repo with an `origin/main` remote-tracking ref. The repos
  // row carries target_branch='main' (the sole source of truth, #980), so the
  // composite branches from origin/main unless an explicit `base` is passed.
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
    db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'main')`, [repoRoot]);
    db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
            VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
  }

  it('refuses a repo outside the project with outside_project and writes nothing', async () => {
    const { ws, repoRoot, git } = makeRepo();
    try {
      const db = tempDB();
      seedIssue(db, repoRoot);
      const composites = compositeTools(db, '', null, { host: 'claude', projectRoot: join(ws, 'elsewhere') });
      mkdirSync(join(ws, 'elsewhere'));
      const r = await call(composites.handlers, 'task_provision', {
        agent: 'bro', issue_id: 1, branch_id: 'feat/outside', decision_body: 'Chosen approach: outside the project.',
        task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
      });
      assert.equal(r.isError, true);
      assert.equal(parse(r)['error'], 'outside_project');
      assert.equal(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM tasks')!.c, 0, 'no task row');
      assert.throws(() => git(repoRoot, 'rev-parse', '--verify', 'refs/heads/feat/outside'), 'no branch ref');
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('waive_spec_shape writes one per-task spec_shape_gate_waived row in the require-task-spec shape; none without it; a short reason writes nothing', async () => {
    const { ws, repoRoot, git } = makeRepo();
    try {
      const db = tempDB();
      seedIssue(db, repoRoot);
      const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
      const provision = (branch_id: string, extra: Record<string, unknown>) =>
        call(composites.handlers, 'task_provision', {
          agent: 'bro', issue_id: 1, branch_id, decision_body: 'Chosen approach: waive the spec shape.',
          task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
          ...extra,
        });
      const waivers = () => db.all<{ issue_id: number; branch_id: string; from_node: string; content_json: string }>(
        `SELECT issue_id, branch_id, from_node, content_json FROM audit WHERE event_type = 'spec_shape_gate_waived' ORDER BY id`,
      );

      const plain = parse(await provision('feat/no-waiver', {}));
      assert.equal(typeof plain['task_id'], 'number');
      assert.equal(waivers().length, 0, 'no row without waive_spec_shape');

      const waived = parse(await provision('feat/waived', { waive_spec_shape: true, waive_spec_shape_reason: 'spec names no new column' }));
      const rows = waivers();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.issue_id, 1);
      assert.equal(rows[0]!.branch_id, 'feat/waived');
      assert.equal(rows[0]!.from_node, 'bro');
      assert.deepEqual(JSON.parse(rows[0]!.content_json), {
        task_id: waived['task_id'], gate: 'spec_shape', reason: 'spec names no new column', waived_by: 'bro', source: 'task_provision',
      });

      const short = await provision('feat/short-reason', { waive_spec_shape: true, waive_spec_shape_reason: 'short' });
      assert.equal(short.isError, true);
      assert.match(String(parse(short)['error']), /waive_spec_shape_reason/);
      assert.equal(waivers().length, 1);
      assert.throws(() => git(repoRoot, 'rev-parse', '--verify', 'refs/heads/feat/short-reason'), 'no branch ref');
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('accepts session_id when passed or omitted, opens no bro row, and rejects an invalid one writing nothing', async () => {
    const { ws, repoRoot, git } = makeRepo();
    try {
      const db = tempDB();
      seedIssue(db, repoRoot);
      const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
      const provision = (branch_id: string, extra: Record<string, unknown>) =>
        call(composites.handlers, 'task_provision', {
          agent: 'bro', issue_id: 1, branch_id, decision_body: 'Chosen approach: stamp the session.',
          task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
          ...extra,
        });
      const stamped = parse(await provision('feat/session-a', { session_id: '0b5e-4c1d_abcdEF12' }));
      assert.equal(typeof stamped['task_id'], 'number');
      const omitted = parse(await provision('feat/session-b', {}));
      assert.equal(typeof omitted['task_id'], 'number');
      assert.equal(db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM agent_runs WHERE agent_type = 'bro'`)!.c, 0);

      for (const bad of ['short', 'has space in it', 'x'.repeat(65), "evil';--x", 12345678]) {
        const r = await provision('feat/session-bad', { session_id: bad });
        assert.equal(r.isError, true, `session_id ${JSON.stringify(bad)} is rejected`);
        assert.match(String(parse(r)['error']), /session_id must be 8–64 characters/);
      }
      assert.equal(db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM tasks WHERE branch_id = 'feat/session-bad'`)!.c, 0);
      assert.throws(() => git(repoRoot, 'rev-parse', '--verify', 'refs/heads/feat/session-bad'), 'no branch ref');
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('happy path: writes decision + task + branch + worktree and returns the spawn-ready shape', async () => {
    const { ws, repoRoot, git } = makeRepo();
    try {
      const db = tempDB();
      seedIssue(db, repoRoot);
      const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));

      const r = await call(composites.handlers, 'task_provision', {
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
      const task = db.get<{ id: number; status: string; files: string; verification: string; repo: string; parent_branch_id: string }>(
        `SELECT id, status, files, verification, repo, parent_branch_id FROM tasks WHERE id = ?`,
        [out['task_id']],
      );
      assert.ok(task);
      assert.equal(task!.status, 'pending');
      assert.deepEqual(JSON.parse(task!.files), ['src/x.ts']);
      assert.deepEqual(JSON.parse(task!.verification), ['bun run build']);
      // parent_branch_id persisted = the resolved base (repos.target_branch='main' when no explicit base).
      assert.equal(task!.parent_branch_id, 'main', 'parent_branch_id = defaulted base (repos.target_branch)');

      // planning_complete audit written; bro is metered per session, not per task.
      const audit = db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM audit WHERE issue_id = 1 AND event_type = 'planning_complete'`,
      );
      assert.equal(audit!.c, 1);
      const run = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM agent_runs WHERE task_id = ? AND agent_type = 'bro'`, [out['task_id']]);
      assert.equal(run!.c, 0);

      // Branch ref + worktree created on disk.
      assert.equal(git(repoRoot, 'rev-parse', '--verify', 'refs/heads/feat/the-thing').length, 40);
      const wtList = git(repoRoot, 'worktree', 'list', '--porcelain');
      assert.match(wtList, /the-thing/);
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('persists parent_branch_id = explicit base passed to task_provision', async () => {
    const { ws, repoRoot, git } = makeRepo();
    try {
      // Fabricate an origin/dev remote-tracking ref so an explicit base='dev' resolves.
      git(repoRoot, 'update-ref', 'refs/remotes/origin/dev', git(repoRoot, 'rev-parse', 'HEAD'));
      const db = tempDB();
      seedIssue(db, repoRoot);
      const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));

      const r = await call(composites.handlers, 'task_provision', {
        agent: 'bro',
        issue_id: 1,
        branch_id: 'feat/explicit-base',
        base: 'dev',
        decision_body: 'approach: branch from dev; trade-off none.',
        task: {
          description: 'd',
          spec_body: SPEC,
          files: ['src/x.ts'],
          verification: ['true'],
          repo: 'app',
        },
      });
      assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
      const out = parse(r) as Record<string, unknown>;

      const task = db.get<{ parent_branch_id: string }>(
        `SELECT parent_branch_id FROM tasks WHERE id = ?`,
        [out['task_id']],
      );
      assert.ok(task);
      assert.equal(task!.parent_branch_id, 'dev', 'parent_branch_id = explicit base passed');
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
      const first = parse(await call(composites.handlers, 'task_provision', { ...baseArgs, issue_id: 1 }));
      assert.equal(first['git_setup'], 'created');

      assert.equal(first['worktree_reused'], false);

      const second = parse(await call(composites.handlers, 'task_provision', { ...baseArgs, issue_id: 2 }));
      assert.equal(second['git_setup'], 'reused', 'existing branch + worktree reused, not error');
      assert.equal(second['worktree_reused'], true);
      assert.equal(second['worktree_path'], first['worktree_path']);
      assert.notEqual(second['task_id'], first['task_id']);
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('atomicity: base-unresolvable git failure leaves NO task row; retry with a valid base + same branch_id succeeds', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'plan-task-nobase-'));
    try {
      const db = tempDB();
      // A real git repo but WITHOUT the origin/<base> remote-tracking ref, so
      // the base pre-validation fails and the branch is never created.
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
      db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [repoRoot]);
      db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
              VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
      const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));

      const baseTaskArgs = {
        agent: 'bro',
        issue_id: 1,
        branch_id: 'feat/atomic',
        decision_body: 'approach: x; trade-off y.',
        task: {
          description: 'd',
          spec_body: SPEC,
          files: ['src/x.ts'],
          verification: ['true'],
          repo: 'app',
        },
      };

      // base 'no-such-base' has no origin/ ref → error, nothing persisted.
      const r = await call(composites.handlers, 'task_provision', {
        ...baseTaskArgs,
        base: 'no-such-base',
      });
      assert.ok(r.isError, 'unresolvable base must be a tool error');
      assert.match(parse(r)['error'] as string, /does not resolve|No task row was created/);

      // No task row, no decision, no branch ref — the (issue_id, branch_id) slot is free.
      assert.equal(
        db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM tasks WHERE issue_id = 1`)!.c,
        0,
        'no orphan task row after base-unresolvable git failure',
      );
      assert.equal(
        db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM discussions WHERE issue_id = 1 AND kind = 'decision'`)!.c,
        0,
        'no orphan decision after git failure',
      );

      // Retry with a valid base (origin/main, fabricated here) + SAME branch_id succeeds.
      git(repoRoot, 'update-ref', 'refs/remotes/origin/main', git(repoRoot, 'rev-parse', 'HEAD'));
      const retry = await call(composites.handlers, 'task_provision', {
        ...baseTaskArgs,
        base: 'main',
      });
      assert.ok(!retry.isError, `retry with a valid base must succeed: ${JSON.stringify(parse(retry))}`);
      const out = parse(retry) as Record<string, unknown>;
      assert.equal(out['branch_id'], 'feat/atomic');
      assert.equal(
        db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM tasks WHERE issue_id = 1`)!.c,
        1,
        'retry creates exactly one task row',
      );
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('atomicity: repo-unresolvable git failure leaves NO task row; retry with a valid repo + same branch_id succeeds', async () => {
    const { ws, repoRoot } = makeRepo();
    try {
      const db = tempDB();
      // Multi-repo workspace: register only 'app' (target_branch='main' so the
      // base resolves on retry). The first call names a repo that does not
      // resolve to a repos.path.
      db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'main')`, [repoRoot]);
      db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
              VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
      const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));

      const baseTaskArgs = {
        agent: 'bro',
        issue_id: 1,
        branch_id: 'feat/repo-atomic',
        decision_body: 'approach: x; trade-off y.',
        task: {
          description: 'd',
          spec_body: SPEC,
          files: ['src/x.ts'],
          verification: ['true'],
        },
      };

      // repo 'ghost' resolves to the literal name 'ghost' (no repos.path) — git
      // commands run against a non-existent dir and fail. Nothing persisted.
      const r = await call(composites.handlers, 'task_provision', {
        ...baseTaskArgs,
        task: { ...baseTaskArgs.task, repo: 'ghost' },
      });
      assert.ok(r.isError, 'unresolvable repo must be a tool error');

      assert.equal(
        db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM tasks WHERE issue_id = 1`)!.c,
        0,
        'no orphan task row after repo-unresolvable git failure',
      );
      assert.equal(
        db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM discussions WHERE issue_id = 1 AND kind = 'decision'`)!.c,
        0,
        'no orphan decision after git failure',
      );

      // Retry with a valid repo + SAME branch_id succeeds.
      const retry = await call(composites.handlers, 'task_provision', {
        ...baseTaskArgs,
        task: { ...baseTaskArgs.task, repo: 'app' },
      });
      assert.ok(!retry.isError, `retry with a valid repo must succeed: ${JSON.stringify(parse(retry))}`);
      const out = parse(retry) as Record<string, unknown>;
      assert.equal(out['repo'], 'app');
      assert.equal(
        db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM tasks WHERE issue_id = 1`)!.c,
        1,
        'retry creates exactly one task row',
      );
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('remoteless repo: base falls back to the local branch, branch created from local ref (#1063)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'plan-task-local-'));
    try {
      const repoRoot = join(ws, 'app');
      mkdirSync(repoRoot, { recursive: true });
      const git = (cwd: string, ...a: string[]) =>
        execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
      // A repo with NO remotes at all: only a local `dev` branch exists.
      git(repoRoot, 'init', '-q', '-b', 'dev');
      git(repoRoot, 'config', 'user.email', 't@t.t');
      git(repoRoot, 'config', 'user.name', 't');
      writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
      git(repoRoot, 'add', '.');
      git(repoRoot, 'commit', '-q', '-m', 'base');
      const localDevSha = git(repoRoot, 'rev-parse', 'refs/heads/dev');

      const db = tempDB();
      db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'dev')`, [repoRoot]);
      db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
              VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
      const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));

      const r = await call(composites.handlers, 'task_provision', {
        agent: 'bro',
        issue_id: 1,
        branch_id: 'feat/local-base',
        base: 'dev',
        decision_body: 'approach: branch from local dev; trade-off none.',
        task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
      });
      assert.ok(!r.isError, `remoteless provision must succeed via the local fallback: ${JSON.stringify(parse(r))}`);

      // Task row created + the new branch points at the LOCAL dev ref.
      assert.equal(db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM tasks WHERE issue_id = 1`)!.c, 1);
      assert.equal(
        git(repoRoot, 'rev-parse', 'refs/heads/feat/local-base'),
        localDevSha,
        'branch created from the local dev ref when no origin exists',
      );
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('origin/<base> wins over a diverging local branch (origin preference unchanged, #1063)', async () => {
    const { ws, repoRoot, git } = makeRepo();
    try {
      // origin/main was fabricated at the base commit in makeRepo. Advance the
      // LOCAL main past it so the two diverge; the branch must follow origin.
      const originMainSha = git(repoRoot, 'rev-parse', 'refs/remotes/origin/main');
      writeFileSync(join(repoRoot, 'a.txt'), 'two\n');
      git(repoRoot, 'add', '.');
      git(repoRoot, 'commit', '-q', '-m', 'local advance');
      const localMainSha = git(repoRoot, 'rev-parse', 'refs/heads/main');
      assert.notEqual(originMainSha, localMainSha, 'precondition: origin/main and local main diverge');

      const db = tempDB();
      seedIssue(db, repoRoot);
      const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));

      const r = await call(composites.handlers, 'task_provision', {
        agent: 'bro',
        issue_id: 1,
        branch_id: 'feat/prefers-origin',
        base: 'main',
        decision_body: 'approach: branch from origin/main; trade-off none.',
        task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
      });
      assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
      assert.equal(
        git(repoRoot, 'rev-parse', 'refs/heads/feat/prefers-origin'),
        originMainSha,
        'branch follows origin/main, not the diverged local main',
      );
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('neither origin/<base> nor local <base> resolves: error names both forms, no task row (#1063)', async () => {
    const { ws, repoRoot } = makeRepo();
    try {
      const db = tempDB();
      seedIssue(db, repoRoot);
      const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));

      const r = await call(composites.handlers, 'task_provision', {
        agent: 'bro',
        issue_id: 1,
        branch_id: 'feat/no-base',
        base: 'ghost-base',
        decision_body: 'approach: x; trade-off y.',
        task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
      });
      assert.ok(r.isError, 'an unresolvable base must be a tool error');
      const msg = parse(r)['error'] as string;
      assert.match(msg, /origin\/ghost-base/, 'error names the tried origin form');
      assert.match(msg, /local 'ghost-base'/, 'error names the tried local form');
      assert.equal(
        db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM tasks WHERE issue_id = 1`)!.c,
        0,
        'no orphan task row when neither base ref resolves',
      );
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  describe('existing branch policy', () => {
    const provisionArgs = (branch_id: string, extra: Record<string, unknown> = {}) => ({
      agent: 'bro', issue_id: 1, branch_id, decision_body: 'approach: existing-branch policy; trade-off none.',
      task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
      ...extra,
    });
    // Advance origin/main by one commit without touching the local checkout.
    function advanceOrigin(repoRoot: string, git: (cwd: string, ...a: string[]) => string): string {
      const tree = git(repoRoot, 'rev-parse', 'HEAD^{tree}');
      const sha = git(repoRoot, 'commit-tree', tree, '-p', git(repoRoot, 'rev-parse', 'refs/remotes/origin/main'), '-m', 'origin advance');
      git(repoRoot, 'update-ref', 'refs/remotes/origin/main', sha);
      return sha;
    }
    // A local branch carrying one commit that base does not have.
    function divergedBranch(repoRoot: string, git: (cwd: string, ...a: string[]) => string, branch: string): void {
      const tree = git(repoRoot, 'rev-parse', 'HEAD^{tree}');
      const sha = git(repoRoot, 'commit-tree', tree, '-p', git(repoRoot, 'rev-parse', 'refs/remotes/origin/main'), '-m', 'stale work');
      git(repoRoot, 'update-ref', `refs/heads/${branch}`, sha);
    }

    it('fresh branch_id: git_setup created, worktree_reused false', async () => {
      const { ws, repoRoot } = makeRepo();
      try {
        const db = tempDB();
        seedIssue(db, repoRoot);
        const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
        const out = parse(await call(composites.handlers, 'task_provision', provisionArgs('feat/fresh')));
        assert.equal(out['git_setup'], 'created');
        assert.equal(out['worktree_reused'], false);
        db.close();
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('existing branch behind the base tip is fast-forwarded and reported reused', async () => {
      const { ws, repoRoot, git } = makeRepo();
      try {
        git(repoRoot, 'branch', 'feat/behind', 'refs/remotes/origin/main');
        const newTip = advanceOrigin(repoRoot, git);
        const db = tempDB();
        seedIssue(db, repoRoot);
        const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
        const r = await call(composites.handlers, 'task_provision', provisionArgs('feat/behind'));
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        assert.equal(parse(r)['git_setup'], 'reused');
        assert.equal(parse(r)['worktree_reused'], false);
        assert.equal(git(repoRoot, 'rev-parse', 'refs/heads/feat/behind'), newTip, 'fast-forwarded to the base tip');
        db.close();
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('existing branch checked out in its worktree is fast-forwarded there', async () => {
      const { ws, repoRoot, git } = makeRepo();
      try {
        git(repoRoot, 'branch', 'feat/checked-out', 'refs/remotes/origin/main');
        git(repoRoot, 'worktree', 'add', '-q', join(repoRoot, '.claude', 'worktrees', 'checked-out'), 'feat/checked-out');
        const newTip = advanceOrigin(repoRoot, git);
        const db = tempDB();
        seedIssue(db, repoRoot);
        const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
        const out = parse(await call(composites.handlers, 'task_provision', provisionArgs('feat/checked-out')));
        assert.equal(out['git_setup'], 'reused');
        assert.equal(out['worktree_reused'], true);
        assert.equal(git(repoRoot, 'rev-parse', 'refs/heads/feat/checked-out'), newTip);
        db.close();
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('branch only on origin, ancestor of base: local ref created at the base tip, reported reused', async () => {
      const { ws, repoRoot, git } = makeRepo();
      try {
        git(repoRoot, 'update-ref', 'refs/remotes/origin/feat/remote-only', git(repoRoot, 'rev-parse', 'refs/remotes/origin/main'));
        const newTip = advanceOrigin(repoRoot, git);
        const db = tempDB();
        seedIssue(db, repoRoot);
        const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
        const out = parse(await call(composites.handlers, 'task_provision', provisionArgs('feat/remote-only')));
        assert.equal(out['git_setup'], 'reused');
        assert.equal(git(repoRoot, 'rev-parse', 'refs/heads/feat/remote-only'), newTip);
        db.close();
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('diverged branch is refused with branch_exists_diverged + distance; nothing written', async () => {
      const { ws, repoRoot, git } = makeRepo();
      try {
        divergedBranch(repoRoot, git, 'feat/stale');
        advanceOrigin(repoRoot, git);
        const before = git(repoRoot, 'rev-parse', 'refs/heads/feat/stale');
        const db = tempDB();
        seedIssue(db, repoRoot);
        const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
        const r = await call(composites.handlers, 'task_provision', provisionArgs('feat/stale'));
        assert.equal(r.isError, true);
        const out = parse(r);
        assert.equal(out['error'], 'branch_exists_diverged');
        assert.equal(out['ref'], 'refs/heads/feat/stale');
        assert.equal(out['base'], 'origin/main');
        assert.equal(out['ahead'], 1);
        assert.equal(out['behind'], 1);
        assert.deepEqual(out['open_prs'], []);
        assert.match(String(out['message']), /branch_id_propose/);
        assert.match(String(out['message']), /reuse_existing/);
        assert.equal(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM tasks')!.c, 0, 'no task row');
        assert.equal(git(repoRoot, 'rev-parse', 'refs/heads/feat/stale'), before, 'ref untouched');
        db.close();
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('diverged refusal names the open PR when the sync gate is on (mocked gh)', async () => {
      const { ws, repoRoot, git } = makeRepo();
      try {
        divergedBranch(repoRoot, git, 'feat/has-pr');
        const db = tempDB();
        seedIssue(db, repoRoot);
        upsertRepoRemotes(db, 'app', [{ name: 'origin', url: 'https://github.com/acme/app.git', provider: 'github' }]);
        db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')`);
        const calls: string[][] = [];
        const spawnFn = (cmd: string, a: string[]) => {
          calls.push([cmd, ...a]);
          return { status: 0, stdout: JSON.stringify([{ number: 42, url: 'https://github.com/acme/app/pull/42' }]), stderr: '' };
        };
        const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
        const r = await call(composites.handlers, 'task_provision', provisionArgs('feat/has-pr', { _spawnFn: spawnFn }));
        const out = parse(r);
        assert.equal(out['error'], 'branch_exists_diverged');
        assert.deepEqual(out['open_prs'], [{ backend: 'gh', number: 42, url: 'https://github.com/acme/app/pull/42' }]);
        assert.match(String(out['message']), /pull\/42/);
        assert.deepEqual(calls[0]!.slice(0, 5), ['gh', 'pr', 'list', '--head', 'feat/has-pr']);
        db.close();
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('sync gate off: no remote call is made for the PR lookup', async () => {
      const { ws, repoRoot, git } = makeRepo();
      try {
        divergedBranch(repoRoot, git, 'feat/gate-off');
        const db = tempDB();
        seedIssue(db, repoRoot);
        upsertRepoRemotes(db, 'app', [{ name: 'origin', url: 'https://github.com/acme/app.git', provider: 'github' }]);
        let called = 0;
        const spawnFn = () => { called++; return { status: 0, stdout: '[]', stderr: '' }; };
        const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
        const out = parse(await call(composites.handlers, 'task_provision', provisionArgs('feat/gate-off', { _spawnFn: spawnFn })));
        assert.equal(out['error'], 'branch_exists_diverged');
        assert.equal(called, 0);
        db.close();
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('reuse_existing keeps a diverged branch as-is and reports reused', async () => {
      const { ws, repoRoot, git } = makeRepo();
      try {
        divergedBranch(repoRoot, git, 'feat/keep-me');
        const before = git(repoRoot, 'rev-parse', 'refs/heads/feat/keep-me');
        const db = tempDB();
        seedIssue(db, repoRoot);
        const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
        const r = await call(composites.handlers, 'task_provision', provisionArgs('feat/keep-me', { reuse_existing: true }));
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        assert.equal(parse(r)['git_setup'], 'reused');
        assert.equal(git(repoRoot, 'rev-parse', 'refs/heads/feat/keep-me'), before, 'diverged ref kept');
        assert.equal(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM tasks')!.c, 1);
        db.close();
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  it('rejects a non-bro caller', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'task_provision', {
      agent: 'swe',
      issue_id: 1,
      branch_id: 'feat/nope',
      decision_body: 'x',
      task: { description: 'd', spec_body: SPEC, files: ['a'], verification: ['true'] },
    });
    assert.equal(r.isError, true);
    db.close();
  });

  it('world-model-cold + no waiver: registry_cold_violation with zero side effects (#44)', async () => {
    const { ws, repoRoot, git } = makeRepo();
    try {
      const db = tempDB({ seedScan: false });
      seedIssue(db, repoRoot);
      const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));

      const r = await call(composites.handlers, 'task_provision', {
        agent: 'bro',
        issue_id: 1,
        branch_id: 'feat/cold-thing',
        decision_body: 'approach: x; trade-off y.',
        task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
      });

      assert.ok(r.isError, 'a cold world model with no waiver must be a tool error');
      const out = parse(r) as Record<string, unknown>;
      assert.equal(out['error'], 'registry_cold_violation');
      assert.match(out['message'] as string, /task_provision/, 'message names the tool');
      assert.match(out['message'] as string, /\/scan|scan_run/, 'message points at /scan or scan_run');

      // No side effects: no task row, no discussion row, no branch ref.
      assert.equal(db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM tasks WHERE issue_id = 1`)!.c, 0, 'no task row');
      assert.equal(db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM discussions WHERE issue_id = 1`)!.c, 0, 'no discussion row');
      let branchExists = true;
      try {
        git(repoRoot, 'rev-parse', '--verify', '--quiet', 'refs/heads/feat/cold-thing');
      } catch {
        branchExists = false;
      }
      assert.equal(branchExists, false, 'no branch ref created');
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('world-model-cold + waiver ≥10 chars: proceeds and records registry_gate_waived (#44)', async () => {
    const { ws, repoRoot } = makeRepo();
    try {
      const db = tempDB({ seedScan: false });
      seedIssue(db, repoRoot);
      const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));

      const r = await call(composites.handlers, 'task_provision', {
        agent: 'bro',
        issue_id: 1,
        branch_id: 'feat/waived-thing',
        decision_body: 'approach: x; trade-off y.',
        waive_registry_gate: true,
        waive_registry_gate_reason: 'scan cannot run in this sandbox',
        task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
      });

      assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
      assert.equal(typeof (parse(r) as Record<string, unknown>)['task_id'], 'number');
      const waived = db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM audit WHERE issue_id = 1 AND event_type = 'registry_gate_waived'`,
      );
      assert.equal(waived!.c, 1, 'registry_gate_waived audit row recorded');
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('world-model-cold + waiver <10 chars: rejected the same as task_create_batch (#44)', async () => {
    const { ws, repoRoot } = makeRepo();
    try {
      const db = tempDB({ seedScan: false });
      seedIssue(db, repoRoot);
      const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));

      const r = await call(composites.handlers, 'task_provision', {
        agent: 'bro',
        issue_id: 1,
        branch_id: 'feat/short-reason',
        decision_body: 'approach: x; trade-off y.',
        waive_registry_gate: true,
        waive_registry_gate_reason: 'too short',
        task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
      });

      assert.ok(r.isError, 'a short waiver reason must be a tool error');
      assert.match(parse(r)['error'] as string, /waive_registry_gate_reason must be a string ≥10 chars/);
      assert.equal(db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM tasks WHERE issue_id = 1`)!.c, 0, 'no task row');
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('warm world model (deep_scan_completed present): behavior unchanged, proceeds (#44)', async () => {
    const { ws, repoRoot } = makeRepo();
    try {
      const db = tempDB(); // default seeds a deep_scan_completed audit row
      seedIssue(db, repoRoot);
      const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));

      const r = await call(composites.handlers, 'task_provision', {
        agent: 'bro',
        issue_id: 1,
        branch_id: 'feat/warm-thing',
        decision_body: 'approach: x; trade-off y.',
        task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
      });

      assert.ok(!r.isError, `expected ok, got: ${JSON.stringify(parse(r))}`);
      assert.equal(typeof (parse(r) as Record<string, unknown>)['task_id'], 'number');
      assert.equal(
        db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM audit WHERE event_type = 'registry_gate_waived'`)!.c,
        0,
        'no waiver audit row on the warm path',
      );
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('task_reopen + task_update_spec', () => {
  const SPEC = ['## Description', 'do the thing', '', '## Success Criteria', '- works'].join('\n');

  function setup(): {
    ws: string;
    repoRoot: string;
    db: TrajectoryDB;
    handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
    git: (cwd: string, ...a: string[]) => string;
  } {
    const ws = mkdtempSync(join(tmpdir(), 'reopen-'));
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
    git(repoRoot, 'update-ref', 'refs/remotes/origin/main', git(repoRoot, 'rev-parse', 'HEAD'));
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'main')`, [repoRoot]);
    db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
            VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
    const handlers = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db')).handlers;
    return { ws, repoRoot, db, handlers, git };
  }

  async function provision(
    handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
    branch_id: string,
  ): Promise<number> {
    const out = parse(await call(handlers, 'task_provision', {
      agent: 'bro', issue_id: 1, branch_id, decision_body: 'approach: lifecycle fixture.',
      task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
    }));
    return out['task_id'] as number;
  }

  const taskRow = (db: TrajectoryDB, id: number) =>
    db.get<{ status: string; files: string; verification: string; spec_body: string; completed_at: string | null }>(
      `SELECT status, files, verification, spec_body, completed_at FROM tasks WHERE id = ?`,
      [id],
    )!;
  const auditOf = (db: TrajectoryDB, eventType: string) =>
    db.all<{ from_node: string; summary: string; content_json: string }>(
      `SELECT from_node, summary, content_json FROM audit WHERE event_type = ? ORDER BY id`,
      [eventType],
    );

  for (const fromStatus of ['closed', 'failed', 'escalated', 'running']) {
    it(`task_reopen: ${fromStatus} → running, fences appended, decision + task_reopened audit`, async () => {
      const { ws, db, handlers } = setup();
      try {
        const id = await provision(handlers, `fix/reopen-${fromStatus}`);
        db.run(`UPDATE tasks SET status = ?, completed_at = datetime('now') WHERE id = ?`, [fromStatus, id]);
        const r = await call(handlers, 'task_reopen', {
          agent: 'bro', task_id: id, reason: 'review found a missing test',
          files_add: ['src/y.ts', 'src/x.ts'], verification_add: ['npm test'],
        });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        const out = parse(r);
        assert.equal(out['from_status'], fromStatus);
        assert.equal(out['status'], 'running');
        const row = taskRow(db, id);
        assert.equal(row.status, 'running');
        assert.equal(row.completed_at, null);
        assert.deepEqual(JSON.parse(row.files), ['src/x.ts', 'src/y.ts'], 'appended, duplicates ignored');
        assert.deepEqual(JSON.parse(row.verification), ['true', 'npm test']);
        const audit = auditOf(db, 'task_reopened');
        assert.equal(audit.length, 1);
        assert.equal(audit[0]!.from_node, 'bro');
        assert.deepEqual(JSON.parse(audit[0]!.content_json), {
          task_id: id, from_status: fromStatus, reason: 'review found a missing test',
          files_add: ['src/y.ts', 'src/x.ts'], verification_add: ['npm test'],
        });
        const decision = db.get<{ body: string }>(
          `SELECT body FROM discussions WHERE kind = 'decision' AND body LIKE 'Task % reopened%'`,
        );
        assert.match(decision!.body, new RegExp(`reopened from ${fromStatus}: review found a missing test`));
        assert.match(decision!.body, /files\[\] \+= src\/y\.ts, src\/x\.ts/);
        db.close();
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  }

  it('task_provision, task_create_batch, task_reopen and task_retry accept session_id and open no per-task bro row', async () => {
    const { ws, db, handlers } = setup();
    try {
      const perTaskBro = () =>
        db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM agent_runs WHERE agent_type = 'bro' AND task_id IS NOT NULL`)!.c;
      const SESSION = 'sess-1234abcd';

      const provisioned = parse(await call(handlers, 'task_provision', {
        agent: 'bro', issue_id: 1, branch_id: 'fix/metered', decision_body: 'approach: session metering fixture.', session_id: SESSION,
        task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
      }));
      const id = provisioned['task_id'] as number;
      assert.ok(id > 0, JSON.stringify(provisioned));

      const WAIVE = 'unit test of session metering';
      const created = parseBatch(await call(taskTools(db).handlers, 'task_create_batch', {
        agent: 'bro', issue_id: '1', session_id: SESSION,
        waive_intent_gate: true, waive_intent_gate_reason: WAIVE, waive_decision_gate: true, waive_decision_gate_reason: WAIVE,
        waive_branch_gate: true, waive_branch_gate_reason: WAIVE, waive_scope_gate: true, waive_scope_gate_reason: WAIVE,
        waive_spec_shape: true, waive_spec_shape_reason: WAIVE,
        tasks: [{ branch_id: 'fix/metered-batch', description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' }],
      }));
      const batchId = created[0]!['id'] as number;

      db.run(`UPDATE tasks SET status = 'closed' WHERE id = ?`, [id]);
      const reopened = await call(handlers, 'task_reopen', { agent: 'bro', task_id: id, reason: 'review failed', session_id: SESSION });
      assert.ok(!reopened.isError, JSON.stringify(parse(reopened)));
      const bad = await call(handlers, 'task_reopen', { agent: 'bro', task_id: id, reason: 'x', session_id: 'short' });
      assert.equal(bad.isError, true);
      assert.match(String(parse(bad)['error']), /session_id must be 8–64 characters/);

      db.run(`UPDATE tasks SET status = 'failed' WHERE id = ?`, [batchId]);
      const retried = parse(await call(handlers, 'task_retry', {
        agent: 'bro', failed_task_id: String(batchId), new_branch_id: 'fix/metered-retry', corrected_spec_body: SPEC,
        retry_rationale: 'retry for session metering', description: 'd', session_id: SESSION,
      }));
      assert.ok((retried['task_id'] as number) > 0, JSON.stringify(retried));

      assert.equal(perTaskBro(), 0, 'no task tool opens a per-task bro row');
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('task_reopen recreates a missing worktree and leaves an existing one alone', async () => {
    const { ws, repoRoot, db, handlers, git } = setup();
    try {
      const id = await provision(handlers, 'fix/rework');
      const wt = join(repoRoot, '.claude', 'worktrees', 'rework');
      git(repoRoot, 'worktree', 'remove', '--force', wt);
      db.run(`UPDATE tasks SET status = 'closed' WHERE id = ?`, [id]);
      const out = parse(await call(handlers, 'task_reopen', { agent: 'bro', task_id: id, reason: 'review failed' }));
      assert.equal(out['worktree_recreated'], true);
      assert.equal(out['worktree_path'], wt);
      assert.match(git(repoRoot, 'worktree', 'list', '--porcelain'), /worktrees\/rework/);

      const again = parse(await call(handlers, 'task_reopen', { agent: 'bro', task_id: id, reason: 'second pass' }));
      assert.equal(again['from_status'], 'running');
      assert.equal(again['worktree_recreated'], false);
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('task_reopen on a pending task moves it to running and creates the missing worktree', async () => {
    const { ws, repoRoot, db, handlers, git } = setup();
    try {
      const id = await provision(handlers, 'fix/undispatched');
      const wt = join(repoRoot, '.claude', 'worktrees', 'undispatched');
      git(repoRoot, 'worktree', 'remove', '--force', wt);
      db.run(`UPDATE tasks SET status = 'pending' WHERE id = ?`, [id]);
      const out = parse(await call(handlers, 'task_reopen', { agent: 'bro', task_id: id, reason: 'dispatch the planned task' }));
      assert.equal(out['from_status'], 'pending');
      assert.equal(out['status'], 'running');
      assert.equal(out['worktree_recreated'], true);
      assert.equal(out['worktree_path'], wt);
      assert.equal(taskRow(db, id).status, 'running');
      assert.match(git(repoRoot, 'worktree', 'list', '--porcelain'), /worktrees\/undispatched/);
      assert.equal(auditOf(db, 'task_reopened').length, 1);
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('task_reopen refuses completed/needs_validation tasks, a closed issue, and a missing reason', async () => {
    const { ws, db, handlers } = setup();
    try {
      const id = await provision(handlers, 'fix/not-reopenable');
      for (const status of ['completed', 'needs_validation']) {
        db.run(`UPDATE tasks SET status = ? WHERE id = ?`, [status, id]);
        const r = await call(handlers, 'task_reopen', { agent: 'bro', task_id: id, reason: 'x' });
        assert.equal(r.isError, true, status);
        assert.match(String(parse(r)['error']), /task_update_spec/);
      }
      db.run(`UPDATE tasks SET status = 'closed' WHERE id = ?`, [id]);
      const noReason = await call(handlers, 'task_reopen', { agent: 'bro', task_id: id, reason: '  ' });
      assert.equal(noReason.isError, true);
      db.run(`UPDATE issues SET status = 'closed' WHERE id = 1`);
      const closedIssue = await call(handlers, 'task_reopen', { agent: 'bro', task_id: id, reason: 'x' });
      assert.equal(closedIssue.isError, true);
      assert.match(String(parse(closedIssue)['error']), /issue 1 is closed/);
      assert.equal(taskRow(db, id).status, 'closed');
      assert.equal(auditOf(db, 'task_reopened').length, 0);
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('task_reopen and task_update_spec reject swe', async () => {
    const { ws, db, handlers } = setup();
    try {
      const id = await provision(handlers, 'fix/role-gate');
      db.run(`UPDATE tasks SET status = 'running' WHERE id = ?`, [id]);
      const reopen = await call(handlers, 'task_reopen', { agent: 'swe', task_id: id, reason: 'x', files_add: ['b'] });
      assert.equal(reopen.isError, true);
      assert.equal(parse(reopen)['error'], 'forbidden');
      const amend = await call(handlers, 'task_update_spec', { agent: 'swe', task_id: id, reason: 'x', files: ['b'] });
      assert.equal(amend.isError, true);
      assert.equal(parse(amend)['error'], 'forbidden');
      assert.deepEqual(JSON.parse(taskRow(db, id).files), ['src/x.ts']);
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('task_update_spec replaces fields and records an old→new summary', async () => {
    const { ws, db, handlers } = setup();
    try {
      const id = await provision(handlers, 'fix/amend');
      const newSpec = `${SPEC}\n- also this`;
      const r = await call(handlers, 'task_update_spec', {
        agent: 'bro', task_id: id, reason: 'typo in the fence',
        files: ['src/x.ts', 'src/z.ts'], verification: ['npm test'], spec_body: newSpec,
      });
      assert.ok(!r.isError, JSON.stringify(parse(r)));
      assert.deepEqual(parse(r)['changed'], ['files', 'verification', 'spec_body']);
      const row = taskRow(db, id);
      assert.deepEqual(JSON.parse(row.files), ['src/x.ts', 'src/z.ts']);
      assert.deepEqual(JSON.parse(row.verification), ['npm test']);
      assert.equal(row.spec_body, newSpec);
      assert.equal(row.status, 'pending', 'status unchanged');
      const audit = auditOf(db, 'task_spec_amended');
      assert.equal(audit.length, 1);
      assert.match(audit[0]!.summary, /files \+1\/-0; verification \+1\/-1; spec_body \d+→\d+ chars/);
      const content = JSON.parse(audit[0]!.content_json) as Record<string, unknown>;
      assert.equal(content['reason'], 'typo in the fence');
      assert.deepEqual((content['changes'] as Record<string, unknown>)['verification'], { added: ['npm test'], removed: ['true'] });
      const decision = db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM discussions WHERE kind = 'decision' AND body LIKE 'Task % spec amended%typo in the fence'`,
      );
      assert.equal(decision!.c, 1);

      const filesOnly = await call(handlers, 'task_update_spec', { agent: 'bro', task_id: id, reason: 'narrow', files: ['src/x.ts'] });
      assert.deepEqual(parse(filesOnly)['changed'], ['files']);
      assert.deepEqual(JSON.parse(taskRow(db, id).verification), ['npm test'], 'untouched field kept');
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('task_update_spec refuses closed/failed/escalated tasks, empty input, and a spec without Success Criteria', async () => {
    const { ws, db, handlers } = setup();
    try {
      const id = await provision(handlers, 'fix/amend-refused');
      const none = await call(handlers, 'task_update_spec', { agent: 'bro', task_id: id, reason: 'x' });
      assert.equal(none.isError, true);
      const badSpec = await call(handlers, 'task_update_spec', { agent: 'bro', task_id: id, reason: 'x', spec_body: '## Description\nno criteria' });
      assert.equal(badSpec.isError, true);
      assert.match(String(parse(badSpec)['error']), /Success Criteria/);
      const emptyFiles = await call(handlers, 'task_update_spec', { agent: 'bro', task_id: id, reason: 'x', files: [] });
      assert.equal(emptyFiles.isError, true);
      for (const status of ['closed', 'failed', 'escalated']) {
        db.run(`UPDATE tasks SET status = ? WHERE id = ?`, [status, id]);
        const r = await call(handlers, 'task_update_spec', { agent: 'bro', task_id: id, reason: 'x', files: ['b'] });
        assert.equal(r.isError, true, status);
        assert.match(String(parse(r)['error']), /task_reopen/);
      }
      assert.deepEqual(JSON.parse(taskRow(db, id).files), ['src/x.ts']);
      assert.equal(auditOf(db, 'task_spec_amended').length, 0);
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('composite discussions route through insertDiscussion + embedAndStore (#986)', () => {
  // The embed is fired non-blocking after the row is written, so it lands a few
  // event-loop turns later. Poll briefly for the embedding row to appear.
  async function waitForEmbeddings(
    db: ReturnType<typeof tempDB>,
    expected: number,
    timeoutMs = 5000,
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let n = 0;
    do {
      n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM discussions_embeddings')?.n ?? 0;
      if (n >= expected) return n;
      await new Promise((r) => setTimeout(r, 50));
    } while (Date.now() < deadline);
    return n;
  }

  it('intent_start: composite-written intent + note become embedded (semantic discussion_search visible)', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');

    const r = await call(composites.handlers, 'intent_start', {
      agent: 'bro',
      objective: 'composite embed test',
      intent_verbatim: 'make composite discussions searchable',
      branch_id: 'feat/composite-embed-test',
    });
    assert.ok(!r.isError, `intent_start must succeed: ${JSON.stringify(parse(r))}`);
    const issueId = parse(r)['issue_id'];

    // The discussion rows themselves always land (transaction committed).
    const discCount = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM discussions WHERE issue_id = ?',
      [issueId],
    )?.n ?? 0;
    assert.equal(discCount, 2, 'intent_start writes one intent + one note discussion');

    // The embed is the gap #986 closes. Assert the embedding rows appear when a
    // model is available; in a model-less CI embed() returns null so the path is
    // a graceful no-op (composite still succeeded above).
    const probe = await embed('model availability probe');
    const embCount = await waitForEmbeddings(db, probe === null ? 0 : 2);
    if (probe === null) {
      assert.equal(embCount, 0, 'no model → embed degrades to FTS-only, composite still ok');
    } else {
      assert.ok(
        embCount >= 2,
        `composite discussions must be embedded so semantic search can find them (got ${embCount})`,
      );
    }

    db.close();
  });

  it('embed failure is non-fatal: the composite transaction still commits', async () => {
    // After a first embed attempt the model loader latches loadFailed when no
    // model is present, so subsequent embed() calls return null. Either way the
    // composite must succeed and its discussion rows must persist — an embed
    // failure must never roll back the transaction.
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');

    const r = await call(composites.handlers, 'intent_start', {
      agent: 'bro',
      objective: 'embed non-fatal test',
      intent_verbatim: 'embed failure must not roll back',
      branch_id: 'feat/embed-non-fatal',
    });
    assert.ok(!r.isError, `composite must commit even if embedding fails: ${JSON.stringify(parse(r))}`);
    const issueId = parse(r)['issue_id'];

    const discCount = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM discussions WHERE issue_id = ?',
      [issueId],
    )?.n ?? 0;
    assert.equal(discCount, 2, 'discussion rows persist regardless of embed outcome');

    db.close();
  });
});

describe('agent_runs lifecycle — rows open with their run and close with their task', () => {
  const SPEC = ['## Files', '- `src/a.ts` — edit', '', '## Success Criteria', '- works'].join('\n');
  type Run = { agent_type: string; started_at: string | null; completed_at: string | null };
  const runs = (db: TrajectoryDB, taskId: number): Run[] =>
    db.all<Run>('SELECT agent_type, started_at, completed_at FROM agent_runs WHERE task_id = ? ORDER BY id', [taskId]);
  let seq = 0;
  const seed = (db: TrajectoryDB): number => {
    const id = seedTask(db, { repo: 'app', spec: SPEC });
    db.run('UPDATE tasks SET branch_id = ? WHERE id = ?', [`fix/runs-${++seq}`, id]);
    return id;
  };
  const openBro = (db: TrajectoryDB, taskId: number): void => {
    db.run(
      `INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at) VALUES (?, 1, 'bro', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'))`,
      [taskId],
    );
  };

  it('task_brief opens one swe row for a swe caller, never a second while it is open, and none for other roles', async () => {
    const db = tempDB();
    const id = seed(db);
    const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);

    await tools.handlers['task_brief']!({ agent: 'pr-reviewer', task_id: id });
    await tools.handlers['task_brief']!({ agent: 'bro', task_id: id });
    assert.equal(runs(db, id).length, 0, 'bro / pr-reviewer briefs open no swe row');

    await tools.handlers['task_brief']!({ agent: 'swe', task_id: id });
    await tools.handlers['task_brief']!({ agent: 'swe', task_id: id });
    const opened = db.all<{ agent_type: string; repo: string | null; started_at: string; completed_at: string | null }>(
      'SELECT agent_type, repo, started_at, completed_at FROM agent_runs WHERE task_id = ?',
      [id],
    );
    assert.equal(opened.length, 1, 'exactly one open swe row');
    assert.equal(opened[0]!.agent_type, 'swe');
    assert.equal(opened[0]!.repo, 'app');
    assert.match(opened[0]!.started_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.equal(opened[0]!.completed_at, null);

    db.run('UPDATE agent_runs SET completed_at = ? WHERE task_id = ?', [new Date().toISOString(), id]);
    await tools.handlers['task_brief']!({ agent: 'swe', task_id: id });
    assert.equal(runs(db, id).length, 2, 'a later spawn opens a fresh row once the first one closed');
    db.close();
  });

  for (const status of ['failed', 'escalated'] as const) {
    it(`task_update_status → ${status} closes every open row of the task (bro and swe)`, async () => {
      const db = tempDB();
      const id = seed(db);
      db.run(`UPDATE tasks SET status = 'running' WHERE id = ?`, [id]);
      const other = seed(db);
      openBro(db, id);
      openBro(db, other);
      const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
      await tools.handlers['task_brief']!({ agent: 'swe', task_id: id });

      const tasks = taskTools(db);
      const agent = status === 'failed' ? 'swe' : 'bro';
      const r = await call(tasks.handlers, 'task_update_status', { agent, task_id: String(id), status });
      assert.ok(!r.isError, JSON.stringify(parse(r)));

      const closed = runs(db, id);
      assert.equal(closed.length, 2);
      assert.ok(closed.every((x) => x.completed_at !== null), 'bro and swe rows are closed');
      const ms = db.get<{ d: number }>(`SELECT duration_ms AS d FROM agent_runs WHERE task_id = ? AND agent_type = 'bro'`, [id])!.d;
      assert.ok(ms >= 59_000, `an unmeasured row takes its window length (got ${ms})`);
      assert.equal(runs(db, other)[0]!.completed_at, null, 'another task keeps its open row');
      db.close();
    });
  }

  it('a non-terminal task_update_status leaves rows open', async () => {
    const db = tempDB();
    const id = seed(db);
    openBro(db, id);
    const tasks = taskTools(db);
    await call(tasks.handlers, 'task_update_status', { agent: 'swe', task_id: String(id), status: 'running' });
    assert.equal(runs(db, id)[0]!.completed_at, null);
    db.close();
  });

  it('bro_atomic_close closes the open bro and swe rows of the task', async () => {
    const db = tempDB();
    const id = seed(db);
    db.run(`UPDATE tasks SET status = 'completed' WHERE id = ?`, [id]);
    openBro(db, id);
    const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
    await tools.handlers['task_brief']!({ agent: 'swe', task_id: id });

    const r = (await tools.handlers['bro_atomic_close']!({
      agent: 'bro', task_id: String(id), commit_sha: 'abc1234', verification_summary: 'ok', waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test',
    })) as RawResult;
    assert.ok(!r.isError, JSON.stringify(parse(r)));
    const after = runs(db, id);
    assert.deepEqual(after.map((x) => x.agent_type), ['bro', 'swe']);
    assert.ok(after.every((x) => x.completed_at !== null), 'no row stays open once the task is closed');
    db.close();
  });

  it('task_recover sweeps rows left open on tasks that are already terminal', async () => {
    const db = tempDB();
    const done = seed(db);
    const failed = seed(db);
    const live = seed(db);
    db.run(`UPDATE tasks SET status = 'closed' WHERE id = ?`, [done]);
    db.run(`UPDATE tasks SET status = 'failed' WHERE id = ?`, [failed]);
    for (const t of [done, failed, live]) openBro(db, t);

    const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
    const out = parse((await tools.handlers['task_recover']!({ agent: 'bro', task_id: String(done) })) as RawResult);
    assert.equal(out['action'], 'noop');
    assert.equal(out['runs_swept'], 2);
    assert.notEqual(runs(db, done)[0]!.completed_at, null);
    assert.notEqual(runs(db, failed)[0]!.completed_at, null);
    assert.equal(runs(db, live)[0]!.completed_at, null, 'a live task keeps its open row');

    const again = parse((await tools.handlers['task_recover']!({ agent: 'bro', task_id: String(done) })) as RawResult);
    assert.equal(again['runs_swept'], 0, 'the sweep is idempotent');
    db.close();
  });

  type Stamp = { agent_type: string; root_dir: string | null; host: string | null; exit_reason: string | null };
  const stamps = (db: TrajectoryDB, taskId: number): Stamp[] =>
    db
      .all<Stamp>('SELECT agent_type, root_dir, host, exit_reason FROM agent_runs WHERE task_id = ? ORDER BY id', [taskId])
      .map((r) => ({ ...r }));

  it('task_brief stamps the swe row with the task worktree and host', async () => {
    const db = tempDB();
    const id = seed(db);
    const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null, { host: 'codex', projectRoot: '/tmp' });
    await tools.handlers['task_brief']!({ agent: 'swe', task_id: id });
    const branch = db.get<{ b: string }>('SELECT branch_id AS b FROM tasks WHERE id = ?', [id])!.b;
    assert.deepEqual(stamps(db, id), [
      { agent_type: 'swe', root_dir: `/tmp/app/.claude/worktrees/${branch.replace(/^[^/]+\//, '')}`, host: 'codex', exit_reason: null },
    ]);
    db.close();
  });

  it('task_create_batch and task_retry accept session_id, reject an invalid one writing nothing, and open no bro row', async () => {
    const db = tempDB();
    db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
    const tasks = taskTools(db);
    const WAIVE = 'unit test of session_id validation';
    const batch = (branches: string[], extra: Record<string, unknown>) =>
      call(tasks.handlers, 'task_create_batch', {
        agent: 'bro', issue_id: '1',
        waive_intent_gate: true, waive_intent_gate_reason: WAIVE, waive_decision_gate: true, waive_decision_gate_reason: WAIVE,
        waive_branch_gate: true, waive_branch_gate_reason: WAIVE, waive_scope_gate: true, waive_scope_gate_reason: WAIVE,
        waive_spec_shape: true, waive_spec_shape_reason: WAIVE,
        tasks: branches.map((branch_id) => ({ branch_id, description: 'd', spec_body: SPEC, files: ['src/a.ts'], verification: ['true'] })),
        ...extra,
      });

    const stamped = parseBatch(await batch(['fix/sess-a', 'fix/sess-b'], { session_id: 'sess-0001-batch' }));
    assert.equal(stamped.length, 2);
    const legacy = parseBatch(await batch(['fix/sess-d'], {}));
    const legacyId = legacy[0]!['id'] as number;

    const rejected = await batch(['fix/sess-e'], { session_id: 'bad id!' });
    assert.equal(rejected.isError, true);
    assert.equal(db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM tasks WHERE branch_id = 'fix/sess-e'`)!.c, 0, 'nothing written');

    await call(tasks.handlers, 'task_update_status', { agent: 'bro', task_id: String(legacyId), status: 'escalated' });
    const composites = compositeTools(db, '', null);
    const retry = (new_branch_id: string, extra: Record<string, unknown>) =>
      composites.handlers['task_retry']!({
        agent: 'bro', failed_task_id: String(legacyId), new_branch_id, corrected_spec_body: SPEC,
        retry_rationale: 'retry for session_id validation', description: 'd', ...extra,
      }) as Promise<RawResult>;

    const badRetry = await retry('fix/sess-retry-bad', { session_id: 'tiny' });
    assert.equal(badRetry.isError, true);
    assert.equal(db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM tasks WHERE branch_id = 'fix/sess-retry-bad'`)!.c, 0);

    const retried = parse(await retry('fix/sess-retry', { session_id: 'sess-0002-retry' }));
    assert.ok((retried['task_id'] as number) > 0, JSON.stringify(retried));
    assert.equal(db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM agent_runs WHERE agent_type = 'bro'`)!.c, 0);
    db.close();
  });

  for (const status of ['failed', 'escalated'] as const) {
    it(`task_update_status → ${status} stamps exit_reason ${status} on every row it closes`, async () => {
      const db = tempDB();
      const id = seed(db);
      db.run(`UPDATE tasks SET status = 'running' WHERE id = ?`, [id]);
      openBro(db, id);
      const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
      await tools.handlers['task_brief']!({ agent: 'swe', task_id: id });
      const agent = status === 'failed' ? 'swe' : 'bro';
      await call(taskTools(db).handlers, 'task_update_status', { agent, task_id: String(id), status });
      assert.deepEqual(stamps(db, id).map((r) => r.exit_reason), [status, status]);
      db.close();
    });
  }

  it('bro_atomic_close stamps exit_reason completed', async () => {
    const db = tempDB();
    const id = seed(db);
    db.run(`UPDATE tasks SET status = 'completed' WHERE id = ?`, [id]);
    openBro(db, id);
    const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
    await tools.handlers['task_brief']!({ agent: 'swe', task_id: id });
    await tools.handlers['bro_atomic_close']!({
      agent: 'bro', task_id: String(id), commit_sha: 'abc1234', verification_summary: 'ok', waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test',
    });
    assert.deepEqual(stamps(db, id).map((r) => r.exit_reason), ['completed', 'completed']);
    db.close();
  });

  it('task_recover sweeps an unmeasured row as swept_orphan and a measured one as swept_stale', async () => {
    const db = tempDB();
    const done = seed(db);
    db.run(`UPDATE tasks SET status = 'closed' WHERE id = ?`, [done]);
    openBro(db, done);
    openBro(db, done);
    db.run(`UPDATE agent_runs SET usage_source = 'transcript', tokens_in = 5 WHERE id = (SELECT MAX(id) FROM agent_runs WHERE task_id = ?)`, [done]);
    const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
    await tools.handlers['task_recover']!({ agent: 'bro', task_id: String(done) });
    assert.deepEqual(stamps(db, done).map((r) => r.exit_reason), ['swept_orphan', 'swept_stale']);
    db.close();
  });

  it('task_brief closes an earlier spawn\'s orphaned open swe row as swept_orphan and opens a fresh one', async () => {
    const db = tempDB();
    const id = seed(db);
    db.run(
      `INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at) VALUES (?, 1, 'swe', strftime('%Y-%m-%dT%H:%M:%fZ','now','-11 minutes'))`,
      [id],
    );
    const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
    await tools.handlers['task_brief']!({ agent: 'swe', task_id: id });
    const rows = db.all<{ exit_reason: string | null; completed_at: string | null }>(
      'SELECT exit_reason, completed_at FROM agent_runs WHERE task_id = ? ORDER BY id',
      [id],
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.exit_reason, 'swept_orphan');
    assert.notEqual(rows[0]!.completed_at, null);
    assert.equal(rows[1]!.completed_at, null, 'the new spawn has an open row');
    db.close();
  });

  it('task_brief stamps the swept orphan with its window length and exit_reason swept_orphan', async () => {
    const db = tempDB();
    const id = seed(db);
    db.run(
      `INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at) VALUES (?, 1, 'swe', strftime('%Y-%m-%dT%H:%M:%fZ','now','-11 minutes'))`,
      [id],
    );
    const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
    await tools.handlers['task_brief']!({ agent: 'swe', task_id: id });
    const orphan = db.get<{ exit_reason: string; duration_ms: number }>(
      'SELECT exit_reason, duration_ms FROM agent_runs WHERE task_id = ? ORDER BY id LIMIT 1',
      [id],
    )!;
    assert.equal(orphan.exit_reason, 'swept_orphan');
    assert.ok(orphan.duration_ms >= 11 * 60 * 1000, `the orphan takes its window length (got ${orphan.duration_ms})`);
    db.close();
  });

  it('task_brief reuses an open swe row younger than 10 minutes', async () => {
    const db = tempDB();
    const id = seed(db);
    db.run(
      `INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at) VALUES (?, 1, 'swe', strftime('%Y-%m-%dT%H:%M:%fZ','now','-9 minutes'))`,
      [id],
    );
    const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
    await tools.handlers['task_brief']!({ agent: 'swe', task_id: id });
    const rows = db.all<{ exit_reason: string | null; completed_at: string | null }>(
      'SELECT exit_reason, completed_at FROM agent_runs WHERE task_id = ? ORDER BY id',
      [id],
    );
    assert.equal(rows.length, 1, 'no new row opens');
    assert.equal(rows[0]!.completed_at, null, 'the young row stays open');
    assert.equal(rows[0]!.exit_reason, null);
    db.close();
  });

  it('task_brief sweeps an unbound spawn row (spawn_id tool_use:*) older than 10 minutes', async () => {
    const db = tempDB();
    const id = seed(db);
    db.run(
      `INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, spawn_id) VALUES (?, 1, 'swe', strftime('%Y-%m-%dT%H:%M:%fZ','now','-11 minutes'), 'tool_use:toolu_1')`,
      [id],
    );
    const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
    await tools.handlers['task_brief']!({ agent: 'swe', task_id: id });
    const rows = db.all<{ exit_reason: string | null; completed_at: string | null }>(
      'SELECT exit_reason, completed_at FROM agent_runs WHERE task_id = ? ORDER BY id',
      [id],
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.exit_reason, 'swept_orphan');
    assert.equal(rows[1]!.completed_at, null, 'the new spawn has an open row');
    db.close();
  });

  it('task_brief keeps an open swe row bound to an agent_id however old it is', async () => {
    const db = tempDB();
    const id = seed(db);
    db.run(
      `INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, spawn_id) VALUES (?, 1, 'swe', strftime('%Y-%m-%dT%H:%M:%fZ','now','-11 minutes'), 'agent-live')`,
      [id],
    );
    const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
    await tools.handlers['task_brief']!({ agent: 'swe', task_id: id });
    const rows = db.all<{ spawn_id: string; exit_reason: string | null; completed_at: string | null }>(
      'SELECT spawn_id, exit_reason, completed_at FROM agent_runs WHERE task_id = ? ORDER BY id',
      [id],
    );
    assert.equal(rows.length, 1, 'no new row opens');
    assert.equal(rows[0]!.spawn_id, 'agent-live');
    assert.equal(rows[0]!.completed_at, null, 'the live spawn row stays open');
    assert.equal(rows[0]!.exit_reason, null, 'a bound row is never swept_orphan');
    db.close();
  });
});

describe('scopeSurface', () => {
  it('groups by first path segment, root files under <root>', () => {
    assert.equal(scopeSurface('src/a.ts'), 'src');
    assert.equal(scopeSurface('README.md'), '<root>');
    assert.equal(scopeSurface('a/b/c'), 'a');
  });
});
