import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { statsTools } from '../tools/stats.js';
import { nowISO } from '../db.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function call(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  name: string,
  args: Record<string, unknown>,
): Promise<RawResult> {
  const handler = handlers[name];
  assert.ok(handler, `Handler not found: ${name}`);
  return handler(args) as unknown as RawResult;
}

function parseResult(result: RawResult) {
  return JSON.parse(result.content[0].text);
}

describe('statsTools — task_stats', () => {
  it('returns all-zero aggregate and empty spawns for a task with no agent_runs', async () => {
    const db = tempDB();
    const tools = statsTools(db);

    const now = nowISO();
    db.run(
      "INSERT INTO issues (objective, description, status, created_at, updated_at) VALUES (?, '', 'open', ?, ?)",
      ['test issue', now, now],
    );
    const issueId = (db.get<{ id: number }>('SELECT last_insert_rowid() AS id') as { id: number }).id;

    db.run(
      "INSERT INTO tasks (issue_id, branch_id, title, description, status, created_at, updated_at) VALUES (?, 'feat/test', 'title', 'desc', 'pending', ?, ?)",
      [issueId, now, now],
    );
    const taskId = (db.get<{ id: number }>('SELECT last_insert_rowid() AS id') as { id: number }).id;

    const result = await call(tools.handlers, 'task_stats', { agent: 'bro', task_id: taskId });
    assert.ok(!result.isError);
    const payload = parseResult(result);

    assert.equal(payload.task_id, taskId);
    assert.deepEqual(payload.aggregate, {
      spawn_count: 0,
      tokens_in: 0,
      tokens_out: 0,
      tokens_total: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      tool_uses: 0,
      duration_ms: 0,
      estimated_cost_usd: 0,
    });
    assert.deepEqual(payload.spawns, []);

    db.close();
  });

  it('returns correct aggregate and 2-spawn breakdown ordered by id', async () => {
    const db = tempDB();
    const tools = statsTools(db);

    const now = nowISO();
    db.run(
      "INSERT INTO issues (objective, description, status, created_at, updated_at) VALUES (?, '', 'open', ?, ?)",
      ['test issue', now, now],
    );
    const issueId = (db.get<{ id: number }>('SELECT last_insert_rowid() AS id') as { id: number }).id;

    db.run(
      "INSERT INTO tasks (issue_id, branch_id, title, description, status, created_at, updated_at) VALUES (?, 'feat/test', 'title', 'desc', 'pending', ?, ?)",
      [issueId, now, now],
    );
    const taskId = (db.get<{ id: number }>('SELECT last_insert_rowid() AS id') as { id: number }).id;

    db.run(
      "INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, tokens_total, cache_read_tokens, cache_creation_tokens, tool_uses, duration_ms, completed_at) VALUES (?, ?, 'swe', 100, 200, 300, 1000, 50, 5, 1000, datetime('now'))",
      [taskId, issueId],
    );
    db.run(
      "INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, tokens_total, cache_read_tokens, cache_creation_tokens, tool_uses, duration_ms, completed_at) VALUES (?, ?, 'swe', 150, 250, 400, 2000, 75, 8, 2000, datetime('now'))",
      [taskId, issueId],
    );

    const result = await call(tools.handlers, 'task_stats', { agent: 'bro', task_id: taskId });
    assert.ok(!result.isError);
    const payload = parseResult(result);

    assert.equal(payload.task_id, taskId);
    assert.equal(payload.aggregate.spawn_count, 2);
    assert.equal(payload.aggregate.tokens_in, 250);
    assert.equal(payload.aggregate.tokens_out, 450);
    assert.equal(payload.aggregate.tokens_total, 700);
    assert.equal(payload.aggregate.cache_read_tokens, 3000);
    assert.equal(payload.aggregate.cache_creation_tokens, 125);
    assert.equal(payload.aggregate.tool_uses, 13);
    assert.equal(payload.aggregate.duration_ms, 3000);
    assert.ok(payload.aggregate.estimated_cost_usd > 0, 'estimated_cost_usd must be positive');
    assert.equal(payload.spawns.length, 2);
    assert.ok(payload.spawns[0].id < payload.spawns[1].id, 'spawns must be ordered by id ASC');
    assert.equal(payload.spawns[0].agent_type, 'swe');
    assert.equal(payload.spawns[0].tokens_in, 100);
    assert.equal(payload.spawns[0].cache_read_tokens, 1000);
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

  it('is forbidden for malformed agent names (unknown role)', async () => {
    const db = tempDB();
    const tools = statsTools(db);

    const result = await call(tools.handlers, 'task_stats', { agent: '!!!malformed', task_id: 1 });
    assert.ok(result.isError);
    const payload = parseResult(result);
    assert.equal(payload.error, 'forbidden');

    db.close();
  });

  it('is accessible to all allowed roles (swe, bro, consultant agents, pr-reviewer)', async () => {
    const db = tempDB();
    const tools = statsTools(db);

    const now = nowISO();
    db.run(
      "INSERT INTO issues (objective, description, status, created_at, updated_at) VALUES (?, '', 'open', ?, ?)",
      ['test issue', now, now],
    );
    const issueId = (db.get<{ id: number }>('SELECT last_insert_rowid() AS id') as { id: number }).id;
    db.run(
      "INSERT INTO tasks (issue_id, branch_id, title, description, status, created_at, updated_at) VALUES (?, 'feat/test', 'title', 'desc', 'pending', ?, ?)",
      [issueId, now, now],
    );
    const taskId = (db.get<{ id: number }>('SELECT last_insert_rowid() AS id') as { id: number }).id;

    for (const agent of ['bro', 'swe', 'architect', 'cto', 'legal-reviewer', 'pr-reviewer']) {
      const result = await call(tools.handlers, 'task_stats', { agent, task_id: taskId });
      assert.ok(!result.isError, `Expected ${agent} to be allowed`);
    }

    db.close();
  });
});
