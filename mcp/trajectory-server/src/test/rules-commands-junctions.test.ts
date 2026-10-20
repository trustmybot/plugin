import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { skillTools } from '../tools/skills.js';
import { taskTools } from '../tools/tasks.js';
import { issueTools } from '../tools/issues.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function call(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  name: string,
  args: Record<string, unknown>,
): Promise<RawResult> {
  return (await handlers[name]!(args)) as RawResult;
}

function parse(r: RawResult) {
  return JSON.parse(r.content[0]!.text);
}

function parseBatch(r: RawResult): Array<Record<string, unknown>> {
  const raw = JSON.parse(r.content[0]!.text);
  return (raw.tasks ?? raw) as Array<Record<string, unknown>>;
}

describe('#101 builtin skill scope in the unified cheatcodes registry', () => {
  it('seeded tmb_* skills have origin=builtin scope=global', async () => {
    const db = tempDB();
    const rows = db.all<{ name: string; scope: string; origin: string }>(
      `SELECT name, scope, origin FROM cheatcodes WHERE name LIKE 'tmb_%'`,
    );
    assert.ok(rows.length > 0, 'expected schema-seeded tmb_* skills');
    for (const r of rows) {
      assert.equal(r.origin, 'builtin', `${r.name} should be a builtin row`);
      assert.equal(r.scope, 'global', `${r.name} should be global-scoped`);
    }
    db.close();
  });

  it('skill_register writes a builtin cheatcodes row defaulting scope to project-local', async () => {
    const db = tempDB();
    const tools = skillTools(db);
    await call(tools.handlers, 'skill_register', {
      agent: 'bro',
      name: 'my-local-skill',
      description: 'd',
      file_path: '.claude/skills/my-local-skill/SKILL.md',
      trust_tier: 'agent',
    });
    const row = db.get<{ scope: string; origin: string; kind: string }>(
      `SELECT scope, origin, kind FROM cheatcodes WHERE name = 'my-local-skill'`,
    );
    assert.equal(row!.scope, 'project-local');
    assert.equal(row!.origin, 'builtin');
    assert.equal(row!.kind, 'skill');
    db.close();
  });
});

describe('bro agent_runs are metered per session, not per task', () => {
  it('task_create_batch opens no bro agent_run', async () => {
    const db = tempDB();
    const issues = issueTools(db);
    const tasks = taskTools(db);

    const issue = parse(await call(issues.handlers, 'issue_create', { labels: ['Bug', 'Priority: High'], agent: 'bro', objective: 'O' }));
    const batch = parseBatch(await call(tasks.handlers, 'task_create_batch', {
      agent: 'bro',
      issue_id: String(issue.id),
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic; gate not under test',
      waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic; gate not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic; gate not under test',
      tasks: [
        { branch_id: 'feat/a', description: 'a' },
        { branch_id: 'feat/b', description: 'b' },
      ],
    }));
    assert.equal(batch.length, 2);

    const broRuns = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM agent_runs WHERE agent_type = 'bro'`)!.c;
    assert.equal(broRuns, 0, 'the bro-turn-usage Stop hook owns bro rows');
    db.close();
  });
});
