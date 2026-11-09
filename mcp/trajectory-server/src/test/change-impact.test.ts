import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDB } from './helpers.js';
import type { TrajectoryDB } from '../db.js';
import {
  baseRef,
  BuildHistory,
  changeIdOf,
  computeChangeImpact,
  defaultGit,
  gitSourceFor,
  METRICS,
  PROVIDERS,
  providerContext,
  sampleCounts,
  type SplitSample,
  type ChangeImpact,
  type ChangeImpactList,
  type GitCommit,
  type GitSource,
} from '../change-impact/index.js';
import { bootstrapRatioCi, holm, mannWhitneyU, median } from '../change-impact/stats.js';
import { changeImpactTools } from '../tools/change-impact.js';
import { insertAudit } from '../tools/audit.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempRepo(branch: string): { dir: string; commit: (msg: string, at: number, file?: string) => string; g: (...a: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'ci-git-'));
  dirs.push(dir);
  const g = (...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  g('init', '-q', '-b', branch);
  const commit = (msg: string, at: number, file?: string) => {
    const date = iso(at);
    if (file) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), `${msg}\n`);
      g('add', file);
    }
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', msg], {
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    return g('rev-parse', 'HEAD').trim();
  };
  return { dir, commit, g };
}

function fakeSource(prs: number[], tags: Record<string, string> = {}): GitSource {
  const commits: GitCommit[] = prs.map((pr, i) => ({ sha: `sha${i}`, at: iso(T0 + i * DAY), subject: `✨ feat: change ${pr} (#${pr})` }));
  return { target: 'origin/trunk', commits: () => commits, mergeBase: (ref) => tags[ref] ?? null };
}

const PRS = [100, 101, 102, 103, 104, 105];
const devVersion = (pr: number) => `1.2.0-dev.1.gh${pr}`;

function seedTask(db: TrajectoryDB, done = true): number {
  const now = iso(T0);
  db.run("INSERT INTO issues (objective, description, status, created_at, updated_at) VALUES ('i', '', 'open', ?, ?)", [now, now]);
  const issueId = db.get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;
  db.run(
    'INSERT INTO tasks (issue_id, branch_id, title, description, status, commit_sha, completed_at, created_at, updated_at) VALUES (?, ?, \'t\', \'d\', ?, ?, ?, ?, ?)',
    [issueId, `feat/t${issueId}`, done ? 'closed' : 'running', done ? 'abc1234' : null, done ? now : null, now, now],
  );
  return db.get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;
}

function seedRun(
  db: TrajectoryDB,
  taskId: number | null,
  at: number,
  version: string | null,
  tokensIn: number | null,
  extra: { agent?: string; exit?: string; hookBlock?: number; session?: string } = {},
): void {
  db.run(
    'INSERT INTO agent_runs (task_id, agent_type, tokens_in, tokens_out, started_at, plugin_version, exit_reason, hook_block_tokens, session_id) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)',
    [taskId, extra.agent ?? 'swe', tokensIn, iso(at), version, extra.exit ?? null, extra.hookBlock ?? null, extra.session ?? null],
  );
}

/** <n> tasks a side with a high rework ratio before and a low one after: before at <beforeAt>, after at <afterAt>. */
function seedReworkSides(db: TrajectoryDB, n: number, beforeAt: number, beforeVersion: string | null, afterAt: number, afterVersion: string | null): void {
  for (let i = 0; i < n; i++) {
    const before = seedTask(db);
    seedRun(db, before, beforeAt + i * 60_000, beforeVersion, 100);
    seedRun(db, before, beforeAt + i * 60_000 + 1000, beforeVersion, 200 + i);
    const after = seedTask(db);
    seedRun(db, after, afterAt + i * 60_000, afterVersion, 100);
    seedRun(db, after, afterAt + i * 60_000 + 1000, afterVersion, 50 + i);
  }
}

/** A dev-build repo: PRs 100..105 merged a day apart from T0 on `trunk`, plus a repo row whose history holds none of them. */
function devFixture(n: number): TrajectoryDB {
  const db = tempDB();
  const r = tempRepo('trunk');
  PRS.forEach((pr, i) => r.commit(`✨ feat: change ${pr} (#${pr})`, T0 + i * DAY));
  const other = tempRepo('trunk');
  other.commit('unrelated (#1)', T0);
  db.run("INSERT INTO repos (name, path, target_branch) VALUES ('builds', ?, 'trunk'), ('other', ?, 'trunk')", [r.dir, other.dir]);
  seedReworkSides(db, n, T0 + DAY, devVersion(101), T0 + 4 * DAY, devVersion(104));
  return db;
}

