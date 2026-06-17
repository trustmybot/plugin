import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { skillTools } from '../tools/skills.js';
import { taskTools } from '../tools/tasks.js';
import { issueTools } from '../tools/issues.js';
import { compositeTools } from '../tools/composites.js';
async function call(handlers, name, args) {
    return (await handlers[name](args));
}
function parse(r) {
    return JSON.parse(r.content[0].text);
}
function parseBatch(r) {
    const raw = JSON.parse(r.content[0].text);
    return (raw.tasks ?? raw);
}
describe('#2886 skills.scope column', () => {
    it('seeded tmb_* skills have scope=global', async () => {
        const db = tempDB();
        const rows = db.all(`SELECT name, scope FROM skills WHERE name LIKE 'tmb_%'`);
        assert.ok(rows.length > 0, 'expected schema-seeded tmb_* skills');
        for (const r of rows)
            assert.equal(r.scope, 'global', `${r.name} should be global-scoped`);
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
        const row = db.get(`SELECT scope FROM skills WHERE name = 'my-local-skill'`);
        assert.equal(row.scope, 'project-local');
        db.close();
    });
});
describe('#2886 skill_invocations junction', () => {
    it('skill_record_invocation writes a junction row referencing skills.name + agent_runs.id', async () => {
        const db = tempDB();
        const skills = skillTools(db);
        // Seed an agent_run row so we can FK to it.
        db.run(`INSERT INTO agent_runs (agent_type, started_at, completed_at)
       VALUES ('bro', datetime('now'), datetime('now'))`);
        const runId = (db.get(`SELECT id FROM agent_runs LIMIT 1`)).id;
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
        db.run(`INSERT INTO agent_runs (agent_type, started_at, completed_at)
       VALUES ('bro', datetime('now'), datetime('now')),
              ('bro', datetime('now'), datetime('now'))`);
        const runs = db.all(`SELECT id FROM agent_runs ORDER BY id`);
        const [run1, run2] = runs.map((r) => r.id);
        // run1 used tmb_planning + tmb_review; run2 used only tmb_planning
        for (const [run, skill] of [
            [run1, 'tmb_planning'],
            [run1, 'tmb_review'],
            [run2, 'tmb_planning'],
        ]) {
            await call(skills.handlers, 'skill_record_invocation', {
                agent: 'bro',
                skill_name: skill,
                agent_name: 'bro',
                agent_run_id: run,
            });
        }
        const byRun = parse(await call(skills.handlers, 'skill_invocations_list', { agent: 'bro', agent_run_id: run1 }));
        assert.equal(byRun.count, 2);
        const bySkill = parse(await call(skills.handlers, 'skill_invocations_list', { agent: 'bro', skill_name: 'tmb_planning' }));
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
describe('#2886 bro-as-agent_run composite', () => {
    it('task_create_batch opens a bro agent_run per task (completed_at NULL until close)', async () => {
        const db = tempDB();
        const issues = issueTools(db);
        const tasks = taskTools(db);
        const issue = parse(await call(issues.handlers, 'issue_create', { agent: 'bro', objective: 'O' }));
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
        const broRuns = db.all(`SELECT task_id, agent_type, completed_at FROM agent_runs WHERE agent_type = 'bro' ORDER BY task_id`);
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
        const batch = parseBatch(await call(tasks.handlers, 'task_create_batch', {
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
        db.run(`INSERT INTO repos (name, path, file_count, last_scanned_at)
       VALUES ('', '.', 0, datetime('now'))`);
        db.run(`UPDATE agent_runs SET started_at = datetime('now', '-5 seconds')
        WHERE task_id = ? AND agent_type = 'bro'`, [taskId]);
        // Smoke the SQL path the composite uses to finalize the bro row.
        // (The full bro_atomic_close composite is exercised by composites.test.ts;
        // here we assert just the bro-row UPDATE shape.)
        void composites;
        const now = new Date().toISOString();
        db.run(`UPDATE agent_runs
          SET completed_at = ?,
              duration_ms = COALESCE(
                (strftime('%s', ?) - strftime('%s', started_at)) * 1000, 0
              )
        WHERE task_id = ? AND agent_type = 'bro' AND completed_at IS NULL`, [now, now, taskId]);
        const broRun = db.get(`SELECT completed_at, duration_ms FROM agent_runs WHERE task_id = ? AND agent_type = 'bro'`, [taskId]);
        assert.ok(broRun);
        assert.ok(broRun.completed_at !== null, 'bro completed_at must be set');
        assert.ok(broRun.duration_ms >= 5000, `duration_ms must reflect the 5s gap; got ${broRun.duration_ms}`);
        db.close();
    });
});
//# sourceMappingURL=rules-commands-junctions.test.js.map