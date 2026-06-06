import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrajectoryDB } from '../db.js';
import { tempDB } from './helpers.js';
import { compositeTools, parseFilesDirs } from '../tools/composites.js';
import { issueTools } from '../tools/issues.js';
import { taskTools } from '../tools/tasks.js';
import { discussionTools } from '../tools/discussions.js';
import { auditTools } from '../tools/audit.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function parse(r: RawResult): Record<string, unknown> {
  return JSON.parse(r.content[0].text);
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

    const created = parse(await call(tasks.handlers, 'task_create_batch', {
      agent: 'bro',
      issue_id: issueId,
      waive_intent_gate: true,
      waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
      waive_decision_gate: true,
      waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      tasks: [{
        branch_id: 'fix/initial',
        description: 'do thing',
        spec_body: 'placeholder',
      }],
    })) as unknown as Array<{ id: number }>;
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
      agent: 'bro', objective: 'test', description: 'x',
    }))['id']));
    await call(discussions.handlers, 'discussion_append', {
      agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
    });
    await call(audit.handlers, 'audit_log', {
      agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
      from_node: 'bro', branch_id: 'fix/x', summary: 's',
    });
    const created = parse(await call(tasks.handlers, 'task_create_batch', {
      agent: 'bro', issue_id: issueId,
      waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      tasks: [{ branch_id: 'fix/x', description: 'd', spec_body: 's' }],
    })) as unknown as Array<{ id: number }>;
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
      agent: 'bro', objective: 'test', description: 'x',
    }))['id']));
    await call(discussions.handlers, 'discussion_append', {
      agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
    });
    await call(audit.handlers, 'audit_log', {
      agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
      from_node: 'bro', branch_id: 'fix/x', summary: 's',
    });
    const created = parse(await call(tasks.handlers, 'task_create_batch', {
      agent: 'bro', issue_id: issueId,
      waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
      tasks: [{ branch_id: 'fix/x', description: 'd', spec_body: 's' }],
    })) as unknown as Array<{ id: number }>;
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
        agent: 'bro', objective: 'closed_at regression', description: 'x',
      }))['id']));

      await call(discussions.handlers, 'discussion_append', {
        agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
      });
      await call(audit.handlers, 'audit_log', {
        agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
        from_node: 'bro', branch_id: 'fix/closed-at', summary: 's',
      });
      const created = parse(await call(tasks.handlers, 'task_create_batch', {
        agent: 'bro', issue_id: issueId,
        waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
        waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
        tasks: [{ branch_id: 'fix/closed-at', description: 'd', spec_body: 's', repo: 'app' }],
      })) as unknown as Array<{ id: number }>;
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
});

describe('headless_intent_start', () => {
  it('writes audit + note + intent in one transaction', async () => {
    const db = tempDB();
    const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');

    const issueId = String((parse(await call(issues.handlers, 'issue_create', {
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

describe('bro_verification_fail_record', () => {
  it('writes audit + note in one transaction', async () => {
    const db = tempDB();
    const issues = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
    const tasks = taskTools(db);
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const discussions = discussionTools(db);
    const audit = auditTools(db);

    const issueId = String((parse(await call(issues.handlers, 'issue_create', {
      agent: 'bro', objective: 'fail record test', description: 'x',
    }))['id']));
    await call(discussions.handlers, 'discussion_append', {
      agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'q',
    });
    await call(audit.handlers, 'audit_log', {
      agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
      from_node: 'bro', branch_id: 'fix/fail-rec', summary: 's',
    });
    const created = parse(await call(tasks.handlers, 'task_create_batch', {
      agent: 'bro', issue_id: issueId,
      waive_intent_gate: true, waive_intent_gate_reason: 'unit-test; not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'unit-test; not under test',
      tasks: [{ branch_id: 'fix/fail-rec', description: 'd', spec_body: 's' }],
    })) as unknown as Array<{ id: number }>;
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

describe('pr_review_worktree', () => {
  it('rejects non-pr-reviewer caller', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'pr_review_worktree', {
      agent: 'bro', commit_sha: 'abc1234', repo_path: '/tmp', command: 'echo ok',
    });
    assert.equal(r.isError, true);
    assert.equal(parse(r)['error'], 'forbidden');
  });

  it('rejects malformed commit_sha', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'pr_review_worktree', {
      agent: 'pr-reviewer', commit_sha: 'not-a-sha', repo_path: '/tmp', command: 'echo ok',
    });
    assert.equal(r.isError, true);
    assert.match(parse(r)['error'] as string, /hex SHA/);
  });

  it('rejects relative repo_path', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'pr_review_worktree', {
      agent: 'pr-reviewer', commit_sha: 'abc1234', repo_path: 'relative/path', command: 'echo ok',
    });
    assert.equal(r.isError, true);
    assert.match(parse(r)['error'] as string, /absolute path/);
  });

  it('rejects empty command', async () => {
    const db = tempDB();
    const composites = compositeTools(db, '/tmp/.claude/tmb/trajectory.db');
    const r = await call(composites.handlers, 'pr_review_worktree', {
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
});



describe('parseFilesDirs (#300)', () => {
  it('derives unique dirs from a spec ## Files section', () => {
    const spec = [
      '## Description', 'do a thing', '',
      '## Files',
      '- `src/api/handler.ts` — edit',
      '- `src/api/util.ts` — add',
      '- `docs/guide.md` — update',
      '- `README.md` — touch',
      '',
      '## Success Criteria', '- `src/other.ts` must not be listed (wrong section)',
    ].join('\n');
    assert.deepEqual(parseFilesDirs(spec).sort(), ['', 'docs', 'src/api']);
  });
});

function seedTask(db: TrajectoryDB, opts: { repo?: string | null; spec: string }): number {
  db.run(
    `INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
     VALUES (1, 'brief test obj', 'd', 'open', datetime('now'), datetime('now'))`,
  );
  db.run(
    `INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, commit_sha, repo, created_at, updated_at)
     VALUES (1, 'fix/1-brief', 'brief task', 'd', 'open', ?, 'abc123def', ?, datetime('now'), datetime('now'))`,
    [opts.spec, opts.repo ?? null],
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

  it('populates scope_world_model from the spec dirs via the graph', async () => {
    const db = tempDB();
    const id = seedTask(db, { repo: 'app', spec: SPEC });
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
});