function parse(result: unknown): unknown {
  return JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
}

const FOREIGN = /trustmybot|gh\d|#\d|v1\.2\.0|origin\/dev|"dev"/;

interface Acme {
  db: TrajectoryDB;
  surfaceSha: string;
  srcSha: string;
}

/** SC4: acme-app on `trunk`, no remote; a non-surface, a CLAUDE.md and a src/ commit; release-only versions and custom labels. */
function acmeFixture(n: number): Acme {
  const r = tempRepo('trunk');
  r.commit('chore: readme', T0, 'README.md');
  const surfaceSha = r.commit('docs: agent rules', T0 + 5 * DAY, 'CLAUDE.md');
  const srcSha = r.commit('feat: app code', T0 + 6 * DAY, 'src/app.ts');
  const db = tempDB();
  db.run("INSERT INTO repos (name, path, target_branch) VALUES ('acme-app', ?, 'trunk')", [r.dir]);
  db.run("INSERT INTO milestones (name, repo) VALUES ('Sprint 7', 'acme-app')");
  db.run(
    "INSERT INTO issues (objective, description, status, created_at, updated_at, repo, milestone, labels) VALUES ('acme issue', '', 'open', ?, ?, 'acme-app', 'Sprint 7', ?)",
    [iso(T0), iso(T0), JSON.stringify(['kind/bug', 'prio/p1'])],
  );
  seedReworkSides(db, n, T0 + 4 * DAY, '0.9.0', T0 + 5 * DAY + 3_600_000, '1.0.0');
  return { db, surfaceSha, srcSha };
}

describe('change impact — stats', () => {
  it('median takes the midpoint of the two middles', () => {
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([]), null);
  });

  it('Mann-Whitney U matches a hand-computed tied case', () => {
    // x=[1,2,2,4] y=[2,3,5,6]: ranks 1,3,3,6 for x → R1=13, U=3, mu=8,
    // var=(16/12)(9-24/56)=11.4286, z=(5-0.5)/3.3806=1.3311, p=erfc(z/√2)=0.18315.
    const r = mannWhitneyU([1, 2, 2, 4], [2, 3, 5, 6]);
    assert.equal(r.u, 3);
    assert.ok(Math.abs(r.p - 0.18315) < 1e-4, `p=${r.p}`);
    assert.ok(r.z < 0);
  });

  it('Holm adjusts in ascending order and keeps monotonicity', () => {
    const adj = holm([0.01, 0.04, 0.03]);
    assert.deepEqual(adj.map((p) => Math.round(p * 1e6) / 1e6), [0.03, 0.06, 0.06]);
    assert.deepEqual(holm([0.5, 0.001]), [0.5, 0.002]);
  });

  it('bootstrap CI is deterministic for a seed', () => {
    const b = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = [2, 3, 4, 5, 6, 7, 8, 9];
    assert.deepEqual(bootstrapRatioCi(b, a, 42), bootstrapRatioCi(b, a, 42));
  });
});

