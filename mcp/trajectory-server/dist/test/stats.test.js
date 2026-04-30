import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { statsTools } from '../tools/stats.js';
import { nowISO } from '../db.js';
async function call(handlers, name, args) {
    const handler = handlers[name];
    assert.ok(handler, `Handler not found: ${name}`);
    return handler(args);
}
function parseResult(result) {
    return JSON.parse(result.content[0].text);
}
describe('statsTools — task_stats', () => {
    it('returns all-zero aggregate and empty spawns for a task with no agent_runs', async () => {
        const db = tempDB();
        const tools = statsTools(db);
        const now = nowISO();
        db.run("INSERT INTO issues (objective, description, status, created_at, updated_at) VALUES (?, '', 'open', ?, ?)", ['test issue', now, now]);
        const issueId = db.get('SELECT last_insert_rowid() AS id').id;
        db.run("INSERT INTO tasks (issue_id, branch_id, title, description, success_criteria, status, created_at, updated_at) VALUES (?, 'feat/test', 'title', 'desc', 'criteria', 'pending', ?, ?)", [issueId, now, now]);
        const taskId = db.get('SELECT last_insert_rowid() AS id').id;
        const result = await call(tools.handlers, 'task_stats', { agent: 'bro', task_id: taskId });
        assert.ok(!result.isError);
        const payload = parseResult(result);
        assert.equal(payload.task_id, taskId);
        assert.deepEqual(payload.aggregate, {
            spawn_count: 0,
            tokens_in: 0,
            tokens_out: 0,
            tokens_total: 0,
            tool_uses: 0,
            duration_ms: 0,
        });
        assert.deepEqual(payload.spawns, []);
        db.close();
    });
    it('returns correct aggregate and 2-spawn breakdown ordered by id', async () => {
        const db = tempDB();
        const tools = statsTools(db);
        const now = nowISO();
        db.run("INSERT INTO issues (objective, description, status, created_at, updated_at) VALUES (?, '', 'open', ?, ?)", ['test issue', now, now]);
        const issueId = db.get('SELECT last_insert_rowid() AS id').id;
        db.run("INSERT INTO tasks (issue_id, branch_id, title, description, success_criteria, status, created_at, updated_at) VALUES (?, 'feat/test', 'title', 'desc', 'criteria', 'pending', ?, ?)", [issueId, now, now]);
        const taskId = db.get('SELECT last_insert_rowid() AS id').id;
        db.run("INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, tokens_total, tool_uses, duration_ms, completed_at, exit_status) VALUES (?, ?, 'swe', 100, 200, 300, 5, 1000, datetime('now'), 'completed')", [taskId, issueId]);
        db.run("INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, tokens_total, tool_uses, duration_ms, completed_at, exit_status) VALUES (?, ?, 'swe', 150, 250, 400, 8, 2000, datetime('now'), 'completed')", [taskId, issueId]);
        const result = await call(tools.handlers, 'task_stats', { agent: 'bro', task_id: taskId });
        assert.ok(!result.isError);
        const payload = parseResult(result);
        assert.equal(payload.task_id, taskId);
        assert.deepEqual(payload.aggregate, {
            spawn_count: 2,
            tokens_in: 250,
            tokens_out: 450,
            tokens_total: 700,
            tool_uses: 13,
            duration_ms: 3000,
        });
        assert.equal(payload.spawns.length, 2);
        assert.ok(payload.spawns[0].id < payload.spawns[1].id, 'spawns must be ordered by id ASC');
        assert.equal(payload.spawns[0].agent_type, 'swe');
        assert.equal(payload.spawns[0].tokens_in, 100);
        assert.equal(payload.spawns[1].tokens_in, 150);
        db.close();
    });
    it('returns error for non-positive task_id', async () => {
        const db = tempDB();
        const tools = statsTools(db);
        const result = await call(tools.handlers, 'task_stats', { agent: 'bro', task_id: 0 });
        assert.ok(result.isError);
        assert.match(parseResult(result).error, /positive integer/);
        db.close();
    });
    it('returns error for non-integer task_id', async () => {
        const db = tempDB();
        const tools = statsTools(db);
        const result = await call(tools.handlers, 'task_stats', { agent: 'bro', task_id: 1.5 });
        assert.ok(result.isError);
        assert.match(parseResult(result).error, /positive integer/);
        db.close();
    });
    it('is forbidden for unknown agents', async () => {
        const db = tempDB();
        const tools = statsTools(db);
        const result = await call(tools.handlers, 'task_stats', { agent: 'unknown-agent', task_id: 1 });
        assert.ok(result.isError);
        const payload = parseResult(result);
        assert.equal(payload.error, 'forbidden');
        db.close();
    });
    it('is accessible to all allowed roles (swe, bro, architect, pr-reviewer)', async () => {
        const db = tempDB();
        const tools = statsTools(db);
        const now = nowISO();
        db.run("INSERT INTO issues (objective, description, status, created_at, updated_at) VALUES (?, '', 'open', ?, ?)", ['test issue', now, now]);
        const issueId = db.get('SELECT last_insert_rowid() AS id').id;
        db.run("INSERT INTO tasks (issue_id, branch_id, title, description, success_criteria, status, created_at, updated_at) VALUES (?, 'feat/test', 'title', 'desc', 'criteria', 'pending', ?, ?)", [issueId, now, now]);
        const taskId = db.get('SELECT last_insert_rowid() AS id').id;
        for (const agent of ['bro', 'swe', 'architect', 'pr-reviewer']) {
            const result = await call(tools.handlers, 'task_stats', { agent, task_id: taskId });
            assert.ok(!result.isError, `Expected ${agent} to be allowed`);
        }
        db.close();
    });
});
//# sourceMappingURL=stats.test.js.map