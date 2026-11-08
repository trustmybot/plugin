import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDB } from './helpers.js';
import type { TrajectoryDB } from '../db.js';
import {
  BuildHistory,
  computeChangeImpact,
  defaultGitSource,
  gitSourceAt,
  GitUnavailableError,
  METRICS,
  sampleCounts,
  type ChangeImpact,
  type GitCommit,
  type GitSource,
} from '../change-impact/index.js';
import { bootstrapRatioCi, holm, mannWhitneyU, median } from '../change-impact/stats.js';
import { changeImpactTools } from '../tools/change-impact.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function fakeGit(prs: number[], tags: Record<string, string> = {}): GitSource {
  const commits: GitCommit[] = prs.map((pr, i) => ({ sha: `sha${i}`, at: iso(T0 + i * DAY), subject: `✨ feat: change ${pr} (#${pr})` }));
  return { target: 'origin/dev', commits: () => commits, mergeBase: (ref) => tags[ref] ?? null };
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

/** <n> tasks a side: before on build gh101, after on gh104; change 102 merges at T0 + 2d. */
function seedRework(db: TrajectoryDB, n: number): void {
  for (let i = 0; i < n; i++) {
    const before = seedTask(db);
    seedRun(db, before, T0 + DAY + i * 60_000, devVersion(101), 100);
    seedRun(db, before, T0 + DAY + i * 60_000 + 1000, devVersion(101), 200 + i);
    const after = seedTask(db);
    seedRun(db, after, T0 + 4 * DAY + i * 60_000, devVersion(104), 100);
    seedRun(db, after, T0 + 4 * DAY + i * 60_000 + 1000, devVersion(104), 50 + i);
  }
}

