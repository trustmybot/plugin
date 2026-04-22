import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { regenStateTools } from '../tools/regen-state.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function call(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  name: string,
  args: Record<string, unknown>,
): Promise<RawResult> {
  const handler = handlers[name];
  assert.ok(handler, `Handler not found: ${name}`);
  const argsWithAgent = 'agent' in args ? args : { agent: 'architect', ...args };
  return handler(argsWithAgent) as unknown as RawResult;
}

function parseResult(result: RawResult) {
  return JSON.parse(result.content[0].text);
}

describe('regenStateTools', () => {
  it('regen_state_get for unseen target returns null (not error)', async () => {
    const db = tempDB();
    const tools = regenStateTools(db);

    const result = await call(tools.handlers, 'regen_state_get', { target: 'file_registry' });
    assert.ok(!result.isError);
    assert.equal(parseResult(result), null);

    db.close();
  });

  it('regen_state_get with invalid target returns error', async () => {
    const db = tempDB();
    const tools = regenStateTools(db);

    const result = await call(tools.handlers, 'regen_state_get', { target: 'foo' });
    assert.ok(result.isError, 'Expected isError for invalid target');
    assert.match(parseResult(result).error, /Invalid target/);

    db.close();
  });

  it('regen_state_set with only target writes row with nowISO, empty sha, empty notes', async () => {
    const db = tempDB();
    const tools = regenStateTools(db);

    const before = new Date().toISOString();
    const result = await call(tools.handlers, 'regen_state_set', { target: 'codebase_tree' });
    const after = new Date().toISOString();

    assert.ok(!result.isError);
    const data = parseResult(result);
    assert.equal(data.target, 'codebase_tree');
    assert.ok(data.last_regen_at >= before, 'last_regen_at should be >= before');
    assert.ok(data.last_regen_at <= after, 'last_regen_at should be <= after');
    assert.equal(data.last_seen_sha, '');
    assert.equal(data.notes, '');

    db.close();
  });

  it('regen_state_set with invalid target returns error', async () => {
    const db = tempDB();
    const tools = regenStateTools(db);

    const result = await call(tools.handlers, 'regen_state_set', { target: 'foo' });
    assert.ok(result.isError, 'Expected isError for invalid target');
    assert.match(parseResult(result).error, /Invalid target/);

    db.close();
  });

  it('regen_state_set followed by regen_state_get returns identical values', async () => {
    const db = tempDB();
    const tools = regenStateTools(db);

    const ts = '2026-04-21T00:00:00.000Z';
    await call(tools.handlers, 'regen_state_set', {
      target: 'erd',
      last_regen_at: ts,
      last_seen_sha: 'abc1234',
      notes: 'test notes',
    });

    const result = await call(tools.handlers, 'regen_state_get', { target: 'erd' });
    assert.ok(!result.isError);
    const data = parseResult(result);
    assert.equal(data.target, 'erd');
    assert.equal(data.last_regen_at, ts);
    assert.equal(data.last_seen_sha, 'abc1234');
    assert.equal(data.notes, 'test notes');

    db.close();
  });

  it('regen_state_set with invalid SHA (3 chars) returns error', async () => {
    const db = tempDB();
    const tools = regenStateTools(db);

    const result = await call(tools.handlers, 'regen_state_set', {
      target: 'module_graph',
      last_seen_sha: 'abc',
    });
    assert.ok(result.isError, 'Expected error for 3-char SHA');
    assert.match(parseResult(result).error, /Invalid last_seen_sha/);

    db.close();
  });

  it('regen_state_set with valid 7-char SHA is accepted', async () => {
    const db = tempDB();
    const tools = regenStateTools(db);

    const result = await call(tools.handlers, 'regen_state_set', {
      target: 'module_graph',
      last_seen_sha: 'abc1234',
    });
    assert.ok(!result.isError, 'Expected 7-char SHA to be accepted');
    assert.equal(parseResult(result).last_seen_sha, 'abc1234');

    db.close();
  });

  it('regen_state_set with valid 40-char SHA is accepted', async () => {
    const db = tempDB();
    const tools = regenStateTools(db);

    const sha = 'a'.repeat(40);
    const result = await call(tools.handlers, 'regen_state_set', {
      target: 'changelog',
      last_seen_sha: sha,
    });
    assert.ok(!result.isError, 'Expected 40-char SHA to be accepted');
    assert.equal(parseResult(result).last_seen_sha, sha);

    db.close();
  });

  it('regen_state_set with empty string SHA is accepted ("no SHA yet")', async () => {
    const db = tempDB();
    const tools = regenStateTools(db);

    const result = await call(tools.handlers, 'regen_state_set', {
      target: 'file_registry',
      last_seen_sha: '',
    });
    assert.ok(!result.isError, 'Expected empty SHA to be accepted');
    assert.equal(parseResult(result).last_seen_sha, '');

    db.close();
  });

  it('regen_state_set with notes exceeding 2000 chars returns error', async () => {
    const db = tempDB();
    const tools = regenStateTools(db);

    const result = await call(tools.handlers, 'regen_state_set', {
      target: 'file_registry',
      notes: 'x'.repeat(2001),
    });
    assert.ok(result.isError, 'Expected error for notes > 2000 chars');
    assert.match(parseResult(result).error, /notes must be 2000 chars/);

    db.close();
  });

  it('regen_state_set with notes exactly 2000 chars is accepted', async () => {
    const db = tempDB();
    const tools = regenStateTools(db);

    const result = await call(tools.handlers, 'regen_state_set', {
      target: 'file_registry',
      notes: 'x'.repeat(2000),
    });
    assert.ok(!result.isError, 'Expected 2000-char notes to be accepted');

    db.close();
  });

  it('regen_state_set is idempotent: second call updates the row', async () => {
    const db = tempDB();
    const tools = regenStateTools(db);

    await call(tools.handlers, 'regen_state_set', {
      target: 'codebase_tree',
      last_regen_at: '2026-01-01T00:00:00.000Z',
      last_seen_sha: 'aaa1111',
      notes: 'first',
    });

    await call(tools.handlers, 'regen_state_set', {
      target: 'codebase_tree',
      last_regen_at: '2026-02-01T00:00:00.000Z',
      last_seen_sha: 'bbb2222',
      notes: 'second',
    });

    const result = await call(tools.handlers, 'regen_state_get', { target: 'codebase_tree' });
    const data = parseResult(result);
    assert.equal(data.last_regen_at, '2026-02-01T00:00:00.000Z');
    assert.equal(data.last_seen_sha, 'bbb2222');
    assert.equal(data.notes, 'second');

    db.close();
  });

  it('all five valid targets are accepted by regen_state_set', async () => {
    const db = tempDB();
    const tools = regenStateTools(db);

    const targets = ['file_registry', 'codebase_tree', 'erd', 'module_graph', 'changelog'];
    for (const target of targets) {
      const result = await call(tools.handlers, 'regen_state_set', { target });
      assert.ok(!result.isError, `Expected target "${target}" to be accepted`);
      assert.equal(parseResult(result).target, target);
    }

    db.close();
  });
});
