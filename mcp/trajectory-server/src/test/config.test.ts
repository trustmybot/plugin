import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { configTools, parseBroCompactNudgeTokens } from '../tools/config.js';

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

    await call(tools.handlers, 'config_set', { agent: 'bro', key: 'my.key', value: 'hello' });
    const result = await call(tools.handlers, 'config_get', { key: 'my.key' });
    assert.ok(!result.isError);
    assert.equal(parseResult(result), 'hello');

    db.close();
  });

  it('config_set + config_get round-trip: number', async () => {
    const db = tempDB();
    const tools = configTools(db);

    await call(tools.handlers, 'config_set', { agent: 'bro', key: 'count', value: 42 });
    const result = await call(tools.handlers, 'config_get', { key: 'count' });
    assert.equal(parseResult(result), 42);

    db.close();
  });

  it('config_set + config_get round-trip: object', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const obj = { branching: 'trunk', protected: ['main'] };
    await call(tools.handlers, 'config_set', { agent: 'bro', key: 'settings', value: obj });
    const result = await call(tools.handlers, 'config_get', { key: 'settings' });
    assert.deepEqual(parseResult(result), obj);

    db.close();
  });

  it('config_set + config_get round-trip: array', async () => {
    const db = tempDB();
    const tools = configTools(db);

    await call(tools.handlers, 'config_set', { agent: 'bro', key: 'branches', value: ['main', 'dev'] });
    const result = await call(tools.handlers, 'config_get', { key: 'branches' });
    assert.deepEqual(parseResult(result), ['main', 'dev']);

    db.close();
  });

  it('config_set + config_get round-trip: null', async () => {
    const db = tempDB();
    const tools = configTools(db);

    await call(tools.handlers, 'config_set', { agent: 'bro', key: 'nullable', value: null });
    const result = await call(tools.handlers, 'config_get', { key: 'nullable' });
    assert.equal(parseResult(result), null);

    db.close();
  });

  it('config_set with invalid key: empty string', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const result = await call(tools.handlers, 'config_set', { agent: 'bro', key: '', value: 'x' });
    assert.ok(result.isError, 'Expected error for empty key');
    assert.match(parseResult(result).error, /Invalid config key/);

    db.close();
  });

  it('config_set with invalid key: leading digit', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const result = await call(tools.handlers, 'config_set', { agent: 'bro', key: '1invalid', value: 'x' });
    assert.ok(result.isError, 'Expected error for leading digit');
    assert.match(parseResult(result).error, /Invalid config key/);

    db.close();
  });

  it('config_set with invalid key: contains space', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const result = await call(tools.handlers, 'config_set', { agent: 'bro', key: 'bad key', value: 'x' });
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

  it('config_list returns the schema-seeded defaults on a fresh DB', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const result = await call(tools.handlers, 'config_list', {});
    assert.ok(!result.isError);
    assert.deepEqual(parseResult(result), {
      issue_classification_labels: ['Bug', 'Feature', 'Improvement', 'Docs', 'Test', 'Chore'],
      issue_priority_labels: ['Priority: Urgent', 'Priority: High', 'Priority: Medium', 'Priority: Low'],
      issue_sync: 'off',
      model_prices: {},
    });

    db.close();
  });

  it('config_list returns schema-seeded defaults plus 1 user-set entry', async () => {
    const db = tempDB();
    const tools = configTools(db);

    await call(tools.handlers, 'config_set', { agent: 'bro', key: 'alpha', value: 'one' });
    const result = await call(tools.handlers, 'config_list', {});
    assert.ok(!result.isError);
    assert.deepEqual(parseResult(result), {
      alpha: 'one',
      issue_classification_labels: ['Bug', 'Feature', 'Improvement', 'Docs', 'Test', 'Chore'],
      issue_priority_labels: ['Priority: Urgent', 'Priority: High', 'Priority: Medium', 'Priority: Low'],
      issue_sync: 'off',
      model_prices: {},
    });

    db.close();
  });

  it('config_list returns schema-seeded defaults plus 3 user-set entries', async () => {
    const db = tempDB();
    const tools = configTools(db);

    await call(tools.handlers, 'config_set', { agent: 'bro', key: 'alpha', value: 1 });
    await call(tools.handlers, 'config_set', { agent: 'bro', key: 'beta', value: 2 });
    await call(tools.handlers, 'config_set', { agent: 'bro', key: 'gamma', value: 3 });
    const result = await call(tools.handlers, 'config_list', {});
    assert.ok(!result.isError);
    assert.deepEqual(parseResult(result), {
      alpha: 1,
      beta: 2,
      gamma: 3,
      issue_classification_labels: ['Bug', 'Feature', 'Improvement', 'Docs', 'Test', 'Chore'],
      issue_priority_labels: ['Priority: Urgent', 'Priority: High', 'Priority: Medium', 'Priority: Low'],
      issue_sync: 'off',
      model_prices: {},
    });

    db.close();
  });

  it('config_set called twice on same key updates value', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const first = await call(tools.handlers, 'config_set', { agent: 'bro', key: 'evolving', value: 'v1' });
    assert.ok(!first.isError);

    const second = await call(tools.handlers, 'config_set', { agent: 'bro', key: 'evolving', value: 'v2' });
    assert.ok(!second.isError);

    const getResult = await call(tools.handlers, 'config_get', { key: 'evolving' });
    assert.equal(parseResult(getResult), 'v2');

    db.close();
  });

  it('config_set with 64-char key is accepted (boundary inclusive)', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const key = 'a' + 'b'.repeat(63);
    assert.equal(key.length, 64);
    const result = await call(tools.handlers, 'config_set', { agent: 'bro', key, value: 'ok' });
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

  it('config_set called with agent=architect is forbidden (consultant role, not bro)', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const result = await call(tools.handlers, 'config_set', { agent: 'architect', key: 'arch.key', value: 42 });
    assert.ok(result.isError, 'Expected architect (consultant) to be forbidden');
    const payload = parseResult(result);
    assert.equal(payload.error, 'forbidden');
    assert.equal(payload.caller_role, 'consultant');

    db.close();
  });

  it('config_set called with agent=bro succeeds', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const result = await call(tools.handlers, 'config_set', { agent: 'bro', key: 'gate.key', value: true });
    assert.ok(!result.isError, 'Expected bro to be allowed');

    db.close();
  });

  it('config_get called with agent=swe succeeds (read open to all)', async () => {
    const db = tempDB();
    const tools = configTools(db);

    await call(tools.handlers, 'config_set', { agent: 'bro', key: 'open.key', value: 'readable' });
    const result = await call(tools.handlers, 'config_get', { agent: 'bro', key: 'open.key' });
    assert.ok(!result.isError, 'Read should be open to all agents');
    assert.equal(parseResult(result), 'readable');

    db.close();
  });

  it('config_set without value returns a named validation error (#391)', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const result = await call(tools.handlers, 'config_set', { agent: 'bro', key: 'some.key' });
    assert.ok(result.isError, 'Expected error when value is missing');
    const payload = parseResult(result);
    assert.ok(
      typeof payload.error === 'string' && payload.error.includes('value'),
      `error should mention 'value', got: ${JSON.stringify(payload)}`,
    );

    db.close();
  });

  it('config_set with null value returns a named validation error', async () => {
    const db = tempDB();
    const tools = configTools(db);

    const result = await call(tools.handlers, 'config_set', { agent: 'bro', key: 'some.key', value: null });
    assert.ok(result.isError, 'Expected error when value is null');
    const payload = parseResult(result);
    assert.ok(
      typeof payload.error === 'string' && payload.error.includes('value'),
      `error should mention 'value', got: ${JSON.stringify(payload)}`,
    );

    db.close();
  });
});

