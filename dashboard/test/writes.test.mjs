// Write-path test: create a temp trajectory DB with the trajectory server's own
// TrajectoryDB (schema.sql), start the built dashboard server on a free port
// with a fake HOME, and check every Human write — edits, a comment, a close and
// a refused close — lands through the trajectory-server handlers with a
// source=dashboard audit row, and that the token, Origin, Host, body-size,
// stale updated_at and schema-version guards refuse what they should.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DASH = new URL('..', import.meta.url).pathname;
const DB_MODULE = join(DASH, '../mcp/trajectory-server/dist/db.js');
const SERVER = join(DASH, 'dist/server.mjs');

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-dashboard-writes.')));
const DB = join(TMP, 'trajectory.db');
process.env.HOME = join(TMP, 'home');
process.env.TMB_DISABLE_REMOTE_SYNC = '1';
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.CLAUDE_PLUGIN_ROOT;
mkdirSync(process.env.HOME);

const noop = () => {};

async function seed() {
  const { TrajectoryDB } = await import(DB_MODULE);
  const db = new TrajectoryDB(DB, { pluginVersion: null, serverLog: noop, sqlLog: noop });
  const now = new Date().toISOString();
  const issue = (objective) =>
    Number(
      db.run(`INSERT INTO issues (objective, labels, created_at, updated_at) VALUES (?, '["Feature","Priority: Low"]', ?, ?)`, [
        objective,
        now,
        now,
      ]).lastInsertRowid,
    );
  const edit = issue('Writes test issue');
  const live = issue('Issue with a live task');
  const empty = issue('Issue with no tasks');
  db.run(
    `INSERT INTO tasks (issue_id, branch_id, title, description, status, created_at, updated_at)
     VALUES (?, 'feat/writes', 'Live task', 'd', 'running', ?, ?)`,
    [live, now, now],
  );
  db.close();
  return { EDIT: edit, LIVE: live, EMPTY: empty };
}

function sql(query, ...params) {
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    return JSON.stringify(db.prepare(query).all(...params));
  } finally {
    db.close();
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, TRAJECTORY_DB_PATH: DB, TMB_DASHBOARD_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (chunk) => {
      out += chunk;
      const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(out)?.[0];
      if (url) resolve({ url, stop: () => new Promise((done) => (child.once('exit', done), child.kill())) });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => reject(new Error(`server did not start (exit ${code}): ${out}`)));
  });
}

