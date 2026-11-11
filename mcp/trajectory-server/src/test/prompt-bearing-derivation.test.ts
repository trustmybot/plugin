import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { pinScanEnv, tempDB } from './helpers.js';
import { compositeTools } from '../tools/composites.js';
import { filesArePromptBearing, resolvePromptBearing, taskTools } from '../tools/tasks.js';
import { issueTools } from '../tools/issues.js';
import { discussionTools } from '../tools/discussions.js';
import { auditTools } from '../tools/audit.js';

const scanPin = pinScanEnv();
after(() => scanPin.restore());

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

const parse = (r: RawResult): Record<string, unknown> => JSON.parse(r.content[0].text) as Record<string, unknown>;

async function call(handlers: Handlers, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = (await handlers[name](args)) as RawResult;
  assert.ok(!r.isError, `${name}: ${r.content[0].text}`);
  return parse(r);
}

const SPEC = ['## Description', 'do the thing', '', '## Success Criteria', '- SC1: works'].join('\n');

const promptBearingOf = (db: TrajectoryDB, id: number): number =>
  db.get<{ prompt_bearing: number }>(`SELECT prompt_bearing FROM tasks WHERE id = ?`, [id])!.prompt_bearing;

function withRepo(fn: (db: TrajectoryDB, handlers: Handlers) => Promise<void>): () => Promise<void> {
  return async () => {
    const ws = mkdtempSync(join(tmpdir(), 'prompt-bearing-'));
    const repoRoot = join(ws, 'app');
    mkdirSync(repoRoot, { recursive: true });
    const git = (...a: string[]) =>
      execFileSync('git', ['-C', repoRoot, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'main')`, [repoRoot]);
    db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
            VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
    try {
      await fn(db, compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db')).handlers);
    } finally {
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  };
}

async function provision(
  handlers: Handlers,
  branch_id: string,
  files: string[],
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return call(handlers, 'task_provision', {
    agent: 'bro', issue_id: 1, branch_id, decision_body: 'approach: prompt-bearing fixture.',
    task: { description: 'd', spec_body: SPEC, files, verification: ['true'], repo: 'app', ...extra },
  });
}

describe('filesArePromptBearing (SC6)', () => {
  for (const entry of [
    'skills/foo/SKILL.md', 'agents/swe.md', '.claude/rules/x.md', 'templates/t.md',
    'agents/', 'agents', 'skills/foo/', '.claude/skills/', 'templates/sub', 'CLAUDE.md', 'plugin/CLAUDE.md',
  ]) {
    it(`${entry} is prompt-bearing`, () => assert.equal(filesArePromptBearing([entry]), true));
  }
  for (const entry of [
    'src/agents.ts', 'docs/skills.md', 'mcp/trajectory-server/src/', 'agentsx/',
    'src/skills/', '.claude/templates/', 'docs/agents/x.md', 'README.md',
  ]) {
    it(`${entry} is not prompt-bearing`, () => assert.equal(filesArePromptBearing([entry]), false));
  }
  it('any one prompt-surface entry makes the set prompt-bearing', () => {
    assert.equal(filesArePromptBearing(['src/a.ts', 'skills/x/SKILL.md']), true);
    assert.equal(filesArePromptBearing([]), false);
  });
  it('resolvePromptBearing marks derived only when files[] decided it', () => {
    assert.deepEqual(resolvePromptBearing(1, ['skills/x/SKILL.md']), { prompt_bearing: 1, derived: false });
    assert.deepEqual(resolvePromptBearing(undefined, ['skills/x/SKILL.md']), { prompt_bearing: 1, derived: true });
    assert.deepEqual(resolvePromptBearing(0, ['src/a.ts']), { prompt_bearing: 0, derived: false });
  });
});

describe('task_provision derives prompt_bearing (SC1, SC7)', () => {
  it('a prompt-surface file stores 1 and resolves effort like an explicit 1', withRepo(async (db, handlers) => {
    const derived = await provision(handlers, 'fix/derived', ['skills/foo/SKILL.md']);
    const explicit = await provision(handlers, 'fix/explicit', ['src/x.ts'], { prompt_bearing: 1 });
    assert.equal(promptBearingOf(db, derived['task_id'] as number), 1);
    assert.equal(derived['prompt_bearing'], 1);
    assert.equal(derived['prompt_bearing_derived'], true);
    assert.equal(derived['effort'], explicit['effort']);
    assert.equal(derived['effort_reason'], explicit['effort_reason']);
    assert.equal(derived['effort_reason'], 'prompt_bearing');
    assert.equal(explicit['prompt_bearing_derived'], undefined, 'explicit 1 is not reported as derived');
  }));

  it('explicit 1 on prompt-surface files is not reported as derived', withRepo(async (db, handlers) => {
    const out = await provision(handlers, 'fix/both', ['agents/swe.md'], { prompt_bearing: 1 });
    assert.equal(promptBearingOf(db, out['task_id'] as number), 1);
    assert.equal(out['prompt_bearing_derived'], undefined);
  }));

  it('non-prompt files store 0 with no derived flag', withRepo(async (db, handlers) => {
    const out = await provision(handlers, 'fix/plain', ['src/agents.ts']);
    assert.equal(promptBearingOf(db, out['task_id'] as number), 0);
    assert.equal(out['prompt_bearing_derived'], undefined);
    assert.equal(out['prompt_bearing'], undefined);
  }));
});

describe('task_update_spec derives prompt_bearing (SC3, SC7)', () => {
  it('replacing files[] with a prompt-surface path sets 1', withRepo(async (db, handlers) => {
    const id = (await provision(handlers, 'fix/amend-up', ['src/x.ts']))['task_id'] as number;
    assert.equal(promptBearingOf(db, id), 0);
    const out = await call(handlers, 'task_update_spec', {
      agent: 'bro', task_id: id, reason: 'the change lives in a skill', files: ['skills/foo/'],
    });
    assert.equal(promptBearingOf(db, id), 1);
    assert.equal(out['prompt_bearing_derived'], true);
  }));

  it('replacing files[] with non-prompt paths never lowers 1', withRepo(async (db, handlers) => {
    const id = (await provision(handlers, 'fix/amend-keep', ['agents/swe.md']))['task_id'] as number;
    const out = await call(handlers, 'task_update_spec', {
      agent: 'bro', task_id: id, reason: 'narrow to source', files: ['src/x.ts'],
    });
    assert.equal(promptBearingOf(db, id), 1);
    assert.equal(out['prompt_bearing_derived'], undefined);
  }));
});

describe('task_reopen derives prompt_bearing (SC4, SC7)', () => {
  it('files_add of a prompt-surface path stores 1 and raises effort by prompt_bearing', withRepo(async (db, handlers) => {
    const id = (await provision(handlers, 'fix/reopen-add', ['src/x.ts']))['task_id'] as number;
    db.run(`UPDATE tasks SET status = 'closed', effort = 'low' WHERE id = ?`, [id]);
    const out = await call(handlers, 'task_reopen', {
      agent: 'bro', task_id: id, reason: 'needs a skill edit', files_add: ['skills/foo/SKILL.md'],
    });
    assert.equal(promptBearingOf(db, id), 1);
    assert.equal(out['prompt_bearing_derived'], true);
    assert.equal(out['effort'], 'high');
  }));

  it('stored prompt-surface files with prompt_bearing=0 store 1', withRepo(async (db, handlers) => {
    const id = (await provision(handlers, 'fix/reopen-stored', ['src/x.ts']))['task_id'] as number;
    db.run(`UPDATE tasks SET status = 'closed', prompt_bearing = 0, files = ? WHERE id = ?`, [
      JSON.stringify(['.claude/skills/']), id,
    ]);
    const out = await call(handlers, 'task_reopen', { agent: 'bro', task_id: id, reason: 'rework' });
    assert.equal(promptBearingOf(db, id), 1);
    assert.equal(out['prompt_bearing_derived'], true);
  }));

  it('a stored 1 is kept and not reported as derived', withRepo(async (db, handlers) => {
    const id = (await provision(handlers, 'fix/reopen-kept', ['src/x.ts'], { prompt_bearing: 1 }))['task_id'] as number;
    db.run(`UPDATE tasks SET status = 'closed' WHERE id = ?`, [id]);
    const out = await call(handlers, 'task_reopen', { agent: 'bro', task_id: id, reason: 'rework' });
    assert.equal(promptBearingOf(db, id), 1);
    assert.equal(out['prompt_bearing_derived'], undefined);
  }));
});

describe('task_retry derives prompt_bearing (SC5, SC7)', () => {
  it('derives from the retried files[]', withRepo(async (db, handlers) => {
    const id = (await provision(handlers, 'fix/retry-src', ['src/x.ts']))['task_id'] as number;
    db.run(`UPDATE tasks SET status = 'failed', prompt_bearing = 0, files = ? WHERE id = ?`, [
      JSON.stringify(['commands/run.md']), id,
    ]);
    const out = await call(handlers, 'task_retry', {
      agent: 'bro', failed_task_id: String(id), new_branch_id: 'fix/retry-src-v2',
      corrected_spec_body: SPEC, retry_rationale: 'retry on the command prompt', description: 'retry',
    });
    assert.equal(promptBearingOf(db, out['task_id'] as number), 1);
    assert.equal(out['prompt_bearing_derived'], true);
  }));

  it('non-prompt files[] with prompt_bearing=0 stay 0', withRepo(async (db, handlers) => {
    const id = (await provision(handlers, 'fix/retry-plain', ['src/x.ts']))['task_id'] as number;
    db.run(`UPDATE tasks SET status = 'failed' WHERE id = ?`, [id]);
    const out = await call(handlers, 'task_retry', {
      agent: 'bro', failed_task_id: String(id), new_branch_id: 'fix/retry-plain-v2',
      corrected_spec_body: SPEC, retry_rationale: 'retry on the same source', description: 'retry',
    });
    assert.equal(promptBearingOf(db, out['task_id'] as number), 0);
    assert.equal(out['prompt_bearing_derived'], undefined);
  }));
});

describe('task_create_batch derives prompt_bearing per task (SC2, SC7)', () => {
  it('each task derives from its own files[]', async () => {
    const db = tempDB();
    try {
      const issueId = String((await call(issueTools(db, '/tmp/.claude/tmb/trajectory.db').handlers, 'issue_create', {
        labels: ['Bug', 'Priority: High'], agent: 'bro', objective: 'batch derive', description: 'd',
      }))['id']);
      await call(discussionTools(db).handlers, 'discussion_append', {
        agent: 'bro', issue_id: issueId, author: 'bro', kind: 'question', body: 'scope?',
      });
      for (const branch of ['fix/batch-skill', 'fix/batch-src', 'fix/batch-explicit']) {
        await call(auditTools(db).handlers, 'audit_append', {
          agent: 'bro', issue_id: issueId, kind: 'event', event_type: 'branch_id_proposed',
          from_node: 'bro', branch_id: branch, summary: 'branch proposed',
        });
      }
      const out = await call(taskTools(db).handlers, 'task_create_batch', {
        agent: 'bro', issue_id: issueId,
        waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
        waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
        waive_spec_shape: true, waive_spec_shape_reason: 'unit-test placeholder spec; shape not under test',
        tasks: [
          { branch_id: 'fix/batch-skill', description: 'd', spec_body: 's', files: ['skills/foo/SKILL.md'], verification: ['true'] },
          { branch_id: 'fix/batch-src', description: 'd', spec_body: 's', files: ['src/x.ts'], verification: ['true'] },
          { branch_id: 'fix/batch-explicit', description: 'd', spec_body: 's', files: ['src/y.ts'], verification: ['true'], prompt_bearing: 1 },
        ],
      });
      const byBranch = new Map((out['tasks'] as Array<Record<string, unknown>>).map((t) => [t['branch_id'], t]));
      const skill = byBranch.get('fix/batch-skill')!;
      const src = byBranch.get('fix/batch-src')!;
      const explicit = byBranch.get('fix/batch-explicit')!;
      assert.equal(promptBearingOf(db, skill['id'] as number), 1);
      assert.equal(skill['prompt_bearing_derived'], true);
      assert.equal(skill['effort'], explicit['effort']);
      assert.equal(skill['effort_reason'], explicit['effort_reason']);
      assert.equal(promptBearingOf(db, src['id'] as number), 0);
      assert.equal(src['prompt_bearing_derived'], undefined);
      assert.equal(promptBearingOf(db, explicit['id'] as number), 1);
      assert.equal(explicit['prompt_bearing_derived'], undefined);
    } finally {
      db.close();
    }
  });
});