describe('config_set — config_changed audit rows (SC2)', () => {
  type Row = { from_node: string; summary: string; content_json: string; issue_id: number };
  const rows = (db: ReturnType<typeof tempDB>) =>
    db.all<Row>("SELECT from_node, summary, content_json, issue_id FROM audit WHERE event_type = 'config_changed' ORDER BY id");

  it('writes one key-only row per changed value and none for an identical re-set', async () => {
    const db = tempDB();
    const tools = configTools(db);
    const valueA = 'alpha-value-one';
    const valueB = 'bravo-value-two';

    assert.ok(!(await call(tools.handlers, 'config_set', { agent: 'bro', key: 'acme.flag', value: valueA })).isError);
    assert.equal(rows(db).length, 1);
    const first = rows(db)[0]!;
    assert.equal(first.content_json, JSON.stringify({ key: 'acme.flag' }));
    assert.equal(first.summary, 'Config changed: acme.flag');
    assert.equal(first.from_node, 'bro');
    assert.equal(first.issue_id, -1);
    assert.ok(!JSON.stringify(first).includes(valueA));

    await call(tools.handlers, 'config_set', { agent: 'bro', key: 'acme.flag', value: valueA });
    assert.equal(rows(db).length, 1);

    await call(tools.handlers, 'config_set', { agent: 'bro', key: 'acme.flag', value: valueB });
    assert.equal(rows(db).length, 2);
    for (const v of [valueA, valueB]) assert.ok(!JSON.stringify(rows(db)).includes(v));

    db.close();
  });

  it('a rejected value writes neither the config nor an audit row', async () => {
    const db = tempDB();
    const tools = configTools(db);
    assert.ok((await call(tools.handlers, 'config_set', { agent: 'bro', key: 'acme.key', value: null })).isError);
    assert.equal(rows(db).length, 0);
    db.close();
  });

  it('a failing audit write rolls the config upsert back', async () => {
    const db = tempDB();
    const tools = configTools(db);
    db.run("CREATE TRIGGER fail_config_audit BEFORE INSERT ON audit WHEN NEW.event_type = 'config_changed' BEGIN SELECT RAISE(ABORT, 'audit down'); END");
    assert.ok((await call(tools.handlers, 'config_set', { agent: 'bro', key: 'acme.flag', value: 'on' })).isError);
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM plugin_config WHERE key = 'acme.flag'")?.n, 0);
    db.close();
  });

  it('GH 3029: bro_compact_nudge_tokens takes a non-negative integer and refuses any other shape', async () => {
    const db = tempDB();
    const tools = configTools(db);
    for (const value of [0, 80000, 250000]) {
      const r = await call(tools.handlers, 'config_set', { agent: 'bro', key: 'bro_compact_nudge_tokens', value });
      assert.ok(!r.isError, `accepts ${value}`);
      assert.equal(parseResult(await call(tools.handlers, 'config_get', { key: 'bro_compact_nudge_tokens' })), value);
    }
    for (const value of [-1, 1.5, '80000', true, [80000], { tokens: 80000 }]) {
      const r = await call(tools.handlers, 'config_set', { agent: 'bro', key: 'bro_compact_nudge_tokens', value });
      assert.ok(r.isError, `refuses ${JSON.stringify(value)}`);
      assert.match(r.content[0].text, /typed_field_violation/);
    }
    assert.equal(parseResult(await call(tools.handlers, 'config_get', { key: 'bro_compact_nudge_tokens' })), 250000);
    db.close();
  });

  it('GH 3029: parseBroCompactNudgeTokens reads unset or malformed as 80000', () => {
    assert.equal(parseBroCompactNudgeTokens(undefined), 80000);
    assert.equal(parseBroCompactNudgeTokens(''), 80000);
    assert.equal(parseBroCompactNudgeTokens('not json'), 80000);
    assert.equal(parseBroCompactNudgeTokens('-5'), 80000);
    assert.equal(parseBroCompactNudgeTokens('"9"'), 80000);
    assert.equal(parseBroCompactNudgeTokens('0'), 0);
    assert.equal(parseBroCompactNudgeTokens('120000'), 120000);
  });
});