describe('change impact — attribution', () => {
  const h = new BuildHistory(fakeSource(PRS, { 'v1.1.0': 'sha3', 'v1.2.0-rc.1': 'sha4' }));

  it('a dev build maps to its PR index', () => {
    assert.deepEqual(h.attribute(devVersion(103), iso(T0)), { idx: 3, estimated: false });
  });

  it('a stable or rc version maps through its tag merge-base', () => {
    assert.deepEqual(h.attribute('1.1.0', iso(T0)), { idx: 3, estimated: false });
    assert.deepEqual(h.attribute('1.2.0-rc.1', iso(T0)), { idx: 4, estimated: false });
  });

  it('a NULL version is estimated from the newest commit at or before the sample', () => {
    assert.deepEqual(h.attribute(null, iso(T0 + 2 * DAY + 5)), { idx: 2, estimated: true });
    assert.deepEqual(h.attribute(null, iso(T0 + 2 * DAY)), { idx: 2, estimated: true });
    assert.equal(h.attribute(null, iso(T0 - 1)), null);
  });

  it('an unmappable version is unattributed', () => {
    assert.equal(h.attribute(devVersion(999), iso(T0)), null);
    assert.equal(h.attribute('1.0.0', iso(T0)), null);
    assert.equal(h.attribute('garbage', iso(T0)), null);
  });

  it('reads first-parent PR subjects and tag merge-bases from a real repo', () => {
    const r = tempRepo('trunk');
    r.commit('first (#7)', T0);
    r.g('tag', 'v1.0.0');
    r.commit('second (#8)', T0 + DAY);
    const hist = new BuildHistory(gitSourceFor(defaultGit, r.dir, baseRef(defaultGit, r.dir, 'trunk')));
    assert.equal(hist.target, 'trunk');
    assert.equal(hist.indexOfPr(7), 0);
    assert.equal(hist.indexOfPr(8), 1);
    assert.deepEqual(hist.attribute('1.0.0', iso(T0)), { idx: 0, estimated: false });
  });

  it('the base branch prefers origin/<target>, then <target>, then origin/HEAD, then HEAD', () => {
    const r = tempRepo('trunk');
    r.commit('first', T0);
    assert.equal(baseRef(defaultGit, r.dir, 'trunk'), 'trunk');
    assert.equal(baseRef(defaultGit, r.dir, null), 'HEAD');
    assert.equal(baseRef(defaultGit, r.dir, 'missing'), 'HEAD');
    r.g('update-ref', 'refs/remotes/origin/stable', 'HEAD');
    r.g('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/stable');
    assert.equal(baseRef(defaultGit, r.dir, null), 'origin/stable');
    r.g('update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    assert.equal(baseRef(defaultGit, r.dir, 'trunk'), 'origin/trunk');
  });
});

describe('change impact — plugin_version with the dev-build resolver', () => {
  it('splits by build: shape, an improved rework ratio and measured_with', () => {
    const db = devFixture(25);
    const r = computeChangeImpact(db, undefined, { change: { source: 'plugin_version', id: '102' } });
    assert.deepEqual(Object.keys(r), ['source', 'id', 'label', 'at', 'kind', 'repo', 'measured_with', 'metrics']);
    assert.equal(r.kind, 'build');
    assert.equal(r.repo, 'builds');
    assert.equal(r.at, iso(T0 + 2 * DAY));
    assert.deepEqual(r.measured_with, [{ source: 'plugin_version', id: '103' }]);
    assert.deepEqual(r.metrics.map((m) => m.id), METRICS.map((m) => m.id));
    for (const m of r.metrics) {
      assert.deepEqual(Object.keys(m), [
        'id', 'label', 'unit', 'direction', 'before', 'after', 'ratio_of_medians', 'ratio_ci', 'p', 'p_holm', 'verdict',
      ]);
      assert.deepEqual(Object.keys(m.before), ['n', 'median', 'mean', 'estimated_n', 'unattributed_n']);
    }
    const rework = r.metrics.find((m) => m.id === 'swe_rework_ratio')!;
    assert.equal(rework.before.n, 25);
    assert.equal(rework.after.n, 25);
    assert.equal(rework.verdict, 'improved');
    assert.ok(rework.ratio_ci![1] < 1);
    assert.ok(rework.p_holm! < 0.05);
    assert.ok(rework.p_holm! >= rework.p!);
  });

  it('a side under 20 samples is not_enough_data with null p, p_holm and ratio_ci (SC3)', () => {
    const db = devFixture(19);
    const m = computeChangeImpact(db, undefined, { change: { source: 'plugin_version', id: '102' }, metric: 'swe_rework_ratio' }).metrics[0]!;
    assert.equal(m.before.n, 19);
    assert.equal(m.verdict, 'not_enough_data');
    assert.equal(m.p, null);
    assert.equal(m.p_holm, null);
    assert.equal(m.ratio_ci, null);
    assert.ok(m.ratio_of_medians !== null);
  });

  it('counts estimated and unattributed samples, skips unmeasured and swept_orphan runs', () => {
    const db = devFixture(20);
    const t = seedTask(db);
    seedRun(db, t, T0 + DAY / 2, null, 100);
    seedRun(db, t, T0 + DAY / 2 + 1, null, 300);
    seedRun(db, t, T0 + DAY / 2 + 2, devVersion(101), null);
    seedRun(db, t, T0 + DAY / 2 + 3, devVersion(101), 999, { exit: 'swept_orphan' });
    seedRun(db, t, T0 + DAY / 2 + 4, 'weird', 100);
    const m = computeChangeImpact(db, undefined, { change: { source: 'plugin_version', id: '102' }, metric: 'swe_rework_ratio' }).metrics[0]!;
    assert.equal(m.before.n, 21);
    assert.equal(m.before.estimated_n, 1);
    assert.equal(m.before.unattributed_n, 1);
    assert.equal(m.after.unattributed_n, 0);
  });

  it('caps each side at max_samples nearest the change and drops samples outside the window', () => {
    const db = devFixture(25);
    const t = seedTask(db);
    seedRun(db, t, T0 - 30 * DAY, devVersion(100), 100);
    seedRun(db, t, T0 - 30 * DAY + 1, devVersion(100), 100);
    seedRun(db, t, T0 + DAY, devVersion(100), 100);
    const change = { source: 'plugin_version' as const, id: '102' };
    const capped = computeChangeImpact(db, undefined, { change, metric: 'swe_rework_ratio', max_samples: 10, window_days: 3 });
    assert.equal(capped.metrics[0]!.before.n, 10);
    assert.equal(capped.metrics[0]!.after.n, 10);
    assert.equal(computeChangeImpact(db, undefined, { change, metric: 'swe_rework_ratio', window_days: 3 }).metrics[0]!.before.n, 26);
    assert.equal(computeChangeImpact(db, undefined, { change, metric: 'swe_rework_ratio', window_days: 40 }).metrics[0]!.before.n, 27);
  });

  it('series: true adds daily before/after points from the kept samples; absent otherwise', () => {
    const db = devFixture(25);
    for (const [at, pr] of [[T0 + 0.5 * DAY, 100], [T0 + 1.5 * DAY, 101], [T0 + 2.5 * DAY, 101], [T0 + 2.2 * DAY, 104], [T0 + 5.5 * DAY, 104], [T0 + 6.5 * DAY, 105]] as const) {
      const t = seedTask(db);
      seedRun(db, t, at, devVersion(pr), 100);
      seedRun(db, t, at + 1000, devVersion(pr), 300);
    }
    const change = { source: 'plugin_version' as const, id: '102' };
    const opts = { change, window_days: 5, max_samples: 24 };
    const ctx = providerContext(db);
    const r = computeChangeImpact(db, ctx, { ...opts, series: true });
    const at = Date.parse(r.at);
    const provider = PROVIDERS.find((p) => p.source === 'plugin_version')!;
    const keptDays = (samples: SplitSample[]) => {
      const byDay = new Map<string, number[]>();
      for (const s of samples.filter((s) => Math.abs(s.t - at) <= 5 * DAY).sort((a, b) => Math.abs(a.t - at) - Math.abs(b.t - at)).slice(0, 24)) {
        const day = iso(s.t).slice(0, 10);
        byDay.set(day, [...(byDay.get(day) ?? []), s.value]);
      }
      return byDay;
    };
    let multiDay = false;
    for (const m of r.metrics) {
      assert.ok(m.series, m.id);
      const metric = METRICS.find((x) => x.id === m.id)!;
      const split = provider.split(r, ctx, metric);
      for (const [name, points, samples] of [['before', m.series.before, split.before], ['after', m.series.after, split.after]] as const) {
        assert.equal(points.reduce((sum, p) => sum + p.n, 0), m[name].n, `${m.id} ${name} n`);
        const days = points.map((p) => p.day);
        for (const d of days) assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
        assert.deepEqual(days, [...days].sort(), `${m.id} ${name} ascending`);
        assert.equal(new Set(days).size, days.length);
        const expected = keptDays(samples);
        assert.deepEqual(days, [...expected.keys()].sort());
        for (const p of points) {
          assert.ok(p.n > 0);
          assert.equal(p.median, median(expected.get(p.day)!), `${m.id} ${name} ${p.day}`);
        }
        if (points.length > 1) multiDay = true;
      }
    }
    assert.ok(multiDay, 'some side spans several days');
    const rework = r.metrics.find((m) => m.id === 'swe_rework_ratio')!;
    assert.equal(rework.before.n, 24);
    assert.ok(rework.series!.before.length > 1);
    assert.ok(rework.series!.after.length > 1);

    const plain = computeChangeImpact(db, ctx, opts);
    for (const m of plain.metrics) assert.ok(!('series' in m), m.id);
    const off = computeChangeImpact(db, ctx, { ...opts, series: false });
    for (const m of off.metrics) assert.ok(!('series' in m), m.id);
    const list = computeChangeImpact(db, ctx, { limit: 3 }) as ChangeImpactList;
    for (const c of list.changes) for (const m of c.metrics) assert.ok(!('series' in m));
    const { series: _s, ...stats } = rework;
    assert.deepEqual(stats, plain.metrics.find((m) => m.id === 'swe_rework_ratio'));
  });

  it('the list form gives the last limit changes, newest first, and replaces version events with builds', () => {
    const r = computeChangeImpact(devFixture(1), undefined, { limit: 2 }) as ChangeImpactList;
    assert.deepEqual(r.sources, ['plugin_version']);
    assert.deepEqual(r.changes.map((c) => [c.source, c.id, c.kind]), [['plugin_version', '105', 'build'], ['plugin_version', '104', 'build']]);
  });

  it('an unknown ref is an error', () => {
    assert.throws(() => computeChangeImpact(devFixture(1), undefined, { change: { source: 'plugin_version', id: '9' } }), /^Error: unknown change plugin_version:9$/);
    assert.throws(() => computeChangeImpact(tempDB(), undefined, { change: { source: 'nope' as never, id: '1' } }), /source must be one of/);
  });
});

describe('change impact — a non-TMB repo (SC4)', () => {
  const sides = (r: ChangeImpact) => r.metrics.find((m) => m.id === 'swe_rework_ratio')!;

  it('lists both sources, one agent_surface change by SHA, and every result names nothing of ours', () => {
    const { db, surfaceSha } = acmeFixture(25);
    const list = computeChangeImpact(db) as ChangeImpactList;
    for (const s of ['plugin_version', 'agent_surface']) assert.ok(list.sources.includes(s as never), s);
    const surface = list.changes.filter((c) => c.source === 'agent_surface');
    assert.equal(surface.length, 1);
    assert.equal(surface[0]!.id, surfaceSha.slice(0, 12));
    assert.equal(surface[0]!.kind, 'commit');
    assert.equal(surface[0]!.repo, 'acme-app');
    const version = computeChangeImpact(db, undefined, { change: { source: 'plugin_version', id: '1.0.0' } });
    const commit = computeChangeImpact(db, undefined, { change: { source: 'agent_surface', id: surfaceSha.slice(0, 12) } });
    assert.equal(version.kind, 'version');
    for (const r of [version, commit]) {
      const m = sides(r);
      assert.ok(m.before.n >= 20 && m.after.n >= 20, `${r.source}: ${m.before.n}/${m.after.n}`);
      assert.notEqual(m.p, null);
    }
    for (const r of [list, version, commit]) assert.doesNotMatch(JSON.stringify(r), FOREIGN);
    assert.throws(() => computeChangeImpact(db, undefined, { change: { source: 'plugin_version', id: '0.9.0' } }), /unknown change plugin_version:0\.9\.0/);
  });

  it('a side under 20 samples is not_enough_data for both providers (SC3)', () => {
    const { db, surfaceSha } = acmeFixture(19);
    for (const change of [
      { source: 'plugin_version' as const, id: '1.0.0' },
      { source: 'agent_surface' as const, id: surfaceSha.slice(0, 12) },
    ]) {
      const m = sides(computeChangeImpact(db, undefined, { change }));
      assert.equal(m.verdict, 'not_enough_data', change.source);
      assert.equal(m.p, null);
      assert.equal(m.p_holm, null);
      assert.equal(m.ratio_ci, null);
    }
  });
});

describe('change impact — config and ids (SC5)', () => {
  it('a repo-scoped surface glob replaces the defaults', () => {
    const { db, srcSha } = acmeFixture(1);
    const configKey = 'change_impact_agent_surface';
    db.run('INSERT INTO plugin_config (key, value_json) VALUES (?, ?)', [configKey, JSON.stringify(['acme-app:src/**'])]);
    const r = computeChangeImpact(db, undefined, { source: 'agent_surface' }) as ChangeImpactList;
    assert.deepEqual(r.changes.map((c) => c.id), [srcSha.slice(0, 12)]);
    db.run('UPDATE plugin_config SET value_json = ? WHERE key = ?', [JSON.stringify(['other-repo:src/**']), configKey]);
    assert.deepEqual((computeChangeImpact(db, undefined, { source: 'agent_surface' }) as ChangeImpactList).changes, []);
  });

  it('changeIdOf takes the squash or merge-request number only with a remote', () => {
    const sha = 'abcdef0123456789abcdef0123456789abcdef01';
    assert.equal(changeIdOf(true, 'x (#42)', '', sha), '42');
    assert.equal(changeIdOf(true, 'Merge branch x', 'See merge request acme/app!7', sha), '7');
    assert.equal(changeIdOf(false, 'x (#42)', 'See merge request acme/app!7', sha), 'abcdef012345');
    assert.equal(changeIdOf(true, 'plain', '', sha), 'abcdef012345');
  });

  it('a commit id is its number when the repo has an origin remote', () => {
    const r = tempRepo('trunk');
    r.commit('docs: rules (#12)', T0, 'CLAUDE.md');
    r.g('remote', 'add', 'origin', 'https://example.invalid/acme/app.git');
    const db = tempDB();
    db.run("INSERT INTO repos (name, path, target_branch) VALUES ('acme-app', ?, 'trunk')", [r.dir]);
    const list = computeChangeImpact(db, undefined, { source: 'agent_surface' }) as ChangeImpactList;
    assert.deepEqual(list.changes.map((c) => c.id), ['12']);
  });

  it('a throwing git skips agent_surface and leaves plugin_version working', () => {
    const { db } = acmeFixture(25);
    const ctx = providerContext(db, () => {
      throw new Error('git unavailable');
    });
    const list = computeChangeImpact(db, ctx) as ChangeImpactList;
    assert.deepEqual(list.sources, ['plugin_version']);
    assert.equal(list.changes.filter((c) => c.source === 'agent_surface').length, 0);
    const v = computeChangeImpact(db, ctx, { change: { source: 'plugin_version', id: '1.0.0' } });
    assert.equal(v.id, '1.0.0');
  });
});

describe('change impact — a ref names its repo (GH 2613)', () => {
  function twoRepos(path?: string): TrajectoryDB {
    const db = tempDB({ path });
    for (const name of ['alpha-app', 'beta-app']) {
      const r = tempRepo('trunk');
      r.commit(`docs: ${name} rules (#12)`, T0, 'CLAUDE.md');
      r.g('remote', 'add', 'origin', `https://example.invalid/acme/${name}.git`);
      db.run("INSERT INTO repos (name, path, target_branch) VALUES (?, ?, 'trunk')", [name, r.dir]);
    }
    return db;
  }

  it('an id two repos share is ambiguous without a repo and names both (SC1)', () => {
    const db = twoRepos();
    assert.throws(
      () => computeChangeImpact(db, undefined, { change: { source: 'agent_surface', id: '12' } }),
      (e: Error) => /ambiguous change agent_surface:12/.test(e.message) && e.message.includes('alpha-app') && e.message.includes('beta-app'),
    );
  });

  it('a repo picks that repo\'s change (SC2)', () => {
    const db = twoRepos();
    for (const repo of ['alpha-app', 'beta-app']) {
      const r = computeChangeImpact(db, undefined, { change: { source: 'agent_surface', id: '12', repo } });
      assert.equal(r.repo, repo);
      assert.equal(r.id, '12');
    }
  });

  it('an unknown repo for a known id is unknown and names the repo (SC3)', () => {
    const db = twoRepos();
    assert.throws(
      () => computeChangeImpact(db, undefined, { change: { source: 'agent_surface', id: '12', repo: 'gamma-app' } }),
      /^Error: unknown change agent_surface:12 in repo gamma-app$/,
    );
  });

  it('the tool schema lists change.repo as optional and the parser passes it through or rejects a non-string (SC4)', async () => {
    const db = twoRepos();
    const { definitions, handlers } = changeImpactTools(db);
    const change = (definitions[0]!.inputSchema.properties as Record<string, { properties: Record<string, { type: string }>; required: string[] }>)['change']!;
    assert.equal(change.properties['repo']!.type, 'string');
    assert.ok(!change.required.includes('repo'));
    const tool = handlers['change_impact']!;
    const picked = parse(await tool({ agent: 'bro', change: { source: 'agent_surface', id: '12', repo: 'beta-app' } })) as ChangeImpact;
    assert.equal(picked.repo, 'beta-app');
    const bad = (await tool({ agent: 'bro', change: { source: 'agent_surface', id: '12', repo: 7 } })) as { isError?: boolean };
    assert.equal(bad.isError, true);
    assert.equal((parse(bad) as { error: string }).error, 'change.repo must be a string');
    const ambiguous = (await tool({ agent: 'bro', change: { source: 'agent_surface', id: '12' } })) as { isError?: boolean };
    assert.equal(ambiguous.isError, true);
  });

  it('the CLI passes --repo through (SC4)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-cli-'));
    dirs.push(dir);
    const path = join(dir, 'trajectory.db');
    twoRepos(path).close();
    const cli = fileURLToPath(new URL('../change-impact/cli.js', import.meta.url));
    const run = (...extra: string[]) =>
      spawnSync(process.execPath, ['--experimental-sqlite', cli, '--db', path, '--source', 'agent_surface', '--id', '12', ...extra], { encoding: 'utf8' });
    const picked = run('--repo', 'alpha-app');
    assert.equal(picked.status, 0, picked.stderr);
    assert.equal((JSON.parse(picked.stdout) as ChangeImpact).repo, 'alpha-app');
    const ambiguous = run();
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /ambiguous change agent_surface:12/);
  });
});