describe('dashboard writes', () => {
  let ids;
  let server;
  let URL_;
  let ORIGIN;
  let PORT;
  let TOKEN;

  /** One HTTP exchange with exactly the given headers: { status, body }. */
  function http(method, path, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = request(`${URL_}${path}`, { method, headers }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      });
      req.setTimeout(10_000, () => req.destroy(new Error(`${method} /${path} timed out`)));
      req.on('error', reject);
      req.end(body);
    });
  }

  const post = (path, json, origin = ORIGIN, token = TOKEN) =>
    http('POST', path, { headers: { 'content-type': 'application/json', origin, 'x-tmb-token': token }, body: json });

  function expect(label, res, status, want) {
    assert.equal(res.status, status, `${label}: HTTP ${res.status}, want ${status} (${res.body})`);
    if (want !== undefined) assert.ok(res.body.includes(want), `${label}: body lacks ${want} (${res.body})`);
  }

  function expectSql(label, query, want, ...params) {
    const got = sql(query, ...params);
    assert.ok(got.includes(want), `${label}: ${got} lacks ${want}`);
  }

  async function updatedAt(id) {
    return JSON.parse((await http('GET', `api/issues/${id}`)).body).issue.updated_at;
  }

  const auditFor = (id) =>
    sql(
      `SELECT json_extract(content_json, '$.tool') AS tool FROM audit
       WHERE issue_id = ? AND from_node = 'dashboard'
         AND json_extract(content_json, '$.source') = 'dashboard'
         AND json_extract(content_json, '$.actor') = 'human'
       ORDER BY id`,
      id,
    );

  const edit = async (fields) => post(`api/issues/${ids.EDIT}/edit`, JSON.stringify({ updated_at: await updatedAt(ids.EDIT), ...fields }));

  before(async () => {
    assert.ok(existsSync(SERVER), `${SERVER} missing; run bun run build in dashboard/`);
    assert.ok(existsSync(DB_MODULE), `${DB_MODULE} missing; build mcp/trajectory-server`);
    ids = await seed();
    server = await startServer();
    URL_ = server.url;
    ORIGIN = URL_.replace(/\/$/, '');
    PORT = ORIGIN.split(':').at(-1);
    TOKEN = /name="tmb-token" content="([0-9a-f]*)"/.exec((await http('GET', '')).body)?.[1];
    assert.ok(TOKEN, 'index.html carries a tmb-token meta tag');
  });
  after(async () => {
    await server?.stop();
    rmSync(TMP, { recursive: true, force: true });
  });

  test('edits', async () => {
    const E = ids.EDIT;
    expect('objective edit', await edit({ objective: 'Edited objective' }), 200, '"tools":["issue_update"]');
    expectSql('objective landed', `SELECT objective FROM issues WHERE id = ?`, '"Edited objective"', E);

    expect('description edit', await edit({ description: 'Edited description' }), 200, '"tools":["issue_update_description"]');
    expectSql('description landed', `SELECT description FROM issues WHERE id = ?`, '"Edited description"', E);

    expect('priority edit', await edit({ labels: ['Feature', 'Priority: High'] }), 200);
    expectSql('priority landed', `SELECT labels FROM issues WHERE id = ?`, 'Priority: High', E);

    expect('labels edit', await edit({ labels: ['Bug', 'Priority: High', 'ux'] }), 200);
    expectSql('labels landed', `SELECT labels FROM issues WHERE id = ?`, String.raw`[\"Bug\",\"Priority: High\",\"ux\"]`, E);

    expect('milestone edit', await edit({ milestone: 'v9.9.9' }), 200);
    expectSql('milestone landed', `SELECT milestone FROM issues WHERE id = ?`, '"milestone":"v9.9.9"', E);

    expectSql(
      'an audit row with source=dashboard per edit',
      `SELECT COUNT(*) AS n FROM audit WHERE issue_id = ? AND json_extract(content_json, '$.source') = 'dashboard'`,
      '"n":5',
      E,
    );
    assert.equal(
      auditFor(E),
      '[{"tool":"issue_update"},{"tool":"issue_update_description"},{"tool":"issue_update"},{"tool":"issue_update"},{"tool":"issue_update"}]',
      'audit rows name the handler, actor=human',
    );

    expect('handler validation error is returned', await edit({ labels: ['Bug'] }), 422, 'missing_required_labels');

    expect(
      'stale updated_at',
      await post(`api/issues/${E}/edit`, '{"updated_at":"2000-01-01T00:00:00.000Z","objective":"Stale write"}'),
      409,
      '"error":"stale"',
    );
    expectSql('stale edit did not land', `SELECT objective FROM issues WHERE id = ?`, '"Edited objective"', E);

    expect('edit without updated_at', await post(`api/issues/${E}/edit`, '{"objective":"No version"}'), 400, 'updated_at_required');

    expect(
      'objective and description in one edit',
      await edit({ objective: 'Both fields', description: 'Both description' }),
      200,
      '"tools":["issue_update","issue_update_description"]',
    );
    expectSql(
      'both fields landed',
      `SELECT objective, description FROM issues WHERE id = ?`,
      '"objective":"Both fields","description":"Both description"',
      E,
    );

    expect(
      'close refuses a cascade field',
      await post(`api/issues/${E}/close`, JSON.stringify({ updated_at: await updatedAt(E), cascade: true })),
      400,
      'unknown_fields',
    );
  });

  test('comment', async () => {
    const E = ids.EDIT;
    expect('comment', await post(`api/issues/${E}/comment`, '{"body":"A Human comment from the dashboard"}'), 200, '"tools":["discussion_append"]');
    expectSql(
      'comment landed as author=dashboard kind=note',
      `SELECT author, kind FROM discussions WHERE issue_id = ? AND body = 'A Human comment from the dashboard'`,
      '[{"author":"dashboard","kind":"note"}]',
      E,
    );
    expectSql(
      'comment audit row',
      `SELECT COUNT(*) AS n FROM audit WHERE issue_id = ? AND json_extract(content_json, '$.tool') = 'discussion_append' AND json_extract(content_json, '$.source') = 'dashboard'`,
      '"n":1',
      E,
    );
  });

  test('close', async () => {
    const { LIVE, EMPTY } = ids;
    const refused = await post(`api/issues/${LIVE}/close`, JSON.stringify({ updated_at: await updatedAt(LIVE) }));
    expect('close with a live task is refused', refused, 422, '"error":"issue_has_open_tasks"');
    assert.ok(refused.body.includes('"status":"running"'), `refusal lists the blocking task: ${refused.body}`);
    expectSql('refused issue stays open', `SELECT status FROM issues WHERE id = ?`, '"open"', LIVE);
    expectSql('refused close left the task alone', `SELECT status FROM tasks WHERE issue_id = ?`, '"running"', LIVE);

    expect('close with no tasks', await post(`api/issues/${EMPTY}/close`, JSON.stringify({ updated_at: await updatedAt(EMPTY) })), 200, '"issue_status":"closed"');
    expectSql('issue closed', `SELECT status FROM issues WHERE id = ?`, '"closed"', EMPTY);
    assert.equal(auditFor(EMPTY), '[{"tool":"issue_close"}]', 'close audit row');
  });

  test('guards', async () => {
    const E = ids.EDIT;
    expect('POST without token', await post(`api/issues/${E}/comment`, '{"body":"no token"}', ORIGIN, ''), 403, 'bad_token');
    expect('POST with a wrong token', await post(`api/issues/${E}/comment`, '{"body":"wrong token"}', ORIGIN, 'deadbeef'), 403, 'bad_token');
    expect('POST with a foreign Origin', await post(`api/issues/${E}/comment`, '{"body":"foreign"}', 'http://evil.example'), 403, 'forbidden_origin');
    expect(
      'POST with another loopback Origin',
      await post(`api/issues/${E}/comment`, '{"body":"localhost"}', `http://localhost:${PORT}`),
      403,
      'forbidden_origin',
    );
    const noOrigin = await http('POST', `api/issues/${E}/comment`, {
      headers: { 'content-type': 'application/json', 'x-tmb-token': TOKEN },
      body: '{"body":"no origin"}',
    });
    assert.equal(noOrigin.status, 403, `POST without Origin: HTTP ${noOrigin.status}`);
    expectSql('guarded comments did not land', `SELECT COUNT(*) AS n FROM discussions WHERE issue_id = ? AND author = 'dashboard'`, '"n":1', E);

    for (const path of [
      'api/tasks', 'api/tasks/1', 'api/tasks/1/edit', 'api/plugin_config', 'api/config',
      'api/issues', 'api/issues/create', `api/issues/${E}/create`, `api/issues/${E}/reopen`,
      `api/issues/${E}/delete`, `api/issues/${E}/force_close`, 'api/issues/-1/comment',
    ]) {
      expect(`no write endpoint: POST /${path}`, await post(path, '{}'), 404);
    }
    const put = await http('PUT', `api/issues/${E}`);
    assert.equal(put.status, 405, `PUT: HTTP ${put.status}`);

    for (const path of ['', `api/issues/${E}`]) {
      const r = await http('GET', path, { headers: { host: `evil.example:${PORT}` } });
      assert.equal(r.status, 403, `GET /${path} with a foreign Host: HTTP ${r.status}`);
      assert.ok(!r.body.includes(TOKEN), `GET /${path} with a foreign Host leaks no token`);
    }

    const big = `{"body":"${'a'.repeat(3 * 1024 * 1024)}"}\n`;
    expect('oversized POST receives the 413', await post(`api/issues/${E}/comment`, big), 413, 'body_too_large');
    expect('a normal write after the 413 still lands', await post(`api/issues/${E}/comment`, '{"body":"after the 413"}'), 200);
  });

  test('a body over the drain cap gets its socket destroyed, no response', async () => {
    const huge = `{"body":"${'a'.repeat(16 * 1024 * 1024)}"}\n`;
    const outcome = await post(`api/issues/${ids.EDIT}/comment`, huge).then(
      (res) => `HTTP ${res.status}`,
      (err) => err.code,
    );
    assert.ok(['ECONNRESET', 'EPIPE'].includes(outcome), `over the drain cap: ${outcome}, want the connection reset or closed`);
  });

  test('a body still arriving at the drain timeout gets its socket destroyed, no response', async () => {
    const socket = connect(Number(PORT), '127.0.0.1');
    socket.on('error', noop);
    let received = '';
    socket.on('data', (d) => (received += d));
    const start = Date.now();
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.write(
      `POST /api/issues/${ids.EDIT}/comment HTTP/1.1\r\nhost: 127.0.0.1:${PORT}\r\norigin: ${ORIGIN}\r\n` +
        `x-tmb-token: ${TOKEN}\r\ncontent-type: application/json\r\ncontent-length: ${6 * 1024 * 1024}\r\n\r\n`,
    );
    socket.write('a'.repeat(3 * 1024 * 1024));
    const timeout = setTimeout(() => socket.destroy(), 10_000);
    await closed;
    clearTimeout(timeout);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 8_000, `the server held the stalled socket ${elapsed} ms`);
    assert.equal(received, '', 'the stalled request got no response');
  });

  test('schema version', async () => {
    const db = new DatabaseSync(DB);
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('UPDATE plugin_meta SET schema_version = schema_version - 1 WHERE id = 1').run();
    db.close();
    expect('schema-version mismatch', await post(`api/issues/${ids.EDIT}/comment`, '{"body":"after a schema change"}'), 409, 'schema_version_mismatch');
    expectSql('mismatched write did not land', "SELECT COUNT(*) AS n FROM discussions WHERE body = 'after a schema change'", '"n":0');
  });

  test("the dashboard's TrajectoryDB open refuses an older DB and leaves it unmigrated with no backup", async () => {
    await server.stop();
    server = undefined;
    const { TrajectoryDB, TARGET_SCHEMA_VERSION } = await import(DB_MODULE);
    let refused = false;
    try {
      new TrajectoryDB(DB, { pluginVersion: null, serverLog: noop, sqlLog: noop }).close();
    } catch (error) {
      refused = /only the trajectory-server migrates/.test(String(error));
    }
    assert.ok(refused, 'opened without refusing');
    const raw = new DatabaseSync(DB, { readOnly: true });
    const { schema_version } = raw.prepare('SELECT schema_version FROM plugin_meta WHERE id = 1').get();
    raw.close();
    assert.equal(schema_version, TARGET_SCHEMA_VERSION - 1, `migrated to ${schema_version}`);
    assert.ok(!readdirSync(TMP).some((f) => f.endsWith('.bak')), 'opening an older DB wrote a pre-migration backup');
  });

  test('dashboard/server/*.ts carries no write SQL', () => {
    const dir = join(DASH, 'server');
    const hits = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) =>
        readFileSync(join(dir, f), 'utf8')
          .split('\n')
          .filter((line) => /INSERT|UPDATE|DELETE/.test(line) && !(f === 'queries.ts' && /^\s*\/\//.test(line)))
          .map((line) => `${f}:${line}`),
      );
    assert.deepEqual(hits, []);
  });
});
