// Insights Token Efficiency test (GH 2447): build a temp git repo whose commits
// cover feat, fix, docs, an emoji-prefixed subject, a breaking `fix!:`, a
// lockfile, dist/ and other generated files, a binary file, an untyped subject
// and a generated-only commit; seed a temp trajectory DB from schema.sql whose
// `repos` row points at it, with first-pass, two-swe-run and reviewer-fail
// tasks across three local ISO weeks, n<3 groups, and tasks the endpoint must
// skip (unknown repo, missing or relative path, bad or unknown SHA, no repo).
// Check GET /api/insights/efficiency and GET /api/insights/efficiency/compare
// (GH 2069) against hand-computed values, their filters, periods and 400s,
// that the DB file and the repo are unchanged after the requests, that another
// endpoint answers while git holds a cold request and that a cold compare runs
// git at most twice per repo, and render the Efficiency section to static HTML.
process.env.TZ = 'America/Los_Angeles';

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const DASH = new URL('..', import.meta.url).pathname;
const SCHEMA = join(DASH, '../mcp/trajectory-server/src/schema.sql');
const SERVER = join(DASH, 'dist/server.mjs');

const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tmb-dashboard-efficiency-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const REPO = join(tmp, 'proj');
const DB_PATH = join(tmp, 'trajectory.db');

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (...args) =>
  execFileSync('git', ['-C', REPO, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: GIT_ENV }).trim();
const text = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join('\n') + '\n';

function commit(subject, files) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(REPO, path)), { recursive: true });
    writeFileSync(join(REPO, path), body);
  }
  git('add', '-A');
  git('commit', '-q', '-m', subject);
  return git('rev-parse', 'HEAD');
}

function repo() {
  mkdirSync(REPO);
  git('init', '-q');
  return {
    F1: commit('feat(api): add widget', { 'src/f1.ts': text(10, 'f1'), 'bun.lock': text(50, 'lock'), 'dist/out.js': text(30, 'out'), 'README.md': text(5, 'readme') }),
    F2: commit('feat: second', { 'src/f2.ts': text(20, 'f2') }),
    F3: commit('feat: third', { 'src/f3.ts': text(40, 'f3'), 'web/build/app.js': text(9, 'app') }),
    F4: commit('feat(ui): fourth', { 'src/f4.ts': text(25, 'f4'), 'docs/f4.md': text(4, 'doc') }),
    F0: commit('feat: regenerate', { 'dist/z.js': text(5, 'z'), 'data-contracts.json': text(3, 'c'), 'docs/architecture/ERD.md': text(6, 'erd') }),
    X1: commit('fix: one', { 'src/x1.ts': text(5, 'x1') }),
    X2: commit('🐛 fix(x): emoji subject', {
      'src/x2.ts': text(6, 'x2'),
      'img/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 0, 3]),
      'web/x.min.js': text(9, 'min'),
      'web/x.js.map': text(3, 'map'),
      'pnpm-lock.yaml': text(4, 'pnpm'),
    }),
    X3: commit('fix!: breaking', { 'src/x3.ts': text(10, 'x3') }),
    D1: commit('docs: guide', { 'docs/guide.md': text(20, 'g'), 'package-lock.json': text(7, 'npm') }),
    D2: commit('docs(readme): intro', { 'docs/intro.md': text(10, 'intro') }),
    D3: commit('docs: notes', { 'docs/architecture/CONFIG_KEYS.md': text(30, 'k'), 'notes.txt': text(10, 'n') }),
    O1: commit('Update stuff', { 'src/o.ts': text(8, 'o') }),
    T1: commit('test: cover', { 'test/t.mjs': text(12, 't') }),
  };
}

const WEEK_A = '2025-03-03';
const WEEK_B = '2025-03-10';
const WEEK_C = '2025-02-24';
const SUNDAY_NIGHT_PDT = '2025-03-10T05:00:00.000Z';

// [id, sha key, repo, completed_at, effort, runs, verdicts]; a run is [agent, in, out, cache_read, cache_creation, ms].
const TASKS = [
  [1, 'F1', 'proj', '2025-03-04T18:00:00.000Z', 'high', [['swe', 100, 1000, 900, 0, 60_000], ['code-reviewer', 50, 100, 350, 0, 30_000], ['bro', 9e6, 9e6, 9e6, 9e6, 9e6]], ['pass']],
  [2, 'F2', 'proj', '2025-03-05T18:00:00.000Z', 'high', [['swe', 100, 2000, 1800, 100, 60_000], ['swe', 200, 1000, 800, 0, 40_000]], ['pass']],
  [3, 'F3', 'proj', '2025-03-11T18:00:00.000Z', 'high', [['swe', 400, 3000, 3600, 0, 120_000], ['code-reviewer', 100, 500, 400, 0, 20_000]], ['fail', 'pass']],
  [4, 'F4', 'proj', '2025-03-12T18:00:00.000Z', 'high', [['swe', 200, 1000, 1800, 1000, 80_000]], ['pass']],
  [5, 'F0', 'proj', '2025-03-06T18:00:00.000Z', 'high', [['swe', 9e5, 9e5, 9e5, 9e5, 9e5]], []],
  [6, 'X1', 'proj', '2025-03-05T20:00:00.000Z', 'medium', [['swe', 100, 400, 0, 0, 10_000]], []],
  [7, 'X2', 'proj', SUNDAY_NIGHT_PDT, 'medium', [['swe', 60, 540, 0, 0, 12_000]], ['pass']],
  [8, 'X3', 'proj', '2025-03-13T18:00:00.000Z', 'medium', [['swe', 100, 900, 0, 0, 10_000], ['swe', 100, 900, 0, 0, 10_000]], []],
  [9, 'D1', 'proj', '2025-03-11T19:00:00.000Z', 'medium', [['swe', 100, 400, 0, 0, 20_000]], []],
  [10, 'D2', 'proj', '2025-03-11T20:00:00.000Z', 'medium', [['swe', 100, 400, 0, 0, 20_000]], []],
  [11, 'D3', 'proj', '2025-03-11T21:00:00.000Z', 'medium', [['swe', 100, 400, 0, 0, 20_000]], []],
  [12, 'O1', 'proj', '2025-03-06T20:00:00.000Z', 'medium', [['swe', 100, 700, 0, 0, 16_000]], []],
  [13, 'T1', 'proj', '2025-02-26T18:00:00.000Z', 'medium', [['swe', 100, 100, 0, 0, 1000]], []],
  [14, 'F1', 'ghost', '2025-03-04T18:00:00.000Z', 'high', [['swe', 1, 1, 1, 1, 1]], []],
  [15, 'F1', 'gone', '2025-03-04T18:00:00.000Z', 'high', [['swe', 1, 1, 1, 1, 1]], []],
  [16, 'F1', 'rel', '2025-03-04T18:00:00.000Z', 'high', [['swe', 1, 1, 1, 1, 1]], []],
  [17, 'NOTASHA', 'proj', '2025-03-04T18:00:00.000Z', 'high', [['swe', 1, 1, 1, 1, 1]], []],
  [18, 'deadbeefdeadbeefdeadbeef', 'proj', '2025-03-04T18:00:00.000Z', 'high', [['swe', 1, 1, 1, 1, 1]], []],
  [19, 'F1', null, '2025-03-04T18:00:00.000Z', 'high', [['swe', 1, 1, 1, 1, 1]], []],
];
const SKIPPED = 6;
const SKIPPED_PROJ = 2;

