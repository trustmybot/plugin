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
      "INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, tool_uses, duration_ms, completed_at) VALUES (?, ?, 'swe', 100, 200, 1000, 50, 5, 1000, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      [taskId, issueId],
    );
    db.run(
      "INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, tool_uses, duration_ms, completed_at) VALUES (?, ?, 'swe', 150, 250, 2000, 75, 8, 2000, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      [taskId, issueId],
    );

    const result = await call(tools.handlers, 'task_stats', { agent: 'bro', task_id: taskId });
    assert.ok(!result.isError);
    const payload = parseResult(result);

    assert.equal(payload.task_id, taskId);
    assert.equal(payload.aggregate.spawn_count, 2);
    assert.equal(payload.aggregate.tokens_in, 250);
    assert.equal(payload.aggregate.tokens_out, 450);
    assert.equal(payload.aggregate.tokens_total, 250 + 450 + 3000 + 125, 'tokens_total = in + out + cache_read + cache_creation');
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
    assert.equal(payload.spawns[0].tokens_total, 100 + 200 + 1000 + 50, 'per-spawn tokens_total includes cache');

    db.close();
  });

  it('sums ignore unmeasured (NULL-token) runs and the aggregate stays numeric (v30)', async () => {
    const db = tempDB();
    const tools = statsTools(db);

    const now = nowISO();
    db.run(
      "INSERT INTO issues (objective, description, status, created_at, updated_at) VALUES (?, '', 'open', ?, ?)",
      ['test issue', now, now],
    );
    const issueId = (db.get<{ id: number }>('SELECT last_insert_rowid() AS id') as { id: number }).id;
    db.run(
      "INSERT INTO tasks (issue_id, branch_id, title, description, status, created_at, updated_at) VALUES (?, 'feat/nulls', 'title', 'desc', 'pending', ?, ?)",
      [issueId, now, now],
    );
    const taskId = (db.get<{ id: number }>('SELECT last_insert_rowid() AS id') as { id: number }).id;
    db.run(
      "INSERT INTO agent_runs (task_id, issue_id, agent_type, usage_source, completed_at) VALUES (?, ?, 'swe', 'unmeasured', ?)",
      [taskId, issueId, now],
    );
    db.run(
      "INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, usage_source, completed_at) VALUES (?, ?, 'swe', 10, 20, 40, 50, 'subagent_stop', ?)",
      [taskId, issueId, now],
    );

    const payload = parseResult(await call(tools.handlers, 'task_stats', { agent: 'bro', task_id: taskId }));
    assert.equal(payload.aggregate.spawn_count, 2);
    assert.equal(payload.aggregate.tokens_in, 10);
    assert.equal(payload.aggregate.tokens_out, 20);
    assert.equal(payload.aggregate.cache_read_tokens, 40);
    assert.equal(payload.aggregate.cache_creation_tokens, 50);
    assert.equal(payload.spawns[0].tokens_in, null, 'an unmeasured spawn reports NULL, not 0');
    assert.equal(payload.aggregate.tokens_total, 120, 'unmeasured runs add nothing to the computed total');
    assert.equal(payload.spawns[0].tokens_total, null, 'an unmeasured spawn has no total');
    assert.equal(payload.spawns[1].tokens_total, 120);
    assert.deepEqual(payload.spawns.map((r: { usage_source: string }) => r.usage_source), ['unmeasured', 'subagent_stop'], 'each spawn exposes usage_source');

    const unmeasuredOnly = db.run(
      "INSERT INTO tasks (issue_id, branch_id, title, description, status, created_at, updated_at) VALUES (?, 'feat/only-nulls', 'title', 'desc', 'pending', ?, ?)",
      [issueId, now, now],
    );
    const onlyTaskId = Number(unmeasuredOnly.lastInsertRowid);
    db.run(
      "INSERT INTO agent_runs (task_id, issue_id, agent_type, usage_source, completed_at) VALUES (?, ?, 'swe', 'unmeasured', ?)",
      [onlyTaskId, issueId, now],
    );
    const onlyNulls = parseResult(await call(tools.handlers, 'task_stats', { agent: 'bro', task_id: onlyTaskId }));
    assert.equal(onlyNulls.aggregate.tokens_in, 0, 'an all-NULL SUM surfaces as 0 at the API edge');
    assert.equal(onlyNulls.aggregate.estimated_cost_usd, 0);

    db.close();
  });

  it('pending task with no genuine spawn returns spawn_count=0 (#685)', async () => {
    const db = tempDB();
    const tools = statsTools(db);

    const now = nowISO();
    db.run(
      "INSERT INTO issues (objective, description, status, created_at, updated_at) VALUES (?, '', 'open', ?, ?)",
      ['test issue', now, now],
    );
    const issueId = (db.get<{ id: number }>('SELECT last_insert_rowid() AS id') as { id: number }).id;
    db.run(
      "INSERT INTO tasks (issue_id, branch_id, title, description, status, created_at, updated_at) VALUES (?, 'feat/pending', 'title', 'desc', 'pending', ?, ?)",
      [issueId, now, now],
    );
    const taskId = (db.get<{ id: number }>('SELECT last_insert_rowid() AS id') as { id: number }).id;

    const result = await call(tools.handlers, 'task_stats', { agent: 'bro', task_id: taskId });
    assert.ok(!result.isError);
    const payload = parseResult(result);

    assert.equal(payload.aggregate.spawn_count, 0);
    assert.deepEqual(payload.spawns, []);

    db.close();
  });

  it('one spawn reports its own cache_read, not a tens-of-millions cumulative (#685)', async () => {
    const db = tempDB();
    const tools = statsTools(db);

    const now = nowISO();
    db.run(
      "INSERT INTO issues (objective, description, status, created_at, updated_at) VALUES (?, '', 'open', ?, ?)",
      ['test issue', now, now],
    );
    const issueId = (db.get<{ id: number }>('SELECT last_insert_rowid() AS id') as { id: number }).id;
    db.run(
      "INSERT INTO tasks (issue_id, branch_id, title, description, status, created_at, updated_at) VALUES (?, 'feat/one-spawn', 'title', 'desc', 'completed', ?, ?)",
      [issueId, now, now],
    );
    const taskId = (db.get<{ id: number }>('SELECT last_insert_rowid() AS id') as { id: number }).id;

    // A single, correctly-recorded spawn: cache_read is the spawn's own
    // high-water mark (~200K), NOT the pre-#685 per-message cumulative sum
    // (tens of millions). With idempotency upstream there is exactly one row.
    const ownCacheRead = 200_000;
    db.run(
      "INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, tool_uses, duration_ms, completed_at) VALUES (?, ?, 'swe', 5000, 3000, ?, 12000, 106, 90000, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      [taskId, issueId, ownCacheRead],
    );

    const result = await call(tools.handlers, 'task_stats', { agent: 'bro', task_id: taskId });
    assert.ok(!result.isError);
    const payload = parseResult(result);

    assert.equal(payload.aggregate.spawn_count, 1);
    assert.equal(payload.spawns.length, 1);
    assert.equal(payload.aggregate.cache_read_tokens, ownCacheRead);
    assert.equal(payload.spawns[0].cache_read_tokens, ownCacheRead);
    assert.ok(
      payload.aggregate.cache_read_tokens < 1_000_000,
      'cache_read must be the spawn\'s own read, not a tens-of-millions cumulative',
    );

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

describe('statsTools — task_stats cost_estimate', () => {
  const seed = (db: ReturnType<typeof tempDB>): number => {
    const now = nowISO();
    db.run("INSERT INTO issues (objective, description, status, created_at, updated_at) VALUES ('i', '', 'open', ?, ?)", [now, now]);
    const issueId = db.get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;
    db.run(
      "INSERT INTO tasks (issue_id, branch_id, title, description, status, created_at, updated_at) VALUES (?, 'feat/cost', 't', 'd', 'pending', ?, ?)",
      [issueId, now, now],
    );
    const taskId = db.get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;
    const run = (host: string, model: string | null, ti: number, to: number, cr: number, cc: number): void => {
      db.run(
        `INSERT INTO agent_runs (task_id, issue_id, agent_type, host, model, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens)
         VALUES (?, ?, 'swe', ?, ?, ?, ?, ?, ?)`,
        [taskId, issueId, host, model, ti, to, cr, cc],
      );
    };
    run('claude', 'model-a', 1_000_000, 100_000, 2_000_000, 10_000);
    run('claude', 'model-a', 500_000, 0, 0, 0);
    run('codex', 'model-b', 10_000, 10_000, 0, 0);
    run('claude', null, 7, 3, 0, 0);
    return taskId;
  };

  it('prices each row by model_prices[model] and counts unpriced tokens, grouped by host and model', async () => {
    const db = tempDB();
    const taskId = seed(db);
    db.run(`UPDATE plugin_config SET value_json = ? WHERE key = 'model_prices'`, [
      JSON.stringify({ 'model-a': { input: 3, output: 15, cache_read: 0.3, cache_creation: 3.75 } }),
    ]);
    const payload = parseResult(await call(statsTools(db).handlers, 'task_stats', { agent: 'bro', task_id: taskId }));

    // model-a row 1: 1.0*3 + 0.1*15 + 2.0*0.3 + 0.01*3.75 = 5.1375; row 2: 0.5*3 = 1.5
    assert.equal(payload.cost_estimate, 6.6375);
    assert.equal(payload.unpriced_tokens, 20_000 + 10, 'model-b and the model-less row are unpriced');
    assert.deepEqual(payload.cost_groups, [
      { host: 'claude', model: 'model-a', spawn_count: 2, tokens_total: 3_610_000, cost_estimate: 6.6375, unpriced_tokens: 0 },
      { host: 'codex', model: 'model-b', spawn_count: 1, tokens_total: 20_000, cost_estimate: 0, unpriced_tokens: 20_000 },
      { host: 'claude', model: null, spawn_count: 1, tokens_total: 10, cost_estimate: 0, unpriced_tokens: 10 },
    ]);
    assert.deepEqual(
      payload.spawns.map((s: { host: string; model: string | null }) => [s.host, s.model]),
      [['claude', 'model-a'], ['claude', 'model-a'], ['codex', 'model-b'], ['claude', null]],
    );
    db.close();
  });

  it('rounds to 4 decimals and treats the seeded empty model_prices as all-unpriced', async () => {
    const db = tempDB();
    const taskId = seed(db);
    const empty = parseResult(await call(statsTools(db).handlers, 'task_stats', { agent: 'bro', task_id: taskId }));
    assert.equal(empty.cost_estimate, 0);
    assert.equal(empty.unpriced_tokens, 3_610_000 + 20_000 + 10);

    db.run(`UPDATE plugin_config SET value_json = ? WHERE key = 'model_prices'`, [
      JSON.stringify({ 'model-b': { input: 0.123456, output: 0, cache_read: 0, cache_creation: 0 }, 'model-a': { input: 1 } }),
    ]);
    const partial = parseResult(await call(statsTools(db).handlers, 'task_stats', { agent: 'bro', task_id: taskId }));
    assert.equal(partial.cost_estimate, 0.0012, '10k × 0.123456 / 1M = 0.00123456 → 0.0012');
    assert.equal(partial.unpriced_tokens, 3_610_000 + 10, 'an incomplete price entry leaves model-a unpriced');
    db.close();
  });
});
