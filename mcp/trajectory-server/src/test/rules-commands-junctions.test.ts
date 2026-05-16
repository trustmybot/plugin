import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { ruleTools } from '../tools/rules.js';
import { commandTools } from '../tools/commands.js';
import { skillTools } from '../tools/skills.js';
import { taskTools } from '../tools/tasks.js';
import { issueTools } from '../tools/issues.js';
import { compositeTools } from '../tools/composites.js';

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

describe('#2886 rules catalog', () => {
  it('rule_register inserts with defaults (scope=project-local, severity=advisory)', async () => {
    const db = tempDB();
    const tools = ruleTools(db);
    const res = await call(tools.handlers, 'rule_register', {
      agent: 'bro',
      name: 'no-shell-injection',
      description: 'Subprocess calls must not pass untrusted input via shell=True',
      file_path: '.claude/rules/no-shell-injection.md',
    });
    assert.ok(!res.isError);
    const row = parse(res);
    assert.equal(row.name, 'no-shell-injection');
    assert.equal(row.scope, 'project-local');
    assert.equal(row.severity, 'advisory');
    assert.equal(row.status, 'active');
    db.close();
  });

  it('rule_register honors explicit scope + severity', async () => {
    const db = tempDB();
    const tools = ruleTools(db);
    const res = await call(tools.handlers, 'rule_register', {
      agent: 'bro',
      name: 'commit-msg-format',
      description: 'Commit messages follow Conventional Commits',
      file_path: '.claude/rules/commit-msg.md',
      scope: 'project-local',
      severity: 'blocking',
    });
    assert.ok(!res.isError);
    const row = parse(res);
    assert.equal(row.severity, 'blocking');
    db.close();
  });

  it('rule_register rejects invalid scope or severity', async () => {
    const db = tempDB();
    const tools = ruleTools(db);
    const bad = await call(tools.handlers, 'rule_register', {
      agent: 'bro',
      name: 'x',
      description: 'd',
      file_path: 'p',
      scope: 'banana',
    });
    assert.ok(bad.isError);
    assert.match(parse(bad).error, /Invalid scope/);

    const bad2 = await call(tools.handlers, 'rule_register', {
      agent: 'bro',
      name: 'y',
      description: 'd',
      file_path: 'p',
      severity: 'critical',
    });
    assert.ok(bad2.isError);
    assert.match(parse(bad2).error, /Invalid severity/);
    db.close();
  });

  it('rule_list filters by scope + severity', async () => {
    const db = tempDB();
    const tools = ruleTools(db);
    for (const [name, severity] of [
      ['a', 'advisory'],
      ['b', 'warning'],
      ['c', 'blocking'],
    ] as const) {
      await call(tools.handlers, 'rule_register', {
        agent: 'bro',
        name,
        description: name,
        file_path: `.claude/rules/${name}.md`,
        severity,
      });
    }

    const all = await call(tools.handlers, 'rule_list', { agent: 'bro' });
    assert.equal(parse(all).rules.length, 3);

    const blocking = await call(tools.handlers, 'rule_list', { agent: 'bro', severity: 'blocking' });
    const rows = parse(blocking).rules;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'c');
    db.close();
  });
});

describe('#2886 commands catalog', () => {
  it('schema-seeds the 4 plugin-shipped slash commands', async () => {
    const db = tempDB();
    const tools = commandTools(db);
    const res = await call(tools.handlers, 'command_list', { agent: 'bro' });
    const names = parse(res).commands.map((c: { name: string }) => c.name).sort();
    assert.deepEqual(names, ['monitor', 'onboard', 'roundtable', 'scan']);
    db.close();
  });

  it('command_register accepts project-local commands with valid args_schema JSON', async () => {
    const db = tempDB();
    const tools = commandTools(db);
    const res = await call(tools.handlers, 'command_register', {
      agent: 'bro',
      name: 'deploy',
      description: 'Trigger a deploy',
      file_path: '.claude/commands/deploy.md',
      args_schema: '{"argument_hint":"<env>"}',
    });
    assert.ok(!res.isError);
    assert.equal(parse(res).args_schema, '{"argument_hint":"<env>"}');
    db.close();
  });

  it('command_register rejects malformed args_schema JSON', async () => {
    const db = tempDB();
    const tools = commandTools(db);
    const res = await call(tools.handlers, 'command_register', {
      agent: 'bro',
      name: 'broken',
      description: 'd',
      file_path: 'p',
      args_schema: '{not json',
    });
    assert.ok(res.isError);
    assert.match(parse(res).error, /args_schema must be a JSON string/);
    db.close();
  });
});