function seed(shas) {
  const db = new DatabaseSync(DB_PATH);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  db.exec('PRAGMA foreign_keys = OFF');
  const now = '2025-03-14T00:00:00.000Z';
  const repoRow = db.prepare('INSERT INTO repos (name, path) VALUES (?, ?)');
  repoRow.run('proj', REPO);
  repoRow.run('gone', join(tmp, 'missing'));
  repoRow.run('rel', 'proj');
  const issue = Number(db.prepare('INSERT INTO issues (objective, created_at, updated_at) VALUES (?, ?, ?)').run('Efficiency issue', now, now).lastInsertRowid);
  const task = db.prepare(
    `INSERT INTO tasks (id, issue_id, branch_id, title, description, status, commit_sha, repo, effort, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'd', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const run = db.prepare(
    `INSERT INTO agent_runs (task_id, agent_type, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, duration_ms, started_at, completed_at, usage_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const verdict = db.prepare("INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, created_at) VALUES (?, ?, 'code-reviewer', ?, 1, ?)");
  for (const [id, key, repoName, at, effort, runs, verdicts] of TASKS) {
    task.run(id, issue, `feat/t${id}`, `Task ${id}`, 'closed', shas[key] ?? key, repoName, effort, at, now, now);
    runs.forEach(([agent, tin, tout, cr, cc, ms], i) => run.run(id, agent, tin, tout, cr, cc, ms, at, at, i === 0 ? 'subagent_stop' : 'unmeasured'));
    verdicts.forEach((v, i) => verdict.run(id, i + 1, v, at));
  }
  task.run(20, issue, 'feat/t20', 'Running', 'running', shas.F1, 'proj', 'high', null, now, now);
  task.run(21, issue, 'feat/t21', 'No commit', 'closed', null, 'proj', 'high', '2025-03-04T18:00:00.000Z', now, now);
  run.run(20, 'swe', 9e6, 9e6, 9e6, 9e6, 9e6, now, now, 'subagent_stop');
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
let before_;
const fingerprint = () => ({
  db: createHash('sha256').update(readFileSync(DB_PATH)).digest('hex'),
  status: git('status', '--porcelain'),
  head: git('rev-parse', 'HEAD'),
});

before(async () => {
  shas = repo();
  seed(shas);
  before_ = fingerprint();
  const out = await build({
    stdin: {
      contents: `import { renderToStaticMarkup } from 'react-dom/server';
        import { createElement } from 'react';
        import { InsightsLayout } from './web/views/insights/InsightsView.tsx';
        import { parseInsightParams } from './web/views/insights/params.ts';
        import * as copy from './web/views/insights/params.ts';
        const withHash = (hash, fn) => {
          globalThis.window = { location: { hash }, history: { replaceState() {} }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
          try { return fn(); } finally { delete globalThis.window; }
        };
        const paramsOf = (hash) => {
          const [path, query = ''] = hash.replace(/^#\\/?/, '').split('?');
          return parseInsightParams(path, new URLSearchParams(query));
        };
        export const page = (hash, data, efficiency) => withHash(hash, () =>
          renderToStaticMarkup(createElement(InsightsLayout, { params: paramsOf(hash), q: { data, error: null }, efficiency: { data: efficiency, error: null } })));
        export const comparePage = (hash, cmp, efficiencyCmp) => withHash(hash, () =>
          renderToStaticMarkup(createElement(InsightsLayout, { params: paramsOf(hash), q: { data: cmp.p2, error: null }, cmp: { data: cmp, error: null }, efficiencyCmp: { data: efficiencyCmp, error: null } })));
        export { commitType, numstatPath, isGenerated, isDoc, parseNumstat, linesOf, localMonday, commitsOf, parseLog, efficiency, efficiencyCompare } from './server/efficiency.ts';
        export { insightFilter } from './server/queries.ts';
        export { paramsOf, copy };`,
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

const get = async (query, path = 'efficiency') => {
  const res = await fetch(`${server.url}api/insights/${path}?${query}`);
  return { status: res.status, body: await res.json() };
};
const getCompare = (query) => get(query, 'efficiency/compare');
const row = (list, key, value) => list.find((r) => r[key] === value);
const NULL_METRICS = {
  first_pass_rate: null,
  fp_tok_line: null,
  fp_tok_line_median: null,
  rw_tok_line: null,
  rw_tok_line_median: null,
  rework_share: null,
  cache_hit: null,
  fp_sec_line: null,
  rw_sec_line: null,
};

// Per task: tokens = in + cr + cc + out over swe and code-reviewer runs,
// cost = in + 0.1·cr + 1.25·cc + 5·out, context = in + cr + cc.
// T1 2500 tok / 10 lines, cost 5775, context 1400, cr 1250, 90 s, first pass.
// T2 6000 / 20, cost 15685, context 3000, cr 2600, 100 s, two swe runs.
// T3 8000 / 40, cost 18400, context 4500, cr 4000, 140 s, reviewer fail.
// T4 4000 / 25, cost 6630, context 3000, cr 1800, 80 s, first pass.
// T6 500 / 5, T7 600 / 6, T8 2000 / 10 (two swe runs); docs T9–T11 500 / 20, 10, 10.
const FEAT = {
  type: 'feat',
  n: 4,
  zero_line: 1,
  few: false,
  first_pass_rate: 0.5,
  fp_tok_line: 6500 / 35,
  fp_tok_line_median: 160,
  rw_tok_line: 14000 / 60,
  rw_tok_line_median: 200,
  rework_share: 34085 / 46490,
  cache_hit: 9650 / 11900,
  fp_sec_line: 170 / 35,
  rw_sec_line: 240 / 60,
};
const FIX = {
  type: 'fix',
  n: 3,
  zero_line: 0,
  few: false,
  first_pass_rate: 2 / 3,
  fp_tok_line: 1100 / 11,
  fp_tok_line_median: 100,
  rw_tok_line: 200,
  rw_tok_line_median: 200,
  rework_share: 9200 / 14060,
  cache_hit: 0,
  fp_sec_line: 22 / 11,
  rw_sec_line: 20 / 10,
};
const DOCS = {
  type: 'docs',
  n: 3,
  zero_line: 0,
  few: false,
  first_pass_rate: 1,
  fp_tok_line: 1500 / 40,
  fp_tok_line_median: 50,
  rw_tok_line: null,
  rw_tok_line_median: null,
  rework_share: 0,
  cache_hit: 0,
  fp_sec_line: 60 / 40,
  rw_sec_line: null,
};
const OTHER = { type: 'other', n: 1, zero_line: 0, few: true, ...NULL_METRICS };
const TEST = { type: 'test', n: 1, zero_line: 0, few: true, ...NULL_METRICS };
const WEEKS = [
  {
    week: WEEK_A,
    n: 5,
    zero_line: 1,
    few: false,
    first_pass_rate: 4 / 5,
    fp_tok_line: 4400 / 29,
    fp_tok_line_median: 100,
    rw_tok_line: 300,
    rw_tok_line_median: 300,
    rework_share: 15685 / 29920,
    cache_hit: 3850 / 4660,
    fp_sec_line: 128 / 29,
    rw_sec_line: 100 / 20,
  },
  {
    week: WEEK_B,
    n: 3,
    zero_line: 0,
    few: false,
    first_pass_rate: 1 / 3,
    fp_tok_line: 160,
    fp_tok_line_median: 160,
    rw_tok_line: 10000 / 50,
    rw_tok_line_median: 200,
    rework_share: 27600 / 34230,
    cache_hit: 5800 / 7700,
    fp_sec_line: 80 / 25,
    rw_sec_line: 160 / 50,
  },
  { week: WEEK_C, n: 1, zero_line: 0, few: true, ...NULL_METRICS },
];
// Overall is the code types pooled: T1–T8, T12 (O1 800 / 8, cost 3600,
// context 100, 16 s) and T13 (T1 200 / 12, cost 600, context 100, 1 s).
const OVERALL = {
  n: 9,
  zero_line: 1,
  few: false,
  first_pass_rate: 6 / 9,
  fp_tok_line: 8600 / 66,
  fp_tok_line_median: 100,
  rw_tok_line: 16000 / 70,
  rw_tok_line_median: 200,
  rework_share: 43285 / 64750,
  cache_hit: 9650 / 12460,
  fp_sec_line: 209 / 66,
  rw_sec_line: 260 / 70,
};
// tasks:1-12 is OVERALL without T13.
const OVERALL_1_12 = {
  ...OVERALL,
  n: 8,
  first_pass_rate: 5 / 8,
  fp_tok_line: 8400 / 54,
  rework_share: 43285 / 64150,
  cache_hit: 9650 / 12360,
  fp_sec_line: 208 / 54,
};
const FEW_NULL = (n, zero_line = 0) => ({ n, zero_line, few: true, ...NULL_METRICS });
// dates:2025-03-10..2025-03-13 holds T3, T4, T7 (Sunday night PDT is
// 2025-03-10 UTC), T8 and the docs tasks.
const OVERALL_MAR_10_13 = {
  n: 4,
  zero_line: 0,
  few: false,
  first_pass_rate: 0.5,
  fp_tok_line: 4600 / 31,
  fp_tok_line_median: 100,
  rw_tok_line: 10000 / 50,
  rw_tok_line_median: 200,
  rework_share: 27600 / 36990,
  cache_hit: 5800 / 7760,
  fp_sec_line: 92 / 31,
  rw_sec_line: 160 / 50,
};
// dates:2025-02-01..2025-03-09 holds T1, T2, T5, T6, T12, T13 and T14–T19.
const OVERALL_FEB_1_MAR_9 = {
  n: 5,
  zero_line: 1,
  few: false,
  first_pass_rate: 4 / 5,
  fp_tok_line: 4000 / 35,
  fp_tok_line_median: 100,
  rw_tok_line: 300,
  rw_tok_line_median: 300,
  rework_share: 15685 / 27760,
  cache_hit: 3850 / 4700,
  fp_sec_line: 117 / 35,
  rw_sec_line: 100 / 20,
};
const WEEK_A_FEB_1_MAR_9 = {
  week: WEEK_A,
  n: 4,
  zero_line: 1,
  few: false,
  first_pass_rate: 3 / 4,
  fp_tok_line: 3800 / 23,
  fp_tok_line_median: 100,
  rw_tok_line: 300,
  rw_tok_line_median: 300,
  rework_share: 15685 / 27160,
  cache_hit: 3850 / 4600,
  fp_sec_line: 116 / 23,
  rw_sec_line: 100 / 20,
};
const groupPart = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'type' && k !== 'week'));

function assertGroup(actual, expected) {
  assert.ok(actual, JSON.stringify(expected));
  for (const [k, v] of Object.entries(expected)) {
    if (typeof v === 'number' && !Number.isInteger(v)) assert.ok(Math.abs(actual[k] - v) < 1e-9, `${k}: ${actual[k]} vs ${v}`);
    else assert.equal(actual[k], v, k);
  }
}

describe('efficiency helpers', () => {
  test('commitType keeps the seven types, strips emoji, scope and !, else other', () => {
    assert.equal(mod.commitType('feat(api): x'), 'feat');
    assert.equal(mod.commitType('🐛 fix(x): y'), 'fix');
    assert.equal(mod.commitType('✨ feat!: y'), 'feat');
    assert.equal(mod.commitType('fix!: y'), 'fix');
    for (const t of ['test', 'refactor', 'perf', 'chore', 'docs']) assert.equal(mod.commitType(`${t}: z`), t);
    for (const s of ['Update stuff', 'style: x', 'ci(x): y', 'Feat: x', '']) assert.equal(mod.commitType(s), 'other');
  });

  test('numstat parsing skips binary rows and resolves renames', () => {
    const stat = mod.parseNumstat('feat: x\n\n3\t1\tsrc/a.ts\n-\t-\timg/b.png\n2\t2\tsrc/{old => new}/c.ts\n1\t0\told.ts => moved.ts\n');
    assert.equal(stat.subject, 'feat: x');
    assert.deepEqual(stat.files.map((f) => f.path), ['src/a.ts', 'src/new/c.ts', 'moved.ts']);
    assert.equal(mod.numstatPath('a/{b => }/c.ts'), 'a/c.ts');
  });

  test('generated files and docs', () => {
    for (const p of ['dist/a.js', 'web/build/x.js', 'a.js.map', 'x.min.css', 'bun.lock', 'sub/package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'data-contracts.json', 'docs/contributing/ENUMS.md', 'docs/architecture/ERD.md', 'docs/architecture/CONFIG_KEYS.md'])
      assert.ok(mod.isGenerated(p), p);
    for (const p of ['src/dist.ts', 'distill/a.ts', 'docs/guide.md', 'builder.ts']) assert.ok(!mod.isGenerated(p), p);
    for (const p of ['README.md', 'a.mdx', 'notes.txt', 'x.rst', 'docs/img.png']) assert.ok(mod.isDoc(p), p);
    assert.ok(!mod.isDoc('src/docs.ts'));
    const stat = { subject: '', files: [{ path: 'src/a.ts', added: 3, deleted: 1 }, { path: 'README.md', added: 5, deleted: 0 }, { path: 'dist/a.js', added: 9, deleted: 9 }] };
    assert.equal(mod.linesOf(stat, 'feat'), 4);
    assert.equal(mod.linesOf(stat, 'docs'), 9);
  });

  test('localMonday is the local ISO Monday', () => {
    assert.equal(mod.localMonday(SUNDAY_NIGHT_PDT), WEEK_A);
    assert.equal(mod.localMonday('2025-03-10T08:00:00.000Z'), WEEK_B);
    assert.equal(mod.localMonday('2025-03-16T23:00:00-07:00'), WEEK_B);
    assert.equal(mod.localMonday('nope'), null);
  });

  test('commitsOf keeps commits by input order; parseLog splits NUL-framed commits', () => {
    const full = 'a'.repeat(40);
    const tree = 'b'.repeat(40);
    const check = `${full} commit\ndeadbee missing\n${tree} tree\nabc1234 ambiguous\n`;
    assert.deepEqual([...mod.commitsOf(['aaaaaaa', 'deadbee', tree, 'abc1234'], check)], [['aaaaaaa', full]]);
    const log = mod.parseLog(`\0${full}\0feat: x\n\n3\t1\tsrc/a.ts\n-\t-\tb.png\n\0${tree}\0Update stuff\n`);
    assert.deepEqual([...log.keys()], [full, tree]);
    assert.deepEqual(log.get(full), { subject: 'feat: x', files: [{ path: 'src/a.ts', added: 3, deleted: 1 }] });
    assert.deepEqual(log.get(tree), { subject: 'Update stuff', files: [] });
  });
});

describe('GET /api/insights/efficiency', () => {
  test('SC1–SC3: by_type and by_week against hand-computed values', async () => {
    const { status, body } = await get('range=all');
    assert.equal(status, 200);
    assert.deepEqual(body.by_type.map((r) => r.type), ['feat', 'fix', 'other', 'test', 'docs']);
    assertGroup(row(body.by_type, 'type', 'feat'), FEAT);
    assertGroup(row(body.by_type, 'type', 'fix'), FIX);
    assertGroup(row(body.by_type, 'type', 'docs'), DOCS);
    assertGroup(row(body.by_type, 'type', 'other'), OTHER);
    assertGroup(row(body.by_type, 'type', 'test'), TEST);
    assert.deepEqual(body.by_week.map((r) => r.week), [WEEK_A, WEEK_B, WEEK_C]);
    WEEKS.forEach((w, i) => assertGroup(body.by_week[i], w));
    assert.equal(body.skipped, SKIPPED);
    assert.deepEqual(body.filters, { repo: null, effort: null });
    assert.equal(body.range.key, 'all');
    assert.equal(body.range.since, null);
  });

  test('GH 2069: overall pools the code types, beside the unchanged fields', async () => {
    const { body } = await get('range=all');
    assert.deepEqual(Object.keys(body), ['range', 'filters', 'overall', 'by_type', 'by_week', 'skipped']);
    assertGroup(body.overall, OVERALL);
    const codeN = body.by_type.filter((r) => r.type !== 'docs').reduce((s, r) => s + r.n, 0);
    assert.equal(body.overall.n, codeN);
    const high = (await get('range=all&effort=high')).body;
    assertGroup(high.overall, groupPart(FEAT));
  });

  test('Repo and Effort filter; Agent and Model do not apply', async () => {
    const proj = (await get('range=all&repo=proj')).body;
    assert.equal(proj.skipped, SKIPPED_PROJ);
    assertGroup(row(proj.by_type, 'type', 'feat'), FEAT);
    const high = (await get('range=all&effort=high&agent=bro&model=claude-opus')).body;
    assert.deepEqual(high.by_type.map((r) => r.type), ['feat']);
    assertGroup(high.by_type[0], FEAT);
    assert.equal(high.skipped, SKIPPED);
    const none = (await get('range=all&repo=nobody')).body;
    assert.deepEqual([none.by_type, none.by_week, none.skipped], [[], [], 0]);
  });

  test('Period: only tasks completed since the range start count', async () => {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      const filter = mod.insightFilter(new URLSearchParams('range=7d'));
      const body = await mod.efficiency(db, filter, new Date('2025-03-14T00:00:00.000Z'));
      assert.equal(body.range.since, '2025-03-07T00:00:00.000Z');
      assert.deepEqual(body.by_type.map((r) => [r.type, r.n, r.few]), [['feat', 2, true], ['fix', 2, true], ['docs', 3, false]]);
      assert.deepEqual(body.by_week.map((r) => [r.week, r.n, r.few]), [[WEEK_B, 3, false], [WEEK_A, 1, true]]);
      assert.equal(body.skipped, 0);
      assert.deepEqual((await mod.efficiency(db, mod.insightFilter(new URLSearchParams('range=30d')))).by_type, []);
    } finally {
      db.close();
    }
  });

  test('a bad filter is a 400', async () => {
    for (const q of ['range=bogus', 'agent=bogus']) {
      const { status, body } = await get(q);
      assert.equal(status, 400, q);
      assert.match(body.error, /must be one of/);
    }
  });

  test('SC5: the DB file, the repo status and HEAD are unchanged after the requests', async () => {
    await get('range=all');
    assert.deepEqual(fingerprint(), before_);
  });
});

describe('GET /api/insights/efficiency/compare (GH 2069)', () => {
  const types = (side) => side.by_type.map((r) => r.type);
  const weeks = (side) => side.by_week.map((r) => r.week);

  test('task periods select by t.id; disjoint ranges share no task', async () => {
    const { status, body } = await getCompare('p1=tasks:1-12&p2=tasks:13-19');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body), ['p1', 'p2', 'filters', 'shared_tasks']);
    assert.deepEqual(Object.keys(body.p1), ['slice', 'overall', 'by_type', 'by_week', 'skipped']);
    assert.deepEqual(body.filters, { repo: null, effort: null });
    assert.equal(body.shared_tasks, 0);
    const { p1, p2 } = body;
    assert.deepEqual([p1.slice.kind, p1.slice.from_task, p1.slice.to_task], ['tasks', 1, 12]);
    assert.ok(p1.overall.n > 0 && p2.overall.n > 0);
    assertGroup(p1.overall, OVERALL_1_12);
    assert.deepEqual(types(p1), ['feat', 'fix', 'other', 'docs']);
    assertGroup(row(p1.by_type, 'type', 'feat'), FEAT);
    assertGroup(row(p1.by_type, 'type', 'fix'), FIX);
    assertGroup(row(p1.by_type, 'type', 'other'), OTHER);
    assertGroup(row(p1.by_type, 'type', 'docs'), DOCS);
    assert.deepEqual(weeks(p1), [WEEK_A, WEEK_B]);
    WEEKS.slice(0, 2).forEach((w, i) => assertGroup(p1.by_week[i], w));
    assert.equal(p1.skipped, 0);
    assertGroup(p2.overall, FEW_NULL(1));
    assert.deepEqual(types(p2), ['test']);
    assertGroup(p2.by_type[0], TEST);
    assert.deepEqual(weeks(p2), [WEEK_C]);
    assertGroup(p2.by_week[0], WEEKS[2]);
    assert.equal(p2.skipped, SKIPPED);
  });

  test('overlapping task ranges count their shared tasks, each side binning its own weeks', async () => {
    const { body } = await getCompare('p1=tasks:1-12&p2=tasks:5-8');
    assert.equal(body.shared_tasks, 4);
    assertGroup(body.p1.overall, OVERALL_1_12);
    const { p2 } = body;
    assertGroup(p2.overall, { ...groupPart(FIX), zero_line: 1 });
    assert.deepEqual(types(p2), ['fix', 'feat']);
    assertGroup(p2.by_type[0], FIX);
    assertGroup(p2.by_type[1], FEW_NULL(0, 1));
    assert.deepEqual(weeks(p2), [WEEK_A, WEEK_B]);
    assertGroup(p2.by_week[0], FEW_NULL(2, 1));
    assertGroup(p2.by_week[1], FEW_NULL(1));
  });

  test('date periods select by t.completed_at in [since, until)', async () => {
    const { status, body } = await getCompare('p1=dates:2025-03-10..2025-03-13&p2=dates:2025-02-01..2025-03-09');
    assert.equal(status, 200);
    assert.equal(body.shared_tasks, 0);
    const { p1, p2 } = body;
    assert.deepEqual([p1.slice.since, p1.slice.until], ['2025-03-10T00:00:00.000Z', '2025-03-14T00:00:00.000Z']);
    assertGroup(p1.overall, OVERALL_MAR_10_13);
    assert.deepEqual(types(p1), ['feat', 'fix', 'docs']);
    assertGroup(p1.by_type[0], FEW_NULL(2));
    assertGroup(p1.by_type[1], FEW_NULL(2));
    assertGroup(p1.by_type[2], DOCS);
    assert.deepEqual(weeks(p1), [WEEK_B, WEEK_A]);
    assertGroup(p1.by_week[0], WEEKS[1]);
    assertGroup(p1.by_week[1], FEW_NULL(1));
    assert.equal(p1.skipped, 0);
    assertGroup(p2.overall, OVERALL_FEB_1_MAR_9);
    assert.deepEqual(types(p2), ['feat', 'fix', 'other', 'test']);
    assertGroup(p2.by_type[0], FEW_NULL(2, 1));
    assert.deepEqual(weeks(p2), [WEEK_A, WEEK_C]);
    assertGroup(p2.by_week[0], WEEK_A_FEB_1_MAR_9);
    assertGroup(p2.by_week[1], FEW_NULL(1));
    assert.equal(p2.skipped, SKIPPED);
  });

  test('a date period includes its since and excludes its until', async () => {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      const dates = { key: 'd', kind: 'dates', since: '2025-03-12T18:00:00.000Z', until: '2025-03-13T18:00:00.000Z', from_task: null, to_task: null };
      const tasks = { key: 't', kind: 'tasks', since: null, until: null, from_task: 4, to_task: 8 };
      const body = await mod.efficiencyCompare(db, mod.insightFilter(new URLSearchParams()), dates, tasks);
      assert.deepEqual(body.p1.by_type.map((r) => [r.type, r.n]), [['feat', 1]]);
      assert.equal(body.shared_tasks, 1);
    } finally {
      db.close();
    }
  });

  test('Repo and Effort filter, range is ignored, Agent and Model do not apply', async () => {
    const { status, body } = await getCompare('p1=tasks:1-12&p2=tasks:-&repo=proj&effort=high&range=bogus&agent=bro&model=m');
    assert.equal(status, 200);
    assert.deepEqual(body.filters, { repo: 'proj', effort: 'high' });
    assert.equal(body.shared_tasks, 5);
    assertGroup(body.p1.overall, groupPart(FEAT));
    assert.deepEqual(types(body.p2), ['feat']);
    assert.equal(body.p2.skipped, SKIPPED_PROJ);
  });

  test('a missing or bad period, or a bad agent, is a 400', async () => {
    for (const [q, error] of [
      ['p2=7d', /^p1 must be a period/],
      ['p1=tasks:1-12', /^p2 must be a period/],
      ['p1=bogus&p2=7d', /^p1 must be a period/],
      ['p1=7d&p2=tasks:9-3', /^p2 must be a period/],
      ['p1=7d&p2=30d&agent=bogus', /must be one of/],
    ]) {
      const { status, body } = await getCompare(q);
      assert.equal(status, 400, q);
      assert.match(body.error, error, q);
    }
  });

  test('the DB file, the repo status and HEAD are unchanged after compare requests', async () => {
    await getCompare('p1=tasks:1-12&p2=tasks:5-19');
    assert.deepEqual(fingerprint(), before_);
  });
});

// A `git` shim on PATH logs each call's argv, then holds every call until the
// release file exists, so a cold efficiency request stays pending on git.
describe('SC6: numstat never blocks the event loop', () => {
  const SHIM_DIR = join(tmp, 'shim');
  const CALLS = join(tmp, 'git-calls.jsonl');
  const STARTED = join(tmp, 'git-started');
  const RELEASE = join(tmp, 'git-release');
  let slow;

  before(async () => {
    mkdirSync(SHIM_DIR);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(
      join(SHIM_DIR, 'git'),
      `#!${process.execPath}
const { appendFileSync, existsSync, writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(args) + '\\n');
writeFileSync(${JSON.stringify(STARTED)}, '');
const deadline = Date.now() + 10000;
const go = () => spawn(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 1));
const wait = () => (existsSync(${JSON.stringify(RELEASE)}) || Date.now() > deadline ? go() : setTimeout(wait, 10));
wait();
`,
      { mode: 0o755 },
    );
    slow = await startServer(DB_PATH, { PATH: `${SHIM_DIR}:${process.env.PATH}` });
  });
  after(() => slow?.stop());

  const calls = () =>
    readFileSync(CALLS, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .map((argv) => [argv[argv.indexOf('-C') + 1], argv.find((a) => a === 'cat-file' || a === 'log')]);
  const byRepo = (list) => Object.fromEntries([REPO, join(tmp, 'missing')].map((p) => [p, list.filter(([c]) => c === p).map(([, sub]) => sub)]));
  const waitFor = async (path) => {
    for (let i = 0; i < 500 && !existsSync(path); i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.ok(existsSync(path), path);
  };

  test('efficiency.ts uses no sync child_process call', () => {
    assert.doesNotMatch(readFileSync(join(DASH, 'server/efficiency.ts'), 'utf8'), /execFileSync|spawnSync|execSync/);
  });

  test('/api/summary answers while a cold efficiency request waits on git, which runs at most twice per repo', async () => {
    let settled = false;
    const pending = fetch(`${slow.url}api/insights/efficiency?range=all`).then(async (res) => {
      settled = true;
      return { status: res.status, body: await res.json() };
    });
    await waitFor(STARTED);
    const summary = await fetch(`${slow.url}api/summary`);
    assert.equal(summary.status, 200);
    await summary.json();
    assert.equal(settled, false);
    writeFileSync(RELEASE, '');
    const { status, body } = await pending;
    assert.equal(status, 200);
    assertGroup(row(body.by_type, 'type', 'feat'), FEAT);
    assert.equal(body.skipped, SKIPPED);
    assert.deepEqual(byRepo(calls()), { [REPO]: ['cat-file', 'log'], [join(tmp, 'missing')]: ['cat-file'] });
    const cold = calls().length;
    const warm = await (await fetch(`${slow.url}api/insights/efficiency?range=all`)).json();
    assertGroup(row(warm.by_type, 'type', 'feat'), FEAT);
    assert.ok(!calls().slice(cold).some(([, sub]) => sub === 'log'));
  });

  test('a cold compare loads both periods with git at most twice per repo', async () => {
    const fresh = await startServer(DB_PATH, { PATH: `${SHIM_DIR}:${process.env.PATH}` });
    try {
      writeFileSync(RELEASE, '');
      const start = existsSync(CALLS) ? calls().length : 0;
      const res = await fetch(`${fresh.url}api/insights/efficiency/compare?p1=tasks:1-12&p2=tasks:5-19`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.shared_tasks, 8);
      assertGroup(body.p1.overall, OVERALL_1_12);
      assert.equal(body.p2.skipped, SKIPPED);
      assert.deepEqual(byRepo(calls().slice(start)), { [REPO]: ['cat-file', 'log'], [join(tmp, 'missing')]: ['cat-file'] });
    } finally {
      await fresh.stop();
    }
  });
});

describe('Efficiency section', () => {
  let body;
  let insights;
  before(async () => {
    body = (await get('range=all')).body;
    insights = await (await fetch(`${server.url}api/insights?range=all`)).json();
  });
  const at = (query = 'range=all', e = body) => mod.page(`#/insights/efficiency?${query}`, insights, e);
  const tables = (html) => [...html.matchAll(/<table[^>]*>(.*?)<\/table>/g)].map((m) => m[1]);
  const headers = (table) => [...table.matchAll(/<th[^>]*>.*?<button[^>]*>(.*?)<svg/g)].map((m) => m[1]);
  const bodyRows = (table) => [...table.replace(/^.*<tbody>/, '').matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map((m) => m[1]);
  const cells = (tr) => [...tr.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
  const escaped = (s) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

  test('SC1 and SC2: title, subtitle, two tables with pooled and muted Median columns', () => {
    const html = at();
    const { copy } = mod;
    assert.match(html, new RegExp(`<h2[^>]*>${copy.EFFICIENCY_TITLE}</h2>`));
    assert.ok(html.includes(copy.EFFICIENCY_SUBTITLE));
    assert.match(html, new RegExp(`<h3[^>]*>${copy.BY_TYPE}</h3>`));
    assert.match(html, new RegExp(`<h3[^>]*>${copy.BY_WEEK}</h3>`));
    const [byType, byWeek] = tables(html);
    const metricHeaders = Object.values(copy.EFFICIENCY_COLUMNS).map((c) => c.header);
    assert.deepEqual(headers(byType), [copy.TYPE_HEADER, ...metricHeaders]);
    assert.deepEqual(headers(byWeek), [copy.WEEK_HEADER, ...metricHeaders]);
    assert.deepEqual(metricHeaders.slice(2, 6), ['Tokens/Line', 'Median', 'Rework Tokens/Line', 'Median']);
    for (const c of Object.values(copy.EFFICIENCY_COLUMNS)) assert.ok(byType.includes(`title="${escaped(c.title)}"`), c.header);
    const feat = cells(bodyRows(byType)[0]);
    assert.match(feat[0], />feat</);
    assert.match(feat[1], />4</);
    assert.match(feat[2], />50%</);
    assert.match(feat[3], />185\.7</);
    assert.doesNotMatch(feat[3], /text-fg-muted/);
    assert.match(feat[4], /text-fg-muted[^>]*>160</);
    assert.match(feat[6], /text-fg-muted[^>]*>200</);
    assert.ok(html.includes(copy.EFFICIENCY_FOOTNOTE));
    assert.ok(html.includes(copy.weekOf('Mar 3')));
  });

  test('SC1: docs is the last By Type row with a top border, and absent from By Week', () => {
    const [byType, byWeek] = tables(at());
    const rows = bodyRows(byType);
    assert.deepEqual(rows.map((r) => />([a-z]+)</.exec(cells(r)[0])[1]), ['feat', 'fix', 'other', 'test', 'docs']);
    assert.match(rows.at(-1), /border-t-\(--borderColor-default\)/);
    assert.doesNotMatch(rows[0], /border-t-\(--borderColor-default\)/);
    assert.doesNotMatch(byWeek, />docs</);
    assert.deepEqual(bodyRows(byWeek).map((r) => /Week of [A-Z][a-z]{2} \d+/.exec(cells(r)[0])[0]), ['Week of Mar 3', 'Week of Mar 10', 'Week of Feb 24']);
  });

  test('SC3: few groups keep name and n, show the label and — in every metric cell, and sort last', () => {
    const html = at();
    const { copy } = mod;
    const [byType, byWeek] = tables(html);
    for (const tr of [bodyRows(byType)[2], bodyRows(byType)[3], bodyRows(byWeek)[2]]) {
      const [name, n, ...metrics] = cells(tr);
      assert.ok(name.includes(copy.FEW_TASKS), name);
      assert.ok(name.includes(`title="${copy.FEW_TASKS_TITLE}"`));
      assert.match(n, />1</);
      for (const m of metrics) assert.match(m, /text-fg-muted[^>]*>—</);
    }
    assert.ok(!cells(bodyRows(byType)[0])[0].includes(copy.FEW_TASKS));
    assert.equal(html.split(copy.FEW_CAPTION).length - 1, 2);
  });

  test('below md only Type/Week, Tasks, First Pass %, Tokens/Line and Rework Cost % stay', () => {
    const [byType] = tables(at());
    const ths = [...byType.matchAll(/<th[^>]*class="([^"]*)"[^>]*>.*?<button[^>]*>(.*?)<svg/g)];
    const shown = ths.filter((m) => !m[1].includes('max-md:hidden')).map((m) => m[2]);
    const { copy } = mod;
    assert.deepEqual(shown, [copy.TYPE_HEADER, ...['n', 'first_pass_rate', 'fp_tok_line', 'rework_share'].map((k) => copy.EFFICIENCY_COLUMNS[k].header)]);
  });

  test('Agent and Model filters are hidden', () => {
    const html = at('range=all&agent=swe');
    assert.doesNotMatch(html, />Agent<select/);
    assert.doesNotMatch(html, />Model<select/);
    assert.match(html, />Repo<select/);
    assert.match(html, />Effort<select/);
  });

  test('empty state when no task in the period has changed lines', () => {
    const { copy } = mod;
    const empty = { ...body, by_type: [], by_week: [] };
    const html = at('range=all', empty);
    assert.ok(html.includes(copy.EFFICIENCY_EMPTY));
    assert.doesNotMatch(html, /<table/);
    const zero = at('range=all', { ...body, by_type: [{ ...OTHER, type: 'feat', n: 0, zero_line: 2 }], by_week: [] });
    assert.ok(zero.includes(copy.EFFICIENCY_EMPTY));
  });

  test('efficiencyApiPath drops Agent and Model', () => {
    const p = mod.paramsOf('#/insights/efficiency?range=7d&repo=proj&agent=swe&model=m&effort=high');
    assert.equal(mod.copy.efficiencyApiPath(p), 'insights/efficiency?range=7d&repo=proj&effort=high');
  });
});

describe('Efficiency section in compare mode (GH 2069 C2)', () => {
  const view = async (p1, p2) => {
    const query = `p1=${p1}&p2=${p2}`;
    const cmp = await (await fetch(`${server.url}api/insights/compare?${query}`)).json();
    const eff = (await getCompare(query)).body;
    return mod.comparePage(`#/insights/efficiency?range=all&${query}`, cmp, eff);
  };
  const tables = (html) => [...html.matchAll(/<table[^>]*>(.*?)<\/table>/g)].map((m) => m[1]);
  const headers = (table) => [...table.matchAll(/<th[^>]*>.*?<button[^>]*>(.*?)<svg/g)].map((m) => m[1]);
  const bodyRows = (table) => [...table.replace(/^.*<tbody>/, '').matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map((m) => m[0]);
  const cells = (tr) => [...tr.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
  const tiles = (html) => [...html.matchAll(/data-compare-tile="([a-z_]+)"/g)].map((m) => m[1]);

  test('SC4: Efficiency is a compare section and fetches the compare path only while comparing', () => {
    assert.ok(mod.copy.COMPARE_SECTIONS.has('efficiency'));
    assert.equal(mod.copy.COMPARE_SCOPE_NOTE, undefined);
    const on = mod.paramsOf('#/insights/efficiency?range=7d&repo=proj&agent=swe&effort=high&p1=tasks:1-4&p2=tasks:5-');
    assert.equal(mod.copy.efficiencyApiPath(on), 'insights/efficiency/compare?repo=proj&effort=high&p1=tasks:1-4&p2=tasks:5-');
    const bare = mod.paramsOf('#/insights/efficiency?range=all&p1=tasks:1-4&p2=tasks:5-');
    assert.equal(mod.copy.efficiencyApiPath(bare), 'insights/efficiency/compare?p1=tasks:1-4&p2=tasks:5-');
  });

  test('SC1: four tiles from each overall, with no scope note', async () => {
    const html = await view('tasks:1-4', 'tasks:5-13');
    assert.deepEqual(tiles(html), ['tok_line', 'first_pass', 'rework_share', 'cache_hit']);
    for (const title of Object.values(mod.copy.EFFICIENCY_TILES)) assert.ok(html.includes(title), title);
    assert.match(html, /grid-cols-2 gap-2 md:grid-cols-4" data-efficiency-tiles=""/);
    assert.ok(!html.includes('data-compare-scope'));
    assert.ok(!html.includes('except Efficiency'));
  });

  test('SC2: paired bars over the union of types and compare columns with deltas, docs last', async () => {
    const html = await view('tasks:1-4', 'tasks:5-13');
    const { copy } = mod;
    assert.ok(html.includes(copy.TOK_LINE_BY_TYPE));
    const pairs = [...html.matchAll(/<g data-pair="">.*?<text[^>]*>([a-z]+)<\/text>/g)].map((m) => m[1]);
    assert.equal(pairs.at(-1), 'docs');
    assert.ok(pairs.includes('feat') && pairs.includes('fix'), pairs.join());
    assert.equal(new Set(pairs).size, pairs.length);
    assert.match(html, /<rect[^>]*stroke-dasharray="4 3"[^>]*data-outline=""/);
    const [byType, byWeek] = tables(html);
    assert.deepEqual(headers(byType), [copy.TYPE_HEADER, ...['n', 'first_pass_rate', 'fp_tok_line', 'rework_share'].map((k) => copy.EFFICIENCY_COLUMNS[k].header)]);
    const rows = bodyRows(byType);
    const names = rows.map((r) => />([a-z]+)</.exec(cells(r)[0])[1]);
    assert.deepEqual(names, pairs);
    assert.match(rows.at(-1), /border-t-\(--borderColor-default\)/);
    const feat = cells(rows[names.indexOf('feat')]);
    assert.ok(feat[1].includes(copy.period1Value('4')), feat[1]);
    for (const c of feat.slice(2)) assert.match(c, /data-delta="/);
    const fix = cells(rows[names.indexOf('fix')]);
    assert.ok(fix[1].includes(copy.period1Value('0')));
    assert.match(fix[3], /Period 1 has no tasks to compare against/);
    assert.ok(byWeek);
  });

  test('GH 2545: the paired bars draw one divider, above the docs row, and none without docs', async () => {
    const pairRows = (html) => [...html.matchAll(/<g data-pair="">(.*?)<\/g>/gs)].map((m) => m[1]);
    const label = (row) => /<text[^>]*>([a-z]+)<\/text>/.exec(row)?.[1];
    const html = await view('tasks:1-4', 'tasks:5-13');
    const rows = pairRows(html);
    assert.ok(rows.length > 1 && label(rows.at(-1)) === 'docs', rows.map(label).join());
    assert.equal((html.match(/data-divider=""/g) ?? []).length, 1);
    assert.match(rows.at(-1), /data-divider=""/);
    const none = await view('tasks:1-4', 'tasks:5-8');
    const plain = pairRows(none);
    assert.ok(plain.length > 0 && !plain.map(label).includes('docs'), plain.map(label).join());
    assert.doesNotMatch(none, /data-divider=/);
  });

  test('SC3: one By Week table with a leading Period cell, Period 1 weeks first, divider before Period 2', async () => {
    const html = await view('tasks:1-4', 'tasks:5-13');
    const { copy } = mod;
    const [, byWeek] = tables(html);
    assert.equal(tables(html).length, 2);
    assert.deepEqual(headers(byWeek).slice(0, 2), [copy.PERIOD_HEADER, copy.WEEK_HEADER]);
    const rows = bodyRows(byWeek);
    const periods = rows.map((r) => /Period [12]/.exec(cells(r)[0])[0]);
    const first2 = periods.indexOf('Period 2');
    assert.ok(first2 > 0);
    assert.deepEqual(periods, [...Array(first2).fill('Period 1'), ...Array(periods.length - first2).fill('Period 2')]);
    rows.forEach((r, i) => (i === first2 ? assert.match(r, /border-t-\(--borderColor-default\)/) : assert.doesNotMatch(r, /border-t-\(--borderColor-default\)/)));
    assert.doesNotMatch(byWeek, /data-delta=/);
  });

  test('SC4: both periods empty shows the empty state; one empty says so above the tiles with dashes on that side', async () => {
    const { copy } = mod;
    const both = await view('tasks:900-950', 'tasks:960-');
    assert.ok(both.includes(copy.EFFICIENCY_EMPTY));
    assert.deepEqual(tiles(both), []);
    assert.doesNotMatch(both, /<table/);
    assert.equal(copy.EFFICIENCY_PERIOD_EMPTY(2), 'Period 2 has no finished tasks with code changes.');
    const one = await view('tasks:1-4', 'tasks:900-');
    assert.ok(one.indexOf(copy.EFFICIENCY_PERIOD_EMPTY(2)) < one.indexOf('data-compare-tile='));
    assert.match(one, /data-period-empty="2"/);
    assert.doesNotMatch(one, /data-period-empty="1"/);
    assert.ok(!one.includes(copy.EFFICIENCY_EMPTY));
    for (const tile of one.matchAll(/data-compare-tile="[a-z_]+">(.*?)<\/div>/g)) assert.match(tile[1], /text-2xl[^>]*>—</);
    const first = await view('tasks:900-', 'tasks:1-4');
    assert.ok(first.includes(copy.EFFICIENCY_PERIOD_EMPTY(1)));
    for (const tile of first.matchAll(/data-compare-tile="[a-z_]+">(.*?)<\/div>/g)) assert.ok(tile[1].includes(copy.period1Value('—')));
  });
});