describe('change impact — tmb_events', () => {
  const T = T0 + 5 * DAY;

  function seedCheatcode(db: TrajectoryDB, name: string, status: string, at: number): number {
    db.run(
      "INSERT INTO cheatcodes (name, kind, origin, source_url, status, installed_at) VALUES (?, 'mcp', 'marketplace', ?, ?, ?)",
      [name, `https://example.invalid/${name}`, status, iso(at)],
    );
    return db.get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;
  }

  function seedAudit(db: TrajectoryDB, eventType: 'cheatcode_uninstalled' | 'config_changed', summary: string, content: string, at: number): number {
    return insertAudit(db, { issue_id: -1, from_node: 'bro', event_type: eventType, summary, content_json: content, created_at: iso(at) });
  }

  function tmbFixture(): { db: TrajectoryDB; installId: number; uninstallId: number; configId: number } {
    const db = tempDB();
    const installId = seedCheatcode(db, 'acme-search', 'active', T);
    seedCheatcode(db, 'acme-draft', 'draft', T);
    const uninstallId = seedAudit(db, 'cheatcode_uninstalled', "Cheatcode uninstall: 'acme-old' (kind=mcp)", JSON.stringify({ name: 'acme-old' }), T + 3 * DAY);
    const configId = seedAudit(db, 'config_changed', 'Config changed: acme.flag', JSON.stringify({ key: 'acme.flag' }), T + 4 * DAY);
    seedReworkSides(db, 25, T - 2 * DAY, null, T + 3_600_000, null);
    return { db, installId, uninstallId, configId };
  }

  it('lists the install, the uninstall and the config change, not a draft or a builtin, and splits by time (SC1)', () => {
    const { db, installId, uninstallId, configId } = tmbFixture();
    const list = computeChangeImpact(db) as ChangeImpactList;
    assert.ok(list.sources.includes('tmb_events'));
    const tmb = list.changes.filter((c) => c.source === 'tmb_events');
    assert.deepEqual(
      tmb.map((c) => [c.id, c.kind, c.label, c.repo]).sort(),
      [
        [`audit-${configId}`, 'config', 'config changed: acme.flag', null],
        [`audit-${uninstallId}`, 'cheatcode_uninstall', 'cheatcode uninstalled: acme-old', null],
        [`cheatcode-${installId}`, 'cheatcode_install', 'cheatcode installed: acme-search', null],
      ].sort(),
    );
    const r = computeChangeImpact(db, undefined, { change: { source: 'tmb_events', id: `cheatcode-${installId}` } });
    assert.equal(r.at, iso(T));
    const m = r.metrics.find((x) => x.id === 'swe_rework_ratio')!;
    assert.ok(m.before.n >= 20 && m.after.n >= 20, `${m.before.n}/${m.after.n}`);
    assert.notEqual(m.p, null);
    assert.equal(m.verdict, 'improved');
    assert.deepEqual(r.measured_with.map((c) => c.id).sort(), [`audit-${configId}`, `audit-${uninstallId}`].sort());
  });

  it('names an uninstall from its summary, then cheatcode; skips bad JSON and a keyless config row', () => {
    const db = tempDB();
    const fromSummary = seedAudit(db, 'cheatcode_uninstalled', "Cheatcode uninstall: 'acme-legacy' (kind=skill)", '{}', T);
    const bare = seedAudit(db, 'cheatcode_uninstalled', 'Cheatcode uninstall', '{}', T);
    seedAudit(db, 'cheatcode_uninstalled', "Cheatcode uninstall: 'acme-bad'", 'not json', T);
    seedAudit(db, 'config_changed', 'Config changed', '{}', T);
    seedAudit(db, 'config_changed', 'Config changed: x', '[]', T);
    const list = computeChangeImpact(db, undefined, { source: 'tmb_events' }) as ChangeImpactList;
    assert.deepEqual(
      list.changes.map((c) => [c.id, c.label]).sort(),
      [
        [`audit-${bare}`, 'cheatcode uninstalled: cheatcode'],
        [`audit-${fromSummary}`, 'cheatcode uninstalled: acme-legacy'],
      ].sort(),
    );
  });

  it('a missing table yields no events, never an error', () => {
    const { db } = tmbFixture();
    const reader = {
      get: db.get.bind(db),
      all<T>(sql: string, params?: unknown[]): T[] {
        if (/FROM (cheatcodes|audit)\b/.test(sql)) throw new Error('no such table');
        return db.all<T>(sql, params);
      },
    };
    const list = computeChangeImpact(reader, providerContext(reader)) as ChangeImpactList;
    assert.ok(!list.sources.includes('tmb_events'));
    assert.equal(list.changes.filter((c) => c.source === 'tmb_events').length, 0);
  });

  it('agent_surface and tmb_events split one sample set identically at the same time', () => {
    const { db, surfaceSha } = acmeFixture(25);
    const surface = computeChangeImpact(db, undefined, { change: { source: 'agent_surface', id: surfaceSha.slice(0, 12) } });
    const id = seedCheatcode(db, 'acme-same-time', 'installed', Date.parse(surface.at));
    const tmb = computeChangeImpact(db, undefined, { change: { source: 'tmb_events', id: `cheatcode-${id}` } });
    const unseeded = (r: ChangeImpact) => r.metrics.map(({ ratio_ci: _ci, ...rest }) => rest);
    assert.deepEqual(unseeded(tmb), unseeded(surface));
  });
});

