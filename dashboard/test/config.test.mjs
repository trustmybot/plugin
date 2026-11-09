// Config-edit test: create a temp trajectory DB with the trajectory server's own
// TrajectoryDB (schema.sql), start the built dashboard server against it and
// check GET /api/config lists the four editable keys (null when unset), that
// POST /api/config/:key writes through config_set with a Human audit row, and
// that a policy key, a bad value, a stale expected value, a foreign Origin and a
// missing token are refused with the stored value unchanged; then render the
// Settings tab and its save status, and unit-test the draft helpers.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const DASH = new URL('..', import.meta.url).pathname;
const DB_MODULE = join(DASH, '../mcp/trajectory-server/dist/db.js');
const SERVER = join(DASH, 'dist/server.mjs');

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-dashboard-config.')));
const DB = join(TMP, 'trajectory.db');
process.env.HOME = join(TMP, 'home');
process.env.TMB_DISABLE_REMOTE_SYNC = '1';
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.CLAUDE_PLUGIN_ROOT;
mkdirSync(process.env.HOME);

const noop = () => {};
const CLASSIFICATION = ['Bug', 'Feature', 'Improvement', 'Docs', 'Test', 'Chore'];
const PRIORITY = ['Priority: Urgent', 'Priority: High', 'Priority: Medium', 'Priority: Low'];

async function seed() {
  const { TrajectoryDB } = await import(DB_MODULE);
  const db = new TrajectoryDB(DB, { pluginVersion: null, serverLog: noop, sqlLog: noop });
  db.run(`DELETE FROM plugin_config WHERE key = 'issue_area_labels'`);
  db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('onboarded', 'true')`);
  db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('sandbox_enforcement', '"strict"')`);
  db.close();
}

function sql(query, ...params) {
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    return db.prepare(query).all(...params);
  } finally {
    db.close();
  }
}

const stored = (key) => sql('SELECT value_json FROM plugin_config WHERE key = ?', key)[0]?.value_json ?? null;
const configSnapshot = () => JSON.stringify(sql('SELECT key, value_json FROM plugin_config ORDER BY key'));
const humanRows = () =>
  sql(
    `SELECT event_type, summary, content_json FROM audit
     WHERE from_node = 'dashboard' AND json_extract(content_json, '$.actor') = 'human'
       AND json_extract(content_json, '$.source') = 'dashboard' ORDER BY id`,
  );

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

