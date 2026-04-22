import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { identityTools } from '../tools/identity.js';

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

describe('identityTools', () => {
  it('identity_get on empty table returns default with gatekeeper_name=bro', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const result = await call(tools.handlers, 'identity_get', {});
    assert.ok(!result.isError);
    const data = parseResult(result);
    assert.equal(data.gatekeeper_name, 'bro');
    assert.equal(data.human_name, null);
    assert.equal(data.created_at, null);
    assert.equal(data.updated_at, null);

    db.close();
  });

  it('identity_get on empty table does not seed a row', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    await call(tools.handlers, 'identity_get', {});
    const row = db.get('SELECT * FROM identity LIMIT 1');
    assert.equal(row, undefined, 'identity_get must not seed a row');

    db.close();
  });

  it('identity_set with gatekeeper_name only: persists; human_name still null', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const setResult = await call(tools.handlers, 'identity_set', { gatekeeper_name: 'mybot' });
    assert.ok(!setResult.isError);
    const set = parseResult(setResult);
    assert.equal(set.gatekeeper_name, 'mybot');
    assert.equal(set.human_name, null);

    const getResult = await call(tools.handlers, 'identity_get', {});
    const got = parseResult(getResult);
    assert.equal(got.gatekeeper_name, 'mybot');
    assert.equal(got.human_name, null);

    db.close();
  });

  it('identity_set with human_name only after gatekeeper_name: gatekeeper_name preserved', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    await call(tools.handlers, 'identity_set', { gatekeeper_name: 'mybot' });
    await call(tools.handlers, 'identity_set', { human_name: 'Alice' });

    const result = await call(tools.handlers, 'identity_get', {});
    const data = parseResult(result);
    assert.equal(data.gatekeeper_name, 'mybot', 'gatekeeper_name must be preserved (COALESCE)');
    assert.equal(data.human_name, 'Alice');

    db.close();
  });

  it('identity_set with invalid gatekeeper_name: empty string', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const result = await call(tools.handlers, 'identity_set', { gatekeeper_name: '' });
    assert.ok(result.isError, 'Expected error for empty gatekeeper_name');
    assert.match(parseResult(result).error, /Invalid gatekeeper_name/);

    db.close();
  });

  it('identity_set with invalid gatekeeper_name: 33 characters', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const longName = 'a'.repeat(33);
    const result = await call(tools.handlers, 'identity_set', { gatekeeper_name: longName });
    assert.ok(result.isError, 'Expected error for 33-char name');
    assert.match(parseResult(result).error, /Invalid gatekeeper_name/);

    db.close();
  });

  it('identity_set with invalid gatekeeper_name: control character', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const result = await call(tools.handlers, 'identity_set', { gatekeeper_name: 'bad\x01name' });
    assert.ok(result.isError, 'Expected error for control char in name');
    assert.match(parseResult(result).error, /Invalid gatekeeper_name/);

    db.close();
  });

  it('identity_set with invalid human_name: empty string', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const result = await call(tools.handlers, 'identity_set', { human_name: '' });
    assert.ok(result.isError, 'Expected error for empty human_name');
    assert.match(parseResult(result).error, /Invalid human_name/);

    db.close();
  });

  it('identity_reset clears the row; identity_get returns defaults again', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    await call(tools.handlers, 'identity_set', { gatekeeper_name: 'mybot', human_name: 'Alice' });

    const resetResult = await call(tools.handlers, 'identity_reset', {});
    assert.ok(!resetResult.isError);
    assert.deepEqual(parseResult(resetResult), { ok: true });

    const getResult = await call(tools.handlers, 'identity_get', {});
    const data = parseResult(getResult);
    assert.equal(data.gatekeeper_name, 'bro');
    assert.equal(data.human_name, null);
    assert.equal(data.created_at, null);
    assert.equal(data.updated_at, null);

    db.close();
  });

  it('identity_reset on already-empty table: no-op, returns { ok: true }', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const result = await call(tools.handlers, 'identity_reset', {});
    assert.ok(!result.isError);
    assert.deepEqual(parseResult(result), { ok: true });

    db.close();
  });

  it('identity_set with both fields omitted: no-op, returns current state', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    await call(tools.handlers, 'identity_set', { gatekeeper_name: 'mybot' });
    const result = await call(tools.handlers, 'identity_set', {});
    assert.ok(!result.isError);
    const data = parseResult(result);
    assert.equal(data.gatekeeper_name, 'mybot');

    db.close();
  });

  it('identity table CHECK constraint: INSERT id=2 via raw SQL fails', async () => {
    const db = tempDB();
    const now = new Date().toISOString();

    assert.throws(
      () =>
        db.run(
          `INSERT INTO identity (id, gatekeeper_name, created_at, updated_at) VALUES (2, 'other', ?, ?)`,
          [now, now],
        ),
      (e: Error) => {
        assert.ok(
          e.message.includes('SQLITE_CONSTRAINT') || e.message.toLowerCase().includes('constraint'),
          `Expected constraint error, got: ${e.message}`,
        );
        return true;
      },
    );

    db.close();
  });
});
