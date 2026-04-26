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
  it('identity_get on empty table returns default with human_name=null', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const result = await call(tools.handlers, 'identity_get', {});
    assert.ok(!result.isError);
    const data = parseResult(result);
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

  it('identity_set with human_name persists; row created', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const setResult = await call(tools.handlers, 'identity_set', { agent: 'bro', human_name: 'Alice' });
    assert.ok(!setResult.isError);
    const set = parseResult(setResult);
    assert.equal(set.human_name, 'Alice');

    const getResult = await call(tools.handlers, 'identity_get', {});
    const got = parseResult(getResult);
    assert.equal(got.human_name, 'Alice');

    db.close();
  });

  it('identity_set with invalid human_name: empty string', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const result = await call(tools.handlers, 'identity_set', { agent: 'bro', human_name: '' });
    assert.ok(result.isError, 'Expected error for empty human_name');
    assert.match(parseResult(result).error, /Invalid human_name/);

    db.close();
  });

  it('identity_set with invalid human_name: 33 characters', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const longName = 'a'.repeat(33);
    const result = await call(tools.handlers, 'identity_set', { agent: 'bro', human_name: longName });
    assert.ok(result.isError, 'Expected error for 33-char name');
    assert.match(parseResult(result).error, /Invalid human_name/);

    db.close();
  });

  it('identity_set with invalid human_name: control character', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const result = await call(tools.handlers, 'identity_set', { agent: 'bro', human_name: 'bad\x01name' });
    assert.ok(result.isError, 'Expected error for control char in name');
    assert.match(parseResult(result).error, /Invalid human_name/);

    db.close();
  });

  it('identity_reset clears the row; identity_get returns defaults again', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    await call(tools.handlers, 'identity_set', { agent: 'bro', human_name: 'Alice' });

    const resetResult = await call(tools.handlers, 'identity_reset', { agent: 'bro' });
    assert.ok(!resetResult.isError);
    assert.deepEqual(parseResult(resetResult), { ok: true });

    const getResult = await call(tools.handlers, 'identity_get', {});
    const data = parseResult(getResult);
    assert.equal(data.human_name, null);
    assert.equal(data.created_at, null);
    assert.equal(data.updated_at, null);

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

  it('identity_set with no args (probe): no-op, returns current state', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    await call(tools.handlers, 'identity_set', { agent: 'bro', human_name: 'Alice' });
    const result = await call(tools.handlers, 'identity_set', { agent: 'bro' });
    assert.ok(!result.isError);
    const data = parseResult(result);
    assert.equal(data.human_name, 'Alice');

    db.close();
  });

  it('identity_set with anonymous=true: writes row with human_name=null and non-null timestamps (issue #95)', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const setResult = await call(tools.handlers, 'identity_set', { agent: 'bro', anonymous: true });
    assert.ok(!setResult.isError);
    const set = parseResult(setResult);
    assert.equal(set.human_name, null);
    assert.ok(set.created_at, 'created_at must be set');
    assert.ok(set.updated_at, 'updated_at must be set');

    // Critical: the next identity_get must NOT look like "uninitialized".
    // First-action chain checks `created_at != null` to decide onboarded vs not.
    const getResult = await call(tools.handlers, 'identity_get', {});
    const got = parseResult(getResult);
    assert.equal(got.human_name, null);
    assert.ok(got.created_at, 'created_at non-null is the "onboarded" signal');

    // Row exists in DB.
    const row = db.get<{ id: number; human_name: string | null }>('SELECT * FROM identity WHERE id=1');
    assert.ok(row, 'Anonymous identity must persist a row');
    assert.equal(row.human_name, null);

    db.close();
  });

  it('identity_set with anonymous=true on existing named identity: updates to anonymous', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    await call(tools.handlers, 'identity_set', { agent: 'bro', human_name: 'Alice' });
    const setResult = await call(tools.handlers, 'identity_set', { agent: 'bro', anonymous: true });
    assert.ok(!setResult.isError);
    const set = parseResult(setResult);
    assert.equal(set.human_name, null);

    db.close();
  });

  it('identity_set rejects both human_name AND anonymous in same call', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const result = await call(tools.handlers, 'identity_set', {
      agent: 'bro',
      human_name: 'Alice',
      anonymous: true,
    });
    assert.ok(result.isError, 'Must reject ambiguous call');
    assert.match(parseResult(result).error, /pass either human_name OR anonymous/);

    db.close();
  });

  it('identity_set with anonymous=false (explicit) is treated as no-op probe, not write', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const result = await call(tools.handlers, 'identity_set', { agent: 'bro', anonymous: false });
    assert.ok(!result.isError);
    const data = parseResult(result);
    assert.equal(data.created_at, null, 'no row should have been written');

    const row = db.get('SELECT * FROM identity LIMIT 1');
    assert.equal(row, undefined, 'anonymous=false must not write a row');

    db.close();
  });

  it('identity_set called with agent=swe returns forbidden; row unchanged', async () => {
    const db = tempDB();
    const tools = identityTools(db);

    const result = await call(tools.handlers, 'identity_set', { agent: 'swe', human_name: 'hacked' });
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

    const result = await call(tools.handlers, 'identity_set', { agent: 'bro', human_name: 'Alice' });
    assert.ok(!result.isError, 'Expected success for bro');
    assert.equal(parseResult(result).human_name, 'Alice');

    db.close();
  });

  it('identity table CHECK constraint: INSERT id=2 via raw SQL fails', async () => {
    const db = tempDB();
    const now = new Date().toISOString();

    assert.throws(
      () =>
        db.run(
          `INSERT INTO identity (id, human_name, created_at, updated_at) VALUES (2, 'other', ?, ?)`,
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
