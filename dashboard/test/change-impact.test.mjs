// Insights Change impact test (GH 2600): seed a temp trajectory DB from
// schema.sql with bro sessions on three plugin versions (the second cuts bro
// tokens, the third holds them) and a `repos` row whose temp git repo has two
// CLAUDE.md commits, so both change sources list changes. Check that
// GET /api/insights/change-impact deep-equals computeChangeImpact on the same
// DB in its list and detail forms, its 400s and 404, that a throw inside the
// worker is a 500 whose stderr log carries the worker's stack (GH 2753), that
// it runs in a worker so /api/health answers while git is slow (GH 2618), that the DB file is
// unchanged after the requests, and render the Change impact section to
// static HTML.
process.env.TZ = 'America/Los_Angeles';

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function startServer(dbPath, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, TRAJECTORY_DB_PATH: dbPath, TMB_DASHBOARD_PORT: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (chunk) => {
      out += chunk;
      const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(out)?.[0];
      if (url) resolve({ url, stderr: () => err, stop: () => new Promise((done) => (child.once('exit', done), child.kill())) });
    };
    child.stdout.on('data', onData);
    let err = '';
    child.stderr.on('data', (chunk) => (err += chunk));
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
        export { rowRef } from './web/views/insights/change-impact.tsx';
        export { changeImpactApiPath } from './web/views/insights/params.ts';
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
    for (const c of body.changes) for (const m of c.metrics) assert.ok(!('series' in m), `${c.id} ${m.id} has no series`);
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
      assert.deepEqual(body, mod.compute(DB_PATH, { change: { source, id }, series: true }));
      assert.ok(body.metrics.some((m) => m.series.before.length + m.series.after.length > 0), `${source}:${id} has series points`);
    }
    const c1 = await get(`source=agent_surface&id=${shas.C1}`);
    assert.deepEqual(c1.body.measured_with, [{ source: 'agent_surface', id: shas.C2, repo: 'proj' }]);
  });

  test('repo picks the change in that repo; an unknown repo is a 404, an empty one or one without id a 400 (GH 2613)', async () => {
    const named = await get(`source=agent_surface&id=${shas.C1}&repo=proj`);
    assert.equal(named.status, 200);
    assert.equal(named.body.repo, 'proj');
    assert.deepEqual(named.body, mod.compute(DB_PATH, { change: { source: 'agent_surface', id: shas.C1, repo: 'proj' }, series: true }));
    const unknown = await get(`source=agent_surface&id=${shas.C1}&repo=nope`);
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.error, /in repo nope/);
    for (const query of [`source=agent_surface&id=${shas.C1}&repo=`, 'source=agent_surface&repo=proj']) {
      const { status, body } = await get(query);
      assert.equal(status, 400, query);
      assert.equal(typeof body.error, 'string', query);
    }
  });

  test('an id two repos share is a 400 naming both without repo and resolves with repo (GH 2613)', async () => {
    const twin = join(tmp, 'twin.db');
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    db.exec(`VACUUM INTO '${twin}'`);
    db.close();
    const w = new DatabaseSync(twin);
    w.prepare('INSERT INTO repos (name, path, target_branch) VALUES (?, ?, ?)').run('twin', REPO, 'main');
    w.close();
    const s = await startServer(twin);
    try {
      const at = async (q) => {
        const res = await fetch(`${s.url}api/insights/change-impact?${q}`);
        return { status: res.status, body: await res.json() };
      };
      const ambiguous = await at(`source=agent_surface&id=${shas.C1}`);
      assert.equal(ambiguous.status, 400);
      assert.match(ambiguous.body.error, /ambiguous change .*proj.*twin/);
      for (const repo of ['proj', 'twin']) {
        const { status, body } = await at(`source=agent_surface&id=${shas.C1}&repo=${repo}`);
        assert.equal(status, 200, repo);
        assert.equal(body.repo, repo);
        const other = repo === 'proj' ? 'twin' : 'proj';
        assert.deepEqual(
          body.measured_with.map((c) => `${c.repo}:${c.id}`).sort(),
          [`${repo}:${shas.C2}`, `${other}:${shas.C1}`, `${other}:${shas.C2}`].sort(),
        );
      }
    } finally {
      await s.stop();
    }
  });

  test('a throw inside the worker is a 500 INTERNAL_ERROR and stderr carries the worker bundle stack (GH 2753)', async () => {
    const broken = join(tmp, 'no-agent-runs.db');
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    db.exec(`VACUUM INTO '${broken}'`);
    db.close();
    const w = new DatabaseSync(broken);
    w.exec('DROP TABLE agent_runs');
    w.close();
    const s = await startServer(broken);
    try {
      const res = await fetch(`${s.url}api/insights/change-impact`);
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.deepEqual(body, { error: 'internal_error', message: 'the dashboard server hit an error; its terminal has the details' });
      assert.doesNotMatch(JSON.stringify(body), /change-impact-worker|agent_runs/);
      for (let i = 0; i < 100 && !s.stderr().includes('dashboard request failed:'); i += 1) await new Promise((r) => setTimeout(r, 10));
      const logged = s.stderr().slice(s.stderr().indexOf('dashboard request failed:'));
      assert.match(logged, /no such table: agent_runs/);
      assert.match(logged, /\n\s+at .*change-impact-worker\.mjs:\d+:\d+/);
    } finally {
      await s.stop();
    }
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

  // A `git` shim first on the server's PATH sleeps 1.5 s, then runs the real
  // git with the same argv, stdin and exit code, so a change-impact request
  // stays in flight on git while /api/health is asked.
  describe('runs in a worker thread (GH 2618)', () => {
    const SHIM_DIR = join(tmp, 'slow-git');
    const STARTED = join(tmp, 'slow-git-started');
    let slow;

    before(async () => {
      mkdirSync(SHIM_DIR);
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      writeFileSync(
        join(SHIM_DIR, 'git'),
        `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
writeFileSync(${JSON.stringify(STARTED)}, '');
setTimeout(() => {
  spawn(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit' }).on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}, 1500);
`,
        { mode: 0o755 },
      );
      slow = await startServer(DB_PATH, { PATH: `${SHIM_DIR}:${process.env.PATH}` });
    });
    after(() => slow?.stop());

    test('main.ts starts the worker bundle and no longer computes change impact itself', () => {
      const main = readFileSync(join(DASH, 'server/main.ts'), 'utf8');
      assert.doesNotMatch(main, /computeChangeImpact\(/);
      assert.match(main, /new Worker\(/);
      assert.match(main, /new URL\('\.\/change-impact-worker\.mjs', import\.meta\.url\)/);
      assert.ok(existsSync(join(DASH, 'dist/change-impact-worker.mjs')), 'bun run build emits dist/change-impact-worker.mjs');
    });

    test('/api/health answers within 500 ms while a change-impact list request waits on slow git', async () => {
      const order = [];
      const pending = fetch(`${slow.url}api/insights/change-impact`).then(async (res) => {
        order.push('change-impact');
        return { status: res.status, body: await res.json() };
      });
      for (let i = 0; i < 500 && !existsSync(STARTED); i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.ok(existsSync(STARTED), 'the change-impact request reached git');
      const health = await fetch(`${slow.url}api/health`, { signal: AbortSignal.timeout(500) });
      order.push('health');
      assert.equal(health.status, 200);
      await health.json();
      const { status, body } = await pending;
      assert.deepEqual(order, ['health', 'change-impact']);
      assert.equal(status, 200);
      assert.deepEqual(body, mod.compute(DB_PATH, { limit: 20 }));
    });
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

  test('a declared change shows a badge per declaration: metric label, direction and outcome in words; wrong_way and not_moved in attention with an icon (GH 2600)', async () => {
    const { body } = await get('');
    for (const c of body.changes) assert.ok(!('declared' in c), `${c.source}:${c.id} has no declared in user mode`);
    assert.doesNotMatch(mod.section(body), />Declared</, 'no Declared column without a declaration');

    const declared = [
      { metric: 'bro_tokens_per_session', direction: 'lower', outcome: 'as_declared' },
      { metric: 'swe_rework_ratio', direction: 'higher', outcome: 'wrong_way' },
      { metric: 'tokens_per_task', direction: 'lower', outcome: 'not_moved' },
      { metric: 'review_fail_rate', direction: 'lower', outcome: 'not_enough_data' },
    ];
    const list = { ...body, changes: body.changes.map((c) => (c.id === '1.1.0' ? { ...c, declared } : c)) };
    const html = mod.section(list);
    assert.match(html, />Declared</);
    const badges = [...html.matchAll(/<span class="([^"]*)" data-declared="([a-z_]+)">(.*?)<\/span>/g)].map((m) => ({
      cls: m[1],
      outcome: m[2],
      icon: m[3].includes('<svg'),
      text: m[3].replace(/<svg.*?<\/svg>/g, ''),
    }));
    assert.deepEqual(badges.map((b) => [b.outcome, b.text]), [
      ['as_declared', 'bro tokens per session lower: moved as declared'],
      ['wrong_way', 'swe rework ratio higher: moved the wrong way'],
      ['not_moved', 'tokens per task lower: did not move'],
      ['not_enough_data', 'review fail rate lower: not enough data'],
    ]);
    for (const b of badges.filter((x) => x.outcome === 'wrong_way' || x.outcome === 'not_moved')) {
      assert.match(b.cls, /fgColor-attention/, `${b.outcome} uses the attention style`);
      assert.ok(b.icon, `${b.outcome} carries an icon`);
    }
    const row = html.match(/<tr[^>]*>(?:(?!<\/tr>).)*moved as declared(?:(?!<\/tr>).)*<\/tr>/s)[0];
    assert.ok(row.includes('>1.1.0<'), 'the badges sit on the declared change row');
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

  test('the detail charts the first shifted metric per day, before and after, with one change marker', async () => {
    const { body: list } = await get('');
    const { body: detail } = await get('source=plugin_version&id=1.1.0');
    const panel = (d) => mod.section(list, d, { source: 'plugin_version', id: '1.1.0' }).match(/<section[^>]*aria-label="Change 1\.1\.0".*<\/section>/s)[0];
    const html = panel(detail);
    const shifted = detail.metrics.find((m) => m.verdict === 'improved' || m.verdict === 'regressed');
    assert.ok(shifted);
    assert.match(html, new RegExp(`<option value="${shifted.id}" selected="">`));
    assert.equal((html.match(/selected=""/g) ?? []).length, 1);

    const points = [...shifted.series.before.map((p) => ({ ...p, side: 'before' })), ...shifted.series.after.map((p) => ({ ...p, side: 'after' }))].sort((a, b) =>
      a.day === b.day ? (a.side === 'before' ? -1 : 1) : a.day < b.day ? -1 : 1,
    );
    assert.ok(shifted.series.before.length > 0 && shifted.series.after.length > 0);
    const hits = [...html.matchAll(/<rect x="([\d.]+)" y="0" width="([\d.]+)"[^>]*data-hit=""[^>]*aria-label="([^"]*)"/g)];
    assert.equal(hits.length, points.length, 'one column per series point');
    const day = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const fmt = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 });
    assert.deepEqual(hits.map((h) => h[3]), points.map((p) => `${day(p.day)} ${p.side}: median ${fmt.format(p.median)} (n ${p.n})`));

    const markers = [...html.matchAll(/<g data-marker="[^"]*">(.*?)<\/g>/g)];
    assert.equal(markers.length, 1);
    assert.match(markers[0][1], /data-marker-label="">change<\/text>/);
    const ax = Number(/d="M[\d.-]+,[\d.-]+H[\d.-]+L([\d.-]+),/.exec(markers[0][1])[1]);
    const first = hits[points.findIndex((p) => p.side === 'after')];
    assert.ok(Math.abs(ax - (Number(first[1]) + Number(first[2]) / 2)) < 0.01, 'marker at the first after column');

    assert.match(html, /aria-label="Legend"><li[^>]*><svg[^>]*>.*?<\/svg>Before<\/li><li[^>]*><svg[^>]*>.*?<\/svg>After<\/li><\/ul>/);
    assert.ok(!html.includes('No samples in this window.'));

    const none = panel({ ...detail, metrics: detail.metrics.map((m) => ({ ...m, verdict: 'no_change' })) });
    assert.match(none, new RegExp(`<option value="${detail.metrics[0].id}" selected="">`));

    const empty = panel({ ...detail, metrics: detail.metrics.map((m) => (m.id === shifted.id ? { ...m, series: { before: [], after: [] } } : m)) });
    assert.ok(empty.includes('No samples in this window.'));
    assert.doesNotMatch(empty, /data-hit=""|data-marker=/);
  });

  test('the detail lists measured_with', async () => {
    const { body: list } = await get('');
    const { body: detail } = await get(`source=agent_surface&id=${shas.C1}`);
    assert.ok(mod.section(list, detail, { source: 'agent_surface', id: shas.C1 }).includes(`Measured with: agent_surface:${shas.C2}`));
  });

  test('a row click selects the row\'s repo and the detail path carries it (GH 2613)', async () => {
    const { body } = await get('source=agent_surface');
    const row = body.changes.find((c) => c.id === shas.C1);
    assert.deepEqual(mod.rowRef(row), { source: 'agent_surface', id: shas.C1, repo: 'proj' });
    assert.deepEqual(mod.rowRef({ source: 'tmb_events', id: 'x', repo: null }), { source: 'tmb_events', id: 'x', repo: null });
    assert.equal(mod.changeImpactApiPath('agent_surface', shas.C1, 'proj'), `insights/change-impact?source=agent_surface&id=${shas.C1}&repo=proj`);
    assert.equal(mod.changeImpactApiPath('tmb_events', 'x', null), 'insights/change-impact?source=tmb_events&id=x');
    assert.equal(mod.changeImpactApiPath('agent_surface'), 'insights/change-impact?source=agent_surface');
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
