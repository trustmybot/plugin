// Insights Change impact test (GH 2600): seed a temp trajectory DB from
// schema.sql with bro sessions on three plugin versions (the second cuts bro
// tokens, the third holds them) and a `repos` row whose temp git repo has two
// CLAUDE.md commits, so both change sources list changes. Check that
// GET /api/insights/change-impact deep-equals computeChangeImpact on the same
// DB in its list and detail forms, its 400s and 404, that the DB file is
// unchanged after the requests, and render the Change impact section to
// static HTML.
process.env.TZ = 'America/Los_Angeles';

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const DASH = new URL('..', import.meta.url).pathname;
const SCHEMA = join(DASH, '../mcp/trajectory-server/src/schema.sql');
const SERVER = join(DASH, 'dist/server.mjs');

const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tmb-dashboard-change-impact-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const REPO = join(tmp, 'proj');
const DB_PATH = join(tmp, 'trajectory.db');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2025-03-01T00:00:00.000Z');
const iso = (t) => new Date(t).toISOString();

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (args, env = {}) =>
  execFileSync('git', ['-C', REPO, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: { ...GIT_ENV, ...env } }).trim();

function commit(subject, path, at) {
  mkdirSync(join(REPO, path, '..'), { recursive: true });
  writeFileSync(join(REPO, path), `${subject}\n`);
  git(['add', '-A']);
  git(['commit', '-q', '-m', subject], { GIT_AUTHOR_DATE: iso(at), GIT_COMMITTER_DATE: iso(at) });
  return git(['rev-parse', 'HEAD']).slice(0, 12);
}

function repo() {
  mkdirSync(REPO);
  git(['init', '-q', '-b', 'main']);
  commit('chore: start', 'README.md', T0 - 30 * DAY);
  return { C1: commit('docs: tighten the bro rules', 'CLAUDE.md', T0 + 2 * DAY + 12 * HOUR), C2: commit('feat: new skill', '.claude/skills/x/SKILL.md', T0 + 3 * DAY) };
}

// [version, first session, bro tokens of session i]
const VERSIONS = [
  ['1.0.0', T0, (i) => 5000 + 10 * i],
  ['1.1.0', T0 + 2 * DAY, (i) => 1000 + 10 * i],
  ['1.2.0', T0 + 4 * DAY, (i) => 1005 + 10 * i],
];
const SESSIONS = 25;