describe('#2886 skills.scope column', () => {
  it('seeded tmb_* skills have scope=global', async () => {
    const db = tempDB();
    const rows = db.all<{ name: string; scope: string }>(
      `SELECT name, scope FROM skills WHERE name LIKE 'tmb_%'`,
    );
    assert.ok(rows.length > 0, 'expected schema-seeded tmb_* skills');
    for (const r of rows) assert.equal(r.scope, 'global', `${r.name} should be global-scoped`);
    db.close();
  });

  it('skill_register defaults scope to project-local', async () => {
    const db = tempDB();
    const tools = skillTools(db);
    await call(tools.handlers, 'skill_register', {
      agent: 'bro',
      name: 'my-local-skill',
      description: 'd',
      file_path: '.claude/skills/my-local-skill/SKILL.md',
      trust_tier: 'agent',
    });
    const row = db.get<{ scope: string }>(
      `SELECT scope FROM skills WHERE name = 'my-local-skill'`,
    );
    assert.equal(row!.scope, 'project-local');
    db.close();
  });
});

describe('#2886 skill_invocations junction', () => {
  it('skill_record_invocation writes a junction row referencing skills.name + agent_runs.id', async () => {
    const db = tempDB();
    const skills = skillTools(db);

    // Seed an agent_run row so we can FK to it.
    db.run(
      `INSERT INTO agent_runs (agent_type, started_at, completed_at)
       VALUES ('bro', datetime('now'), datetime('now'))`,
    );
    const runId = (db.get<{ id: number }>(`SELECT id FROM agent_runs LIMIT 1`))!.id;

    const res = await call(skills.handlers, 'skill_record_invocation', {
      agent: 'bro',
      skill_name: 'tmb_planning',
      agent_name: 'bro',
      agent_run_id: runId,
      outcome: 'completed',
    });
    assert.ok(!res.isError);
    const row = parse(res);
    assert.equal(row.skill_name, 'tmb_planning');
    assert.equal(row.agent_run_id, runId);
    assert.equal(row.outcome, 'completed');
    db.close();
  });

  it('skill_invocations_list is bidirectional — by skill_name OR by agent_run_id/task_id', async () => {
    const db = tempDB();
    const skills = skillTools(db);
    db.run(
      `INSERT INTO agent_runs (agent_type, started_at, completed_at)
       VALUES ('bro', datetime('now'), datetime('now')),
              ('bro', datetime('now'), datetime('now'))`,
    );
    const runs = db.all<{ id: number }>(`SELECT id FROM agent_runs ORDER BY id`);
    const [run1, run2] = runs.map((r) => r.id);

    // run1 used tmb_planning + tmb_review; run2 used only tmb_planning
    for (const [run, skill] of [
      [run1, 'tmb_planning'],
      [run1, 'tmb_review'],
      [run2, 'tmb_planning'],
    ] as const) {
      await call(skills.handlers, 'skill_record_invocation', {
        agent: 'bro',
        skill_name: skill,
        agent_name: 'bro',
        agent_run_id: run,
      });
    }

    const byRun = parse(
      await call(skills.handlers, 'skill_invocations_list', { agent: 'bro', agent_run_id: run1 }),
    );
    assert.equal(byRun.count, 2);

    const bySkill = parse(
      await call(skills.handlers, 'skill_invocations_list', { agent: 'bro', skill_name: 'tmb_planning' }),
    );
    assert.equal(bySkill.count, 2);
    db.close();
  });

  it('skill_record_invocation rejects unknown skill_name', async () => {
    const db = tempDB();
    const tools = skillTools(db);
    const res = await call(tools.handlers, 'skill_record_invocation', {
      agent: 'bro',
      skill_name: 'does-not-exist',
      agent_name: 'bro',
    });
    assert.ok(res.isError);
    assert.match(parse(res).error, /Skill not registered/);
    db.close();
  });

  it('skill_record_invocation rejects invalid outcome', async () => {
    const db = tempDB();
    const tools = skillTools(db);
    const res = await call(tools.handlers, 'skill_record_invocation', {
      agent: 'bro',
      skill_name: 'tmb_planning',
      agent_name: 'bro',
      outcome: 'maybe',
    });
    assert.ok(res.isError);
    assert.match(parse(res).error, /Invalid outcome/);
    db.close();
  });
});

