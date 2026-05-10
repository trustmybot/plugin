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
  it('identity_get on empty table returns onboarded=false', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const result = await call(tools.handlers, 'identity_get', {});
    assert.ok(!result.isError);
    const data = parseResult(result);
    assert.equal(data.onboarded, false);
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

  it('identity_set marks the project as onboarded; row created at id=1 with timestamps', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const setResult = await call(tools.handlers, 'identity_set', { agent: 'bro' });
    assert.ok(!setResult.isError);
    const set = parseResult(setResult);
    assert.equal(set.onboarded, true);
    assert.ok(set.created_at, 'created_at must be set');
    assert.ok(set.updated_at, 'updated_at must be set');

    const getResult = await call(tools.handlers, 'identity_get', {});
    const got = parseResult(getResult);
    assert.equal(got.onboarded, true);

    db.close();
  });

  it('identity_set is idempotent — second call updates updated_at, leaves created_at', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const first = parseResult(await call(tools.handlers, 'identity_set', { agent: 'bro' }));
    // Wait one tick so the timestamp moves.
    await new Promise((r) => setTimeout(r, 10));
    const second = parseResult(await call(tools.handlers, 'identity_set', { agent: 'bro' }));

    assert.equal(first.created_at, second.created_at, 'created_at must be stable across re-set');
    assert.ok(second.updated_at >= first.updated_at, 'updated_at must monotonically advance');

    db.close();
  });

  it('identity_reset clears the row; identity_get returns onboarded=false again', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    await call(tools.handlers, 'identity_set', { agent: 'bro' });

    const resetResult = await call(tools.handlers, 'identity_reset', { agent: 'bro' });
    assert.ok(!resetResult.isError);
    assert.deepEqual(parseResult(resetResult), { ok: true });

    const getResult = await call(tools.handlers, 'identity_get', {});
    const data = parseResult(getResult);
    assert.equal(data.onboarded, false);

    db.close();
  });

  it('identity_reset on already-empty table: no-op, returns { ok: true }', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const result = await call(tools.handlers, 'identity_reset', { agent: 'bro' });
    assert.ok(!result.isError);
    assert.deepEqual(parseResult(result), { ok: true });

    db.close();
  });

  it('identity_set called with agent=swe returns forbidden; row unchanged', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const result = await call(tools.handlers, 'identity_set', { agent: 'swe' });
    assert.ok(result.isError, 'Expected forbidden error');
    const payload = parseResult(result);
    assert.equal(payload.error, 'forbidden');
    assert.equal(payload.caller_role, 'swe');

    const row = db.get('SELECT * FROM identity LIMIT 1');
    assert.equal(row, undefined, 'Row must not be created when forbidden');

    db.close();
  });

  it('identity_set called with agent=bro succeeds', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const result = await call(tools.handlers, 'identity_set', { agent: 'bro' });
    assert.ok(!result.isError, 'Expected success for bro');
    assert.equal(parseResult(result).onboarded, true);

    db.close();
  });

  it('identity table CHECK constraint: INSERT id=2 via raw SQL fails', async () => {
    const db = tempDB();
    const now = new Date().toISOString();

    assert.throws(
      () =>
        db.run(
          `INSERT INTO identity (id, created_at, updated_at) VALUES (2, ?, ?)`,
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