function seed() {
  const db = new DatabaseSync(DB_PATH);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  db.prepare('INSERT INTO repos (name, path, target_branch) VALUES (?, ?, ?)').run('proj', REPO, 'main');
  const run = db.prepare(
    `INSERT INTO agent_runs (agent_type, session_id, plugin_version, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, started_at, completed_at, usage_source)
     VALUES ('bro', ?, ?, ?, 0, 0, 0, ?, ?, 'transcript')`,
  );
  for (const [version, start, tokens] of VERSIONS) {
    for (let i = 0; i < SESSIONS; i++) run.run(`s-${version}-${i}`, version, tokens(i), iso(start + i * HOUR), iso(start + i * HOUR));
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

function startServer(dbPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, TRAJECTORY_DB_PATH: dbPath, TMB_DASHBOARD_PORT: '0' },
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
    child.once('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
}

let mod;
let server;
let shas;
let dbHash;
const sha256 = () => createHash('sha256').update(readFileSync(DB_PATH)).digest('hex');

before(async () => {
  shas = repo();
  seed();
  dbHash = sha256();
  const out = await build({
    stdin: {
      contents: `import { renderToStaticMarkup } from 'react-dom/server';
        import { createElement } from 'react';
        import { DatabaseSync } from 'node:sqlite';
        import { computeChangeImpact } from '../mcp/trajectory-server/src/change-impact/index.ts';
        import { ChangeImpactSection } from './web/views/insights/change-impact.tsx';
        import { InsightsLayout } from './web/views/insights/InsightsView.tsx';
        import { parseInsightParams } from './web/views/insights/params.ts';
        export function compute(path, opts) {
          const db = new DatabaseSync(path, { readOnly: true });
          const reader = {
            get: (sql, params = []) => db.prepare(sql).get(...params),
            all: (sql, params = []) => db.prepare(sql).all(...params),
          };
          try { return computeChangeImpact(reader, undefined, opts); } finally { db.close(); }
        }
        const noop = () => {};
        export const section = (list, detail, selected = null, source = '') =>
          renderToStaticMarkup(createElement(ChangeImpactSection, { list: { data: list, error: null }, detail: detail === undefined ? undefined : { data: detail, error: null }, source, selected, onSource: noop, onSelect: noop }));
        export const failed = (message) =>
          renderToStaticMarkup(createElement(ChangeImpactSection, { list: { error: new Error(message) }, source: '', selected: null, onSource: noop, onSelect: noop }));
        export const layout = (list) => {
          globalThis.window = { location: { hash: '' }, history: { replaceState() {} }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
          try {
            return renderToStaticMarkup(createElement(InsightsLayout, { params: parseInsightParams('insights/change-impact', new URLSearchParams()), q: { error: null }, changeImpact: { list: { data: list, error: null }, source: '', selected: null, onSource: noop, onSelect: noop } }));
          } finally { delete globalThis.window; }
        };`,
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
  mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  server = await startServer(DB_PATH);
});
after(() => server?.stop());

const get = async (query) => {
  const res = await fetch(`${server.url}api/insights/change-impact${query === '' ? '' : `?${query}`}`);
  return { status: res.status, body: await res.json() };
};

describe('GET /api/insights/change-impact', () => {
  test('the list form deep-equals computeChangeImpact, both sources listed', async () => {
    const { status, body } = await get('');
    assert.equal(status, 200);
    assert.deepEqual(body, mod.compute(DB_PATH, { limit: 20 }));
    assert.deepEqual(body.sources, ['plugin_version', 'agent_surface']);
    assert.deepEqual(body.changes.map((c) => `${c.source}:${c.id}`), ['plugin_version:1.2.0', `agent_surface:${shas.C2}`, `agent_surface:${shas.C1}`, 'plugin_version:1.1.0']);
    const v11 = body.changes.find((c) => c.id === '1.1.0').metrics.find((m) => m.id === 'bro_tokens_per_session');
    assert.equal(v11.verdict, 'improved');
  });

  test('source and limit filter the list as the module does; limit caps at 100', async () => {
    const bySource = await get('source=agent_surface');
    assert.equal(bySource.status, 200);
    assert.deepEqual(bySource.body, mod.compute(DB_PATH, { source: 'agent_surface', limit: 20 }));
    assert.deepEqual(bySource.body.changes.map((c) => c.id), [shas.C2, shas.C1]);
    const one = await get('limit=1');
    assert.deepEqual(one.body, mod.compute(DB_PATH, { limit: 1 }));
    assert.equal(one.body.changes.length, 1);
    const capped = await get('limit=500');
    assert.equal(capped.status, 200);
    assert.deepEqual(capped.body, mod.compute(DB_PATH, { limit: 100 }));
  });

  test('the detail form deep-equals computeChangeImpact for one change', async () => {
    for (const [source, id] of [['plugin_version', '1.1.0'], ['agent_surface', shas.C1]]) {
      const { status, body } = await get(`source=${source}&id=${id}`);
      assert.equal(status, 200);
      assert.deepEqual(body, mod.compute(DB_PATH, { change: { source, id } }));
    }
    const c1 = await get(`source=agent_surface&id=${shas.C1}`);
    assert.deepEqual(c1.body.measured_with, [{ source: 'agent_surface', id: shas.C2 }]);
  });

  test('a bad source, limit or an id without source is a 400 with an error; an unknown id is a 404', async () => {
    for (const query of ['source=nope', 'limit=0', 'limit=abc', 'limit=-3', 'limit=1.5', 'id=1.1.0', 'source=plugin_version&id=']) {
      const { status, body } = await get(query);
      assert.equal(status, 400, query);
      assert.equal(typeof body.error, 'string', query);
    }
    const unknown = await get('source=plugin_version&id=9.9.9');
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.error, /unknown change plugin_version:9\.9\.9/);
  });

  test('the DB file is unchanged after every request', () => {
    assert.equal(sha256(), dbHash);
  });
});

describe('Change impact section', () => {
  test('one row per change, shifts as <metric> improved, no significant shift otherwise', async () => {
    const { body } = await get('');
    const html = mod.section(body);
    const rows = html.match(/<tbody>(.*)<\/tbody>/s)[1].match(/<tr[ >]/g);
    assert.equal(rows.length, body.changes.length);
    assert.match(html, /bro tokens per session improved/);
    assert.ok(html.includes('no significant shift'));
    assert.ok(html.includes('docs: tighten the bro rules'));
  });

  test('a source option per entry in sources, plus All; none hard-coded', async () => {
    const { body } = await get('');
    const options = (list) => [...mod.section(list).matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(options(body), [['', 'All'], ['plugin_version', 'plugin_version'], ['agent_surface', 'agent_surface']]);
    assert.deepEqual(options({ sources: ['custom_source'], changes: [] }), [['', 'All'], ['custom_source', 'custom_source']]);
  });

  test('the detail shows n, medians, ratio, CI, p_holm and the verdict; not_enough_data reads as text', async () => {
    const { body: list } = await get('');
    const { body: detail } = await get('source=plugin_version&id=1.1.0');
    const html = mod.section(list, detail, { source: 'plugin_version', id: '1.1.0' }).match(/<section[^>]*aria-label="Change 1\.1\.0".*<\/section>/s)[0];
    for (const header of ['n before', 'n after', 'Median before', 'Median after', 'Ratio', '95% CI', 'p (Holm)', 'Verdict']) assert.ok(html.includes(`>${header}<`), header);
    const bro = detail.metrics.find((m) => m.id === 'bro_tokens_per_session');
    const broRow = html.match(/<tr[^>]*>(?:(?!<\/tr>).)*bro tokens per session(?:(?!<\/tr>).)*<\/tr>/s)[0];
    assert.match(broRow, />25</);
    assert.match(broRow, />improved</);
    assert.ok(bro.ratio_ci !== null);
    assert.match(broRow, /\d – \d/);
    const sweRow = html.match(/<tr[^>]*>(?:(?!<\/tr>).)*swe rework ratio(?:(?!<\/tr>).)*<\/tr>/s)[0];
    assert.match(sweRow, />not enough data</);
    assert.match(html, /Measured with: no other change/);
  });

  test('the detail lists measured_with', async () => {
    const { body: list } = await get('');
    const { body: detail } = await get(`source=agent_surface&id=${shas.C1}`);
    assert.ok(mod.section(list, detail, { source: 'agent_surface', id: shas.C1 }).includes(`Measured with: agent_surface:${shas.C2}`));
  });

  test('loading and error states follow EfficiencyView', () => {
    assert.match(mod.section(undefined), /Loading…/);
    assert.match(mod.failed('insights/change-impact: HTTP 500'), /insights\/change-impact: HTTP 500/);
  });

  test('the layout shows Change impact in the nav and no Period or filters', async () => {
    const { body } = await get('');
    const html = mod.layout(body);
    assert.match(html, /aria-current="page"[^>]*>Change impact<\/a>|<a[^>]*aria-current="page"[^>]*>Change impact/);
    assert.doesNotMatch(html, /Period<select/);
    assert.doesNotMatch(html, /Filters \(/);
    assert.match(html, /<h2[^>]*>Change impact<\/h2>/);
  });
});