function parse(result: unknown): unknown {
  return JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
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
  const h = new BuildHistory(fakeGit(PRS, { 'v1.1.0': 'sha3', 'v1.2.0-rc.1': 'sha4' }));

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
    const dir = mkdtempSync(join(tmpdir(), 'ci-git-'));
    try {
      const g = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
      g('init', '-q', '-b', 'dev');
      g('commit', '-q', '--allow-empty', '-m', 'first (#7)');
      g('tag', 'v1.0.0');
      g('commit', '-q', '--allow-empty', '-m', 'second (#8)');
      const src = gitSourceAt(dir, 'dev');
      assert.equal(src.target, 'dev');
      const hist = new BuildHistory(src);
      assert.equal(hist.indexOfPr(7), 0);
      assert.equal(hist.indexOfPr(8), 1);
      assert.deepEqual(hist.attribute('1.0.0', iso(T0)), { idx: 0, estimated: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('change impact — computeChangeImpact', () => {
  it('reports the result shape, an improved rework ratio and measured_with (SC5)', () => {
    const db = tempDB();
    seedRework(db, 25);
    const r = computeChangeImpact(db, fakeGit(PRS), { change: 102 }) as ChangeImpact;
    assert.deepEqual(Object.keys(r), ['change', 'merged_at', 'build_index', 'measured_with', 'metrics']);
    assert.equal(r.change, 102);
    assert.equal(r.build_index, 2);
    assert.equal(r.merged_at, iso(T0 + 2 * DAY));
    assert.deepEqual(r.measured_with, [103]);
    assert.deepEqual(r.metrics.map((m) => m.id), METRICS.map((m) => m.id));
    for (const m of r.metrics) {
      assert.deepEqual(Object.keys(m), [
        'id', 'label', 'unit', 'direction', 'before', 'after', 'ratio_of_medians', 'ratio_ci', 'p', 'p_holm', 'verdict',
      ]);
      assert.deepEqual(Object.keys(m.before), ['n', 'median', 'mean', 'estimated_n', 'unattributed_n']);
      assert.deepEqual(Object.keys(m.after), ['n', 'median', 'mean', 'estimated_n', 'unattributed_n']);
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
    const db = tempDB();
    seedRework(db, 19);
    const r = computeChangeImpact(db, fakeGit(PRS), { change: 102, metric: 'swe_rework_ratio' }) as ChangeImpact;
    assert.equal(r.metrics.length, 1);
    const m = r.metrics[0]!;
    assert.equal(m.before.n, 19);
    assert.equal(m.verdict, 'not_enough_data');
    assert.equal(m.p, null);
    assert.equal(m.p_holm, null);
    assert.equal(m.ratio_ci, null);
    assert.ok(m.ratio_of_medians !== null);
  });

  it('counts estimated and unattributed samples, skips unmeasured and swept_orphan runs', () => {
    const db = tempDB();
    seedRework(db, 20);
    const t = seedTask(db);
    seedRun(db, t, T0 + DAY / 2, null, 100);
    seedRun(db, t, T0 + DAY / 2 + 1, null, 300);
    seedRun(db, t, T0 + DAY / 2 + 2, devVersion(101), null);
    seedRun(db, t, T0 + DAY / 2 + 3, devVersion(101), 999, { exit: 'swept_orphan' });
    seedRun(db, t, T0 + DAY / 2 + 4, 'weird', 100);
    const r = computeChangeImpact(db, fakeGit(PRS), { change: 102, metric: 'swe_rework_ratio' }) as ChangeImpact;
    const m = r.metrics[0]!;
    assert.equal(m.before.n, 21);
    assert.equal(m.before.estimated_n, 1);
    assert.equal(m.before.unattributed_n, 1);
    assert.equal(m.after.unattributed_n, 0);
  });

  it('caps each side at max_samples nearest the merge and drops samples outside the window', () => {
    const db = tempDB();
    seedRework(db, 25);
    const t = seedTask(db);
    seedRun(db, t, T0 - 30 * DAY, devVersion(100), 100);
    seedRun(db, t, T0 - 30 * DAY + 1, devVersion(100), 100);
    seedRun(db, t, T0 + DAY, devVersion(100), 100);
    const capped = computeChangeImpact(db, fakeGit(PRS), { change: 102, metric: 'swe_rework_ratio', max_samples: 10, window_days: 3 }) as ChangeImpact;
    assert.equal(capped.metrics[0]!.before.n, 10);
    assert.equal(capped.metrics[0]!.after.n, 10);
    const windowed = computeChangeImpact(db, fakeGit(PRS), { change: 102, metric: 'swe_rework_ratio', window_days: 3 }) as ChangeImpact;
    assert.equal(windowed.metrics[0]!.before.n, 26);
    const wide = computeChangeImpact(db, fakeGit(PRS), { change: 102, metric: 'swe_rework_ratio', window_days: 40 }) as ChangeImpact;
    assert.equal(wide.metrics[0]!.before.n, 27);
  });

  it('without change lists the last limit merged PRs, newest first', () => {
    const db = tempDB();
    const r = computeChangeImpact(db, fakeGit(PRS), { limit: 2 }) as { changes: ChangeImpact[] };
    assert.deepEqual(r.changes.map((c) => c.change), [105, 104]);
  });

  it('an unknown change is an error', () => {
    assert.throws(() => computeChangeImpact(tempDB(), fakeGit(PRS), { change: 9 }), /change 9 is not a merged PR on origin\/dev/);
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

describe('change impact — change_impact tool', () => {
  it('returns exactly computeChangeImpact for the same inputs, with stable CIs (SC4)', async () => {
    const db = tempDB();
    seedRework(db, 25);
    const git = fakeGit(PRS);
    const tool = changeImpactTools(db, () => git).handlers['change_impact']!;
    const first = parse(await tool({ agent: 'bro', change: 102 }));
    const second = parse(await tool({ agent: 'bro', change: 102 }));
    assert.deepEqual(first, JSON.parse(JSON.stringify(computeChangeImpact(db, git, { change: 102 }))));
    assert.deepEqual(first, second);
    const ci = (first as ChangeImpact).metrics.find((m) => m.id === 'swe_rework_ratio')!.ratio_ci;
    assert.ok(Array.isArray(ci));
  });

  it('git unavailable returns plugin git history not available', async () => {
    const db = tempDB();
    assert.throws(() => defaultGitSource(db), (e: unknown) => e instanceof GitUnavailableError && /^plugin git history not available: /.test((e as Error).message));
    db.run("INSERT INTO repos (name, path, target_branch) VALUES ('plugin', ?, 'dev')", [join(tmpdir(), 'ci-no-such-repo')]);
    const res = (await changeImpactTools(db).handlers['change_impact']!({ agent: 'bro', change: 1 })) as { isError?: boolean };
    assert.equal(res.isError, true);
    assert.match((parse(res) as { error: string }).error, /^plugin git history not available: /);
  });
});