async function loadWeb() {
  const out = await build({
    stdin: {
      contents: `import { renderToStaticMarkup } from 'react-dom/server';
        import { createElement } from 'react';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { ApiError } from './web/api.ts';
        import { SaveStatus, SettingsView } from './web/views/settings/SettingsView.tsx';
        export { labelsValue, priceRows, pricesValue, saveProblem } from './web/views/settings/settings.ts';
        export { ApiError };
        const wrap = (client, el) => renderToStaticMarkup(createElement(QueryClientProvider, { client }, el));
        export function settings(config) {
          const client = new QueryClient();
          client.setQueryData(['config'], config);
          return wrap(client, createElement(SettingsView));
        }
        export const status = (props) => wrap(new QueryClient(), createElement(SaveStatus, { onReload: () => {}, saved: false, error: null, ...props }));`,
      resolveDir: DASH,
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(SERVER)});` },
    write: false,
    logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

describe('dashboard config editing', () => {
  let server;
  let URL_;
  let ORIGIN;
  let TOKEN;

  function http(method, path, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = request(`${URL_}${path}`, { method, headers }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, body: text, json: () => JSON.parse(text) }));
      });
      req.setTimeout(10_000, () => req.destroy(new Error(`${method} /${path} timed out`)));
      req.on('error', reject);
      req.end(body);
    });
  }

  const post = (key, body, { origin = ORIGIN, token = TOKEN } = {}) =>
    http('POST', `api/config/${key}`, {
      headers: { 'content-type': 'application/json', origin, 'x-tmb-token': token },
      body: JSON.stringify(body),
    });

  function expect(label, res, status, error) {
    assert.equal(res.status, status, `${label}: HTTP ${res.status}, want ${status} (${res.body})`);
    if (error !== undefined) assert.equal(res.json().error, error, `${label}: ${res.body}`);
  }

  const getConfig = async () => {
    const res = await http('GET', 'api/config');
    assert.equal(res.status, 200, res.body);
    return res.json();
  };

  before(async () => {
    assert.ok(existsSync(SERVER), `${SERVER} missing; run bun run build in dashboard/`);
    assert.ok(existsSync(DB_MODULE), `${DB_MODULE} missing; build mcp/trajectory-server`);
    await seed();
    server = await startServer();
    URL_ = server.url;
    ORIGIN = URL_.replace(/\/$/, '');
    TOKEN = /name="tmb-token" content="([0-9a-f]*)"/.exec((await http('GET', '')).body)?.[1];
    assert.ok(TOKEN, 'index.html carries a tmb-token meta tag');
  });
  after(async () => {
    await server?.stop();
    rmSync(TMP, { recursive: true, force: true });
  });

  test('GET /api/config lists exactly the four editable keys, null when unset', async () => {
    assert.deepEqual(await getConfig(), {
      keys: [
        { key: 'model_prices', value: {} },
        { key: 'issue_area_labels', value: null },
        { key: 'issue_classification_labels', value: CLASSIFICATION },
        { key: 'issue_priority_labels', value: PRIORITY },
      ],
    });
  });

  test('POST writes through config_set with a Human audit row', async () => {
    const prices = { 'claude-opus-5-5': { input: 15, output: 75, cache_read: 1.5, cache_creation: 18.75 } };
    const res = await post('model_prices', { value: prices, expected: {} });
    expect('model_prices write', res, 200);
    assert.deepEqual(res.json(), { ok: true, key: 'model_prices', value: prices, changed: true });
    assert.deepEqual(JSON.parse(stored('model_prices')), prices);

    expect('area labels from unset', await post('issue_area_labels', { value: ['dashboard', 'hooks'], expected: null }), 200);
    assert.deepEqual(JSON.parse(stored('issue_area_labels')), ['dashboard', 'hooks']);

    const config = await getConfig();
    assert.deepEqual(config.keys.find((k) => k.key === 'model_prices').value, prices);
    assert.deepEqual(config.keys.find((k) => k.key === 'issue_area_labels').value, ['dashboard', 'hooks']);

    const rows = humanRows();
    assert.equal(rows.length, 2, JSON.stringify(rows));
    for (const [row, key] of [[rows[0], 'model_prices'], [rows[1], 'issue_area_labels']]) {
      assert.equal(row.event_type, 'config_changed');
      assert.match(row.summary, /the Human ran config_set/);
      const content = JSON.parse(row.content_json);
      assert.deepEqual(content, { actor: 'human', source: 'dashboard', tool: 'config_set', fields: [key] });
    }
    const handlerRows = sql(`SELECT json_extract(content_json, '$.key') AS key FROM audit WHERE event_type = 'config_changed' AND from_node = 'bro' ORDER BY id`);
    assert.deepEqual(handlerRows.map((r) => r.key), ['model_prices', 'issue_area_labels'], 'config_set wrote its own audit row');

    const same = await post('issue_area_labels', { value: ['dashboard', 'hooks'], expected: ['dashboard', 'hooks'] });
    expect('identical value', same, 200);
    assert.equal(same.json().changed, false);
    assert.equal(humanRows().length, 2, 'an unchanged value leaves no Human audit row');
  });

  test('a policy key gets 403 policy_key and stays unchanged', async () => {
    const before = configSnapshot();
    for (const [key, value] of [['onboarded', false], ['sandbox_enforcement', 'off']]) {
      const res = await post(key, { value, expected: null });
      expect(`policy key ${key}`, res, 403, 'policy_key');
      assert.ok(res.json().editable.includes('model_prices'), res.body);
    }
    assert.equal(stored('onboarded'), 'true');
    assert.equal(stored('sandbox_enforcement'), '"strict"');
    assert.equal(configSnapshot(), before);
  });

  test('a key with characters outside the key alphabet is 403 policy_key, not 404', async () => {
    const before = configSnapshot();
    const audits = sql('SELECT COUNT(*) AS n FROM audit')[0].n;
    for (const key of ['on%20boarded', 'issue:labels', '%6Fnboarded', 'model%5Fprices', 'model_prices%00', 'model_prices/x', '', '%E2%9C%93', '%zz']) {
      const res = await post(key, { value: ['x'], expected: null });
      expect(`odd key ${JSON.stringify(key)}`, res, 403, 'policy_key');
    }
    assert.equal(configSnapshot(), before);
    assert.equal(sql('SELECT COUNT(*) AS n FROM audit')[0].n, audits, 'a refused key leaves no audit row');
  });

  test('a blank label row is refused at the row the user sees', async () => {
    const { labelsValue } = await loadWeb();
    const before = configSnapshot();
    const rows = ['Priority: High', ' ', 'Priority: Low'];
    const res = await post('issue_priority_labels', { value: labelsValue(rows), expected: PRIORITY });
    expect('blank second row', res, 422, 'invalid_value');
    assert.equal(res.json().field, 'value[1]', res.body);
    assert.match(res.json().message, /label 2 /);
    const first = await post('issue_priority_labels', { value: labelsValue(['', 'High', ' High ']), expected: PRIORITY });
    expect('blank first row', first, 422, 'invalid_value');
    assert.equal(first.json().field, 'value[0]', first.body);
    const dup = await post('issue_priority_labels', { value: labelsValue(['High', 'Low', ' High ']), expected: PRIORITY });
    expect('duplicate third row', dup, 422, 'invalid_value');
    assert.equal(dup.json().field, 'value[2]', dup.body);
    assert.equal(configSnapshot(), before);
  });

  test('a bad value gets 422 invalid_value naming the field', async () => {
    const before = configSnapshot();
    const audits = sql('SELECT COUNT(*) AS n FROM audit')[0].n;
    const cases = [
      ['issue_priority_labels', [], 'value'],
      ['issue_priority_labels', 'Priority: High', 'value'],
      ['issue_priority_labels', ['High', ''], 'value[1]'],
      ['issue_priority_labels', ['High', ' Low'], 'value[1]'],
      ['issue_priority_labels', ['High', 'High'], 'value[1]'],
      ['issue_priority_labels', ['High', 3], 'value[1]'],
      ['model_prices', [], 'value'],
      ['model_prices', { m: { input: -1, output: 1, cache_read: 1, cache_creation: 1 } }, 'value["m"].input'],
      ['model_prices', { m: { input: 1, output: '2', cache_read: 1, cache_creation: 1 } }, 'value["m"].output'],
      ['model_prices', { m: { input: 1, output: 1, cache_read: null, cache_creation: 1 } }, 'value["m"].cache_read'],
      ['model_prices', { m: { input: 1, output: 1, cache_read: 1 } }, 'value["m"].cache_creation'],
      ['model_prices', { m: { input: 1, output: 1, cache_read: 1, cache_creation: 1, extra: 1 } }, 'value["m"].extra'],
      ['model_prices', { m: 5 }, 'value["m"]'],
      ['model_prices', { ' ': { input: 1, output: 1, cache_read: 1, cache_creation: 1 } }, 'value[" "]'],
    ];
    for (const [key, value, field] of cases) {
      const current = (await getConfig()).keys.find((k) => k.key === key).value;
      const res = await post(key, { value, expected: current });
      expect(`${key} ${JSON.stringify(value)}`, res, 422, 'invalid_value');
      assert.equal(res.json().field, field, res.body);
    }
    expect('missing expected', await post('issue_priority_labels', { value: PRIORITY }), 400, 'expected_required');
    expect('unknown body field', await post('issue_priority_labels', { value: PRIORITY, expected: PRIORITY, key: 'onboarded' }), 400, 'unknown_fields');
    assert.equal(configSnapshot(), before);
    assert.equal(sql('SELECT COUNT(*) AS n FROM audit')[0].n, audits, 'a refused value leaves no audit row');
  });

  test('a stale expected value gets 409 with the current value', async () => {
    const before = configSnapshot();
    const res = await post('issue_priority_labels', { value: ['P1', 'P2'], expected: ['P1'] });
    expect('stale write', res, 409, 'stale');
    assert.deepEqual(res.json().current, PRIORITY);
    expect('stale unset expectation', await post('issue_area_labels', { value: ['x'], expected: null }), 409, 'stale');
    expect('empty prices expected after a write', await post('model_prices', { value: {}, expected: {} }), 409, 'stale');
    assert.equal(configSnapshot(), before);
  });

  test('a foreign Origin or a missing token is refused', async () => {
    const before = configSnapshot();
    const body = { value: ['P1'], expected: PRIORITY };
    expect('foreign Origin', await post('issue_priority_labels', body, { origin: 'http://evil.example' }), 403, 'forbidden_origin');
    expect('no token', await post('issue_priority_labels', body, { token: '' }), 403, 'bad_token');
    expect('wrong token', await post('issue_priority_labels', body, { token: 'deadbeef' }), 403, 'bad_token');
    expect('policy key with no token', await post('onboarded', { value: false, expected: true }, { token: '' }), 403, 'bad_token');
    const noOrigin = await http('POST', 'api/config/issue_priority_labels', {
      headers: { 'content-type': 'application/json', 'x-tmb-token': TOKEN },
      body: JSON.stringify(body),
    });
    expect('no Origin', noOrigin, 403, 'forbidden_origin');
    assert.equal(configSnapshot(), before);
    assert.deepEqual(JSON.parse(stored('issue_priority_labels')), PRIORITY);
  });
});

describe('settings tab', async () => {
  const web = await loadWeb();
  const config = {
    keys: [
      { key: 'model_prices', value: { 'claude-opus-5-5': { input: 15, output: 75, cache_read: 1.5, cache_creation: 18.75 } } },
      { key: 'issue_area_labels', value: null },
      { key: 'issue_classification_labels', value: CLASSIFICATION },
      { key: 'issue_priority_labels', value: PRIORITY },
    ],
  };

  test('renders the four keys with their values and a Save button each', () => {
    const html = web.settings(config);
    for (const key of ['model_prices', 'issue_area_labels', 'issue_classification_labels', 'issue_priority_labels']) {
      assert.ok(html.includes(`data-config-key="${key}"`), `${key} section missing`);
    }
    for (const title of ['Model Prices', 'Area Labels', 'Classification Labels', 'Priority Labels']) assert.ok(html.includes(title), title);
    assert.equal(html.match(/type="submit"/g)?.length, 4);
    assert.ok(html.includes('value="claude-opus-5-5"'));
    assert.ok(html.includes('value="18.75"'));
    assert.ok(html.includes('value="Priority: Urgent"'));
    assert.ok(html.includes('is not set.'), 'an unset key says so');
    assert.ok(html.includes('/onboard'), 'policy keys point to /onboard');
  });

  test('a 409 shows a reload prompt and a 422 an inline error', () => {
    const stale = web.status({ error: new web.ApiError(409, { error: 'stale', message: 'changed', current: ['x'] }) });
    assert.match(stale, /changed since you loaded it/);
    assert.match(stale, />Reload</);
    const invalid = web.status({ error: new web.ApiError(422, { error: 'invalid_value', message: 'm input must be a number', field: 'value["m"].input' }) });
    assert.match(invalid, /m input must be a number/);
    assert.ok(invalid.includes('value[&quot;m&quot;].input'), invalid);
    assert.doesNotMatch(invalid, /Reload/);
    assert.match(web.status({ saved: true }), /Saved\./);
    assert.equal(web.status({}), '');
  });

  test('saveProblem reads the API errors', () => {
    assert.deepEqual(web.saveProblem(new web.ApiError(409, { error: 'stale', current: [1] })), { kind: 'stale', current: [1] });
    assert.deepEqual(web.saveProblem(new web.ApiError(422, { error: 'invalid_value', message: 'bad', field: 'value' })), {
      kind: 'invalid',
      message: 'bad',
      field: 'value',
    });
    assert.equal(web.saveProblem(new web.ApiError(409, { error: 'schema_version_mismatch', message: 'old' })).kind, 'error');
    assert.equal(web.saveProblem(null), null);
  });

  test('draft helpers build the value the server takes', () => {
    const rows = web.priceRows(config.keys[0].value);
    assert.deepEqual(rows, [{ model: 'claude-opus-5-5', input: '15', output: '75', cache_read: '1.5', cache_creation: '18.75' }]);
    assert.deepEqual(web.pricesValue(rows), { value: config.keys[0].value });
    assert.deepEqual(web.pricesValue([{ ...rows[0], input: '' }]).value['claude-opus-5-5'].input, null);
    assert.match(web.pricesValue([{ ...rows[0], model: ' ' }]).error, /Row 1 needs a model id/);
    assert.match(web.pricesValue([rows[0], { ...rows[0], model: ' claude-opus-5-5 ' }]).error, /listed twice/);
    assert.deepEqual(web.pricesValue([]), { value: {} });
    assert.deepEqual(web.labelsValue([' Bug ', '', 'Feature']), ['Bug', '', 'Feature']);
  });
});