describe('change impact — sampleCounts', () => {
  it('counts every metric within the window', () => {
    const db = tempDB();
    const t = seedTask(db);
    seedRun(db, t, T0, devVersion(101), 100);
    seedRun(db, t, T0 + 1, devVersion(101), 200, { hookBlock: 5 });
    seedRun(db, null, T0, devVersion(101), 10, { agent: 'bro', session: 's1' });
    seedRun(db, t, T0, devVersion(101), 10, { agent: 'code-reviewer' });
    db.run("INSERT INTO validation_attempts (task_id, attempt_n, verdict, mcp_available, created_at) VALUES (?, 1, 'fail', 1, ?)", [t, iso(T0 + 2)]);
    db.run("INSERT INTO verification_runs (task_id, commit_sha, source, started_at, exit_code, budget_s) VALUES (?, 'abc1234', 'gate', ?, 0, 60)", [t, iso(T0 + 3)]);
    const counts = sampleCounts(db, 14, new Date(T0 + DAY));
    assert.deepEqual(Object.keys(counts), METRICS.map((m) => m.id));
    for (const [id, n] of Object.entries(counts)) assert.ok(n > 0, id);
    assert.equal(sampleCounts(db, 14, new Date(T0 + 30 * DAY)).swe_rework_ratio, 0);
  });
});

