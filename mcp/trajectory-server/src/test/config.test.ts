import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { configTools } from '../tools/config.js';

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

describe('configTools', () => {
  it('config_set + config_get round-trip: string', async () => {
    const db = tempDB();
    const tools = configTools(db);

    await call(tools.handlers, 'config_set', { agent: 'gatekeeper', key: 'my.key', value: 'hello' });
    const result = await call(tools.handlers, 'config_get', { key: 'my.key' });
    assert.ok(!result.isError);
    assert.equal(parseResult(result), 'hello');

    db.close();
  });

  it('config_set + config_get round-trip: number', async () => {
    const db = tempDB();
    const tools = configTools(db);

    await call(tools.handlers, 'config_set', { agent: 'gatekeeper', key: 'count', value: 42 });
    const result = await call(tools.handlers, 'config_get', { key: 'count' });
    assert.equal(parseResult(result), 42);

    db.close();
  });

  it('config_set + config_get round-trip: object', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const obj = { branching: 'trunk', protected: ['main'] };
    await call(tools.handlers, 'config_set', { agent: 'gatekeeper', key: 'settings', value: obj });
    const result = await call(tools.handlers, 'config_get', { key: 'settings' });
    assert.deepEqual(parseResult(result), obj);

    db.close();
  });

  it('config_set + config_get round-trip: array', async () => {
    const db = tempDB();
    const tools = configTools(db);

    await call(tools.handlers, 'config_set', { agent: 'gatekeeper', key: 'branches', value: ['main', 'dev'] });
    const result = await call(tools.handlers, 'config_get', { key: 'branches' });
    assert.deepEqual(parseResult(result), ['main', 'dev']);

    db.close();
  });

  it('config_set + config_get round-trip: null', async () => {
    const db = tempDB();
    const tools = configTools(db);

    await call(tools.handlers, 'config_set', { agent: 'gatekeeper', key: 'nullable', value: null });
    const result = await call(tools.handlers, 'config_get', { key: 'nullable' });
    assert.equal(parseResult(result), null);

    db.close();
  });

  it('config_set with invalid key: empty string', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const result = await call(tools.handlers, 'config_set', { agent: 'gatekeeper', key: '', value: 'x' });
    assert.ok(result.isError, 'Expected error for empty key');
    assert.match(parseResult(result).error, /Invalid config key/);

    db.close();
  });

  it('config_set with invalid key: leading digit', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const result = await call(tools.handlers, 'config_set', { agent: 'gatekeeper', key: '1invalid', value: 'x' });
    assert.ok(result.isError, 'Expected error for leading digit');
    assert.match(parseResult(result).error, /Invalid config key/);

    db.close();
  });

  it('config_set with invalid key: contains space', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const result = await call(tools.handlers, 'config_set', { agent: 'gatekeeper', key: 'bad key', value: 'x' });
    assert.ok(result.isError, 'Expected error for key with space');
    assert.match(parseResult(result).error, /Invalid config key/);

    db.close();
  });

  it('config_get for missing key returns null (not error)', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const result = await call(tools.handlers, 'config_get', { key: 'nonexistent' });
    assert.ok(!result.isError, 'Should not be an error');
    assert.equal(parseResult(result), null);

    db.close();
  });

  it('config_list with 0 entries returns empty object', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const result = await call(tools.handlers, 'config_list', {});
    assert.ok(!result.isError);
    assert.deepEqual(parseResult(result), {});

    db.close();
  });

  it('config_list with 1 entry returns correct shape', async () => {
    const db = tempDB();
    const tools = configTools(db);

    await call(tools.handlers, 'config_set', { agent: 'gatekeeper', key: 'alpha', value: 'one' });
    const result = await call(tools.handlers, 'config_list', {});
    assert.ok(!result.isError);
    assert.deepEqual(parseResult(result), { alpha: 'one' });

    db.close();
  });

  it('config_list with 3 entries returns correct shape', async () => {
    const db = tempDB();
    const tools = configTools(db);

    await call(tools.handlers, 'config_set', { agent: 'gatekeeper', key: 'alpha', value: 1 });
    await call(tools.handlers, 'config_set', { agent: 'gatekeeper', key: 'beta', value: 2 });
    await call(tools.handlers, 'config_set', { agent: 'gatekeeper', key: 'gamma', value: 3 });
    const result = await call(tools.handlers, 'config_list', {});
    assert.ok(!result.isError);
    assert.deepEqual(parseResult(result), { alpha: 1, beta: 2, gamma: 3 });

    db.close();
  });

  it('config_set called twice on same key updates value and bumps updated_at', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const first = await call(tools.handlers, 'config_set', { agent: 'gatekeeper', key: 'evolving', value: 'v1' });
    const firstTs = parseResult(first).updated_at as string;

    await new Promise((res) => setTimeout(res, 5));

    const second = await call(tools.handlers, 'config_set', { agent: 'gatekeeper', key: 'evolving', value: 'v2' });
    const secondTs = parseResult(second).updated_at as string;

    assert.ok(secondTs >= firstTs, 'second updated_at must be >= first');

    const getResult = await call(tools.handlers, 'config_get', { key: 'evolving' });
    assert.equal(parseResult(getResult), 'v2');

    db.close();
  });

  it('config_set with 64-char key is accepted (boundary inclusive)', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const key = 'a' + 'b'.repeat(63);
    assert.equal(key.length, 64);
    const result = await call(tools.handlers, 'config_set', { agent: 'gatekeeper', key, value: 'ok' });
    assert.ok(!result.isError, 'A 64-char key should be valid');

    db.close();
  });

  it('config_set called with agent=swe returns forbidden', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const result = await call(tools.handlers, 'config_set', { agent: 'swe', key: 'blocked', value: 'x' });
    assert.ok(result.isError, 'Expected forbidden error');
    const payload = parseResult(result);
    assert.equal(payload.error, 'forbidden');
    assert.equal(payload.caller_role, 'swe');

    db.close();
  });

  it('config_set called with agent=architect succeeds', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const result = await call(tools.handlers, 'config_set', { agent: 'architect', key: 'arch.key', value: 42 });
    assert.ok(!result.isError, 'Expected architect to be allowed');
    assert.equal(parseResult(result).key, 'arch.key');

    db.close();
  });

  it('config_set called with agent=gatekeeper succeeds', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const result = await call(tools.handlers, 'config_set', { agent: 'gatekeeper', key: 'gate.key', value: true });
    assert.ok(!result.isError, 'Expected gatekeeper to be allowed');

    db.close();
  });

  it('config_get called with agent=swe succeeds (read open to all)', async () => {
    const db = tempDB();
    const tools = configTools(db);

    await call(tools.handlers, 'config_set', { agent: 'gatekeeper', key: 'open.key', value: 'readable' });
    const result = await call(tools.handlers, 'config_get', { agent: 'swe', key: 'open.key' });
    assert.ok(!result.isError, 'Read should be open to all agents');
    assert.equal(parseResult(result), 'readable');

    db.close();
  });
});