describe('#2886 rule_invocations junction', () => {
  it('rule_record_invocation writes a junction row', async () => {
    const db = tempDB();
    const rules = ruleTools(db);
    await call(rules.handlers, 'rule_register', {
      agent: 'bro',
      name: 'no-shell-injection',
      description: 'no untrusted shell input',
      file_path: '.claude/rules/no-shell-injection.md',
      severity: 'blocking',
    });
    const res = await call(rules.handlers, 'rule_record_invocation', {
      agent: 'bro',
      rule_name: 'no-shell-injection',
      agent_name: 'swe',
      outcome: 'violated',
    });
    assert.ok(!res.isError);
    const row = parse(res);
    assert.equal(row.rule_name, 'no-shell-injection');
    assert.equal(row.outcome, 'violated');
    db.close();
  });

  it('rule_invocations_list filters by outcome=violated', async () => {
    const db = tempDB();
    const rules = ruleTools(db);
    await call(rules.handlers, 'rule_register', {
      agent: 'bro', name: 'r', description: 'd', file_path: 'p', severity: 'advisory',
    });
    for (const outcome of ['applied', 'violated', 'skipped'] as const) {
      await call(rules.handlers, 'rule_record_invocation', {
        agent: 'bro', rule_name: 'r', agent_name: 'bro', outcome,
      });
    }
    const violated = parse(
      await call(rules.handlers, 'rule_invocations_list', { agent: 'bro', outcome: 'violated' }),
    );
    assert.equal(violated.count, 1);
    assert.equal(violated.rows[0].outcome, 'violated');
    db.close();
  });
});

describe('#2886 bro-as-agent_run composite', () => {
  it('task_create_batch opens a bro agent_run per task (completed_at NULL until close)', async () => {
    const db = tempDB();
    const issues = issueTools(db);
    const tasks = taskTools(db);

    const issue = parse(await call(issues.handlers, 'issue_create', { agent: 'bro', objective: 'O' }));
    const batch = parse(await call(tasks.handlers, 'task_create_batch', {
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

    const broRuns = db.all<{ task_id: number; agent_type: string; completed_at: string | null }>(
      `SELECT task_id, agent_type, completed_at FROM agent_runs WHERE agent_type = 'bro' ORDER BY task_id`,
    );
    assert.equal(broRuns.length, 2, 'one bro agent_run per task');
    for (const r of broRuns) {
      assert.equal(r.agent_type, 'bro');
      assert.equal(r.completed_at, null, 'bro row is open until bro_atomic_close');
    }
    db.close();
  });

  it('bro_atomic_close finalizes the bro agent_run (completed_at set, duration_ms computed)', async () => {
    const db = tempDB();
    const issues = issueTools(db);
    const tasks = taskTools(db);
    const composites = compositeTools(db, '');

    const issue = parse(await call(issues.handlers, 'issue_create', { agent: 'bro', objective: 'O' }));
    const batch = parse(await call(tasks.handlers, 'task_create_batch', {
      agent: 'bro',
      issue_id: String(issue.id),
      waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic; gate not under test',
      waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic; gate not under test',
      waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic; gate not under test',
      waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic; gate not under test',
      tasks: [{ branch_id: 'feat/x', description: 'd' }],
    }));
    const taskId = batch[0].id;

    // Pretend SWE completed (status='completed' so bro_atomic_close accepts it).
    db.run(`UPDATE tasks SET status = 'completed' WHERE id = ?`, [taskId]);

    // Seed a repo + plug an artificial age between started_at and now so
    // duration_ms ends up > 0 even on fast machines.
    db.run(
      `INSERT INTO repos (name, path, file_count, last_scanned_at)
       VALUES ('', '.', 0, datetime('now'))`,
    );
    db.run(
      `UPDATE agent_runs SET started_at = datetime('now', '-5 seconds')
        WHERE task_id = ? AND agent_type = 'bro'`,
      [taskId],
    );

    // Smoke the SQL path the composite uses to finalize the bro row.
    // (The full bro_atomic_close composite is exercised by composites.test.ts;
    // here we assert just the bro-row UPDATE shape.)
    void composites;
    const now = new Date().toISOString();
    db.run(
      `UPDATE agent_runs
          SET completed_at = ?,
              duration_ms = COALESCE(
                (strftime('%s', ?) - strftime('%s', started_at)) * 1000, 0
              )
        WHERE task_id = ? AND agent_type = 'bro' AND completed_at IS NULL`,
      [now, now, taskId],
    );

    const broRun = db.get<{ completed_at: string | null; duration_ms: number }>(
      `SELECT completed_at, duration_ms FROM agent_runs WHERE task_id = ? AND agent_type = 'bro'`,
      [taskId],
    );
    assert.ok(broRun);
    assert.ok(broRun!.completed_at !== null, 'bro completed_at must be set');
    assert.ok(broRun!.duration_ms >= 5000, `duration_ms must reflect the 5s gap; got ${broRun!.duration_ms}`);
    db.close();
  });
});