describe('change impact — change_impact tool (SC6)', () => {
  it('returns exactly computeChangeImpact for the same inputs, with stable CIs', async () => {
    const { db, surfaceSha } = acmeFixture(25);
    const tool = changeImpactTools(db).handlers['change_impact']!;
    for (const change of [
      { source: 'plugin_version' as const, id: '1.0.0' },
      { source: 'agent_surface' as const, id: surfaceSha.slice(0, 12) },
    ]) {
      const first = parse(await tool({ agent: 'bro', change }));
      const second = parse(await tool({ agent: 'bro', change }));
      assert.deepEqual(first, JSON.parse(JSON.stringify(computeChangeImpact(db, undefined, { change }))));
      assert.deepEqual(first, second);
      assert.ok(Array.isArray((first as ChangeImpact).metrics.find((m) => m.id === 'swe_rework_ratio')!.ratio_ci));
    }
    const listed = parse(await tool({ agent: 'bro', source: 'agent_surface' }));
    assert.deepEqual(listed, JSON.parse(JSON.stringify(computeChangeImpact(db, undefined, { source: 'agent_surface' }))));
  });

  it('takes an injected context', async () => {
    const { db } = acmeFixture(1);
    let calls = 0;
    const tool = changeImpactTools(db, (reader) => {
      calls++;
      return providerContext(reader, () => {
        throw new Error('no git');
      });
    }).handlers['change_impact']!;
    const res = parse(await tool({ agent: 'bro' })) as ChangeImpactList;
    assert.equal(calls, 1);
    assert.deepEqual(res.sources, ['plugin_version']);
  });

  it('an unknown ref or a malformed change returns isError', async () => {
    const tool = changeImpactTools(tempDB()).handlers['change_impact']!;
    const res = (await tool({ agent: 'bro', change: { source: 'agent_surface', id: 'deadbeef' } })) as { isError?: boolean };
    assert.equal(res.isError, true);
    assert.equal((parse(res) as { error: string }).error, 'unknown change agent_surface:deadbeef');
    assert.equal(((await tool({ agent: 'bro', change: 7 })) as { isError?: boolean }).isError, true);
  });

  it('the descriptions name no change number or project', () => {
    const def = changeImpactTools(tempDB()).definitions[0]!;
    const change = (def.inputSchema.properties as Record<string, { description?: string }>)['change']!;
    for (const text of [def.description!, change.description!]) assert.doesNotMatch(text, /GH \d|#\d|trustmybot/);
  });
});
