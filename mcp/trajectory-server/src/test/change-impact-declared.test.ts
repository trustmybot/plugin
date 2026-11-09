// Change impact declared metrics (GH 2600): a fragment's final `Metric: <id>
// lower|higher` line, joined in dev mode to the plugin_version change of the
// PR whose squash commit added it, read from git history so a fragment a later
// commit deleted still counts, with the outcome the measured verdict gives it.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDB } from './helpers.js';
import type { TrajectoryDB } from '../db.js';
import {
  computeChangeImpact,
  METRIC_LINE,
  METRICS,
  outcomeOf,
  parseDeclaredLog,
  type ChangeImpact,
  type ChangeImpactList,
} from '../change-impact/index.js';
import { insertAudit } from '../tools/audit.js';
import { changeImpactTools } from '../tools/change-impact.js';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const LIB = join(PLUGIN_ROOT, 'scripts/maintenance/lib/changelog-fragments.ts');

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Repo {
  dir: string;
  commit: (msg: string, at: number, files?: Record<string, string | null>) => void;
}

function tempRepo(branch: string): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'ci-declared-'));
  dirs.push(dir);
  const g = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env },
    });
  g(['init', '-q', '-b', branch]);
  const commit = (msg: string, at: number, files: Record<string, string | null> = {}) => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) {
        g(['rm', '-q', path]);
      } else {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
        g(['add', path]);
      }
    }
    g(['commit', '-q', '--allow-empty', '-m', msg], { GIT_AUTHOR_DATE: iso(at), GIT_COMMITTER_DATE: iso(at) });
  };
  return { dir, commit };
}

function seedTask(db: TrajectoryDB): number {
  const now = iso(T0);
  db.run("INSERT INTO issues (objective, description, status, created_at, updated_at) VALUES ('i', '', 'open', ?, ?)", [now, now]);
  const issueId = db.get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;
  db.run(
    "INSERT INTO tasks (issue_id, branch_id, title, description, status, commit_sha, completed_at, created_at, updated_at) VALUES (?, ?, 't', 'd', 'closed', 'abc1234', ?, ?, ?)",
    [issueId, `feat/t${issueId}`, now, now, now],
  );
  return db.get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;
}

function seedRun(db: TrajectoryDB, taskId: number, at: number, version: string, tokensIn: number): void {
  db.run('INSERT INTO agent_runs (task_id, agent_type, tokens_in, tokens_out, started_at, plugin_version) VALUES (?, ?, ?, 0, ?, ?)', [
    taskId,
    'swe',
    tokensIn,
    iso(at),
    version,
  ]);
}

/** 25 tasks a side, two runs each: the rework ratio falls, reworks per task stay at one. */
function seedSides(db: TrajectoryDB, beforeAt: number, beforeVersion: string, afterAt: number, afterVersion: string): void {
  for (let i = 0; i < 25; i++) {
    const before = seedTask(db);
    seedRun(db, before, beforeAt + i * 60_000, beforeVersion, 100);
    seedRun(db, before, beforeAt + i * 60_000 + 1000, beforeVersion, 200 + i);
    const after = seedTask(db);
    seedRun(db, after, afterAt + i * 60_000, afterVersion, 100);
    seedRun(db, after, afterAt + i * 60_000 + 1000, afterVersion, 50 + i);
  }
}

const fragment = (issue: number, metric?: string) =>
  `### Added\n- **Change** (GH ${issue}): a change.\n${metric === undefined ? '' : `\n${metric}\n`}`;

const dev = (pr: number) => `1.2.0-dev.1.gh${pr}`;

/**
 * PRs 100..105 a day apart on `trunk`. PR 102 adds three declared fragments and
 * a plain one, PR 103 adds only a plain one, PR 104 deletes 102's fragments.
 */
function devFixture(): TrajectoryDB {
  const r = tempRepo('trunk');
  r.commit('chore: start (#100)', T0, { 'changelog.d/README.md': '# changelog.d\n\nMetric: swe_rework_ratio higher\n' });
  r.commit('feat: one (#101)', T0 + DAY, { 'CLAUDE.md': 'rules\n' });
  r.commit('feat: two (#102)', T0 + 2 * DAY, {
    'changelog.d/2600-a.md': fragment(2600, 'Metric: swe_rework_ratio lower'),
    'changelog.d/2600-b.md': fragment(2600, 'Metric: tokens_per_task higher'),
    'changelog.d/2600-c.md': fragment(2600, 'Metric: reworks_per_task lower'),
    'changelog.d/2600-d.md': fragment(2600, 'Metric: hook_block_tokens_per_run lower'),
    'changelog.d/2600-e.md': fragment(2600),
    'docs/notes.md': fragment(2600, 'Metric: review_fail_rate lower'),
  });
  r.commit('feat: three (#103)', T0 + 3 * DAY, { 'changelog.d/2601-plain.md': fragment(2601) });
  r.commit('chore: release (#104)', T0 + 4 * DAY, {
    'changelog.d/2600-a.md': null,
    'changelog.d/2600-b.md': null,
    'changelog.d/2600-c.md': null,
    'changelog.d/2600-d.md': null,
    'changelog.d/2600-e.md': null,
  });
  r.commit('feat: five (#105)', T0 + 5 * DAY);
  const db = tempDB();
  db.run("INSERT INTO repos (name, path, target_branch) VALUES ('builds', ?, 'trunk')", [r.dir]);
  seedSides(db, T0 + DAY, dev(101), T0 + 4 * DAY, dev(104));
  return db;
}

describe('change impact — declared metrics', () => {
  it('a dev-mode change gets one declared entry per Metric line its PR added, each outcome from the verdict (SC3)', () => {
    const db = devFixture();
    const r = computeChangeImpact(db, undefined, { change: { source: 'plugin_version', id: '102' } });
    const verdict = (id: string) => r.metrics.find((m) => m.id === id)!.verdict;
    assert.equal(verdict('swe_rework_ratio'), 'improved');
    assert.equal(verdict('tokens_per_task'), 'improved');
    assert.equal(verdict('reworks_per_task'), 'no_change');
    assert.equal(verdict('hook_block_tokens_per_run'), 'not_enough_data');
    assert.ok(r.declared && r.declared.length > 0, 'declared is non-empty');
    assert.deepEqual(r.declared, [
      { metric: 'swe_rework_ratio', direction: 'lower', outcome: 'as_declared' },
      { metric: 'tokens_per_task', direction: 'higher', outcome: 'wrong_way' },
      { metric: 'reworks_per_task', direction: 'lower', outcome: 'not_moved' },
      { metric: 'hook_block_tokens_per_run', direction: 'lower', outcome: 'not_enough_data' },
    ]);
    assert.deepEqual(Object.keys(r), ['source', 'id', 'label', 'at', 'kind', 'repo', 'measured_with', 'metrics', 'declared']);
  });

  it('a metric filter still gives every declaration, judged on its own verdict', () => {
    const db = devFixture();
    const r = computeChangeImpact(db, undefined, { change: { source: 'plugin_version', id: '102' }, metric: 'reworks_per_task' });
    assert.deepEqual(r.metrics.map((m) => m.id), ['reworks_per_task']);
    assert.equal(r.declared?.length, 4);
    assert.equal(r.declared?.[0]?.outcome, 'as_declared');
  });

  it('a PR whose fragments declare nothing, a PR with no fragment, and a Metric line in README.md give no declared key', () => {
    const db = devFixture();
    const list = computeChangeImpact(db) as ChangeImpactList;
    const byId = new Map(list.changes.filter((c) => c.source === 'plugin_version').map((c) => [c.id, c]));
    assert.deepEqual([...byId.keys()].sort(), ['100', '101', '102', '103', '104', '105']);
    for (const id of ['100', '101', '103', '104', '105']) assert.ok(!('declared' in byId.get(id)!), `#${id}`);
    assert.equal(byId.get('102')!.declared?.length, 4);
  });

  it('agent_surface and tmb_events changes have no declared key', () => {
    const db = devFixture();
    insertAudit(db, { issue_id: -1, from_node: 'bro', event_type: 'config_changed', summary: 'config', content_json: JSON.stringify({ key: 'k' }), created_at: iso(T0 + 3 * DAY) });
    const list = computeChangeImpact(db, undefined, { limit: 100 }) as ChangeImpactList;
    const others = list.changes.filter((c) => c.source !== 'plugin_version');
    assert.deepEqual([...new Set(others.map((c) => c.source))].sort(), ['agent_surface', 'tmb_events']);
    for (const c of others) assert.ok(!('declared' in c), `${c.source}:${c.id}`);
  });

  it('user mode (release versions, no dev builds) has no declared key', () => {
    const r = tempRepo('trunk');
    r.commit('feat: two (#102)', T0, { 'changelog.d/2600-a.md': fragment(2600, 'Metric: swe_rework_ratio lower') });
    const db = tempDB();
    db.run("INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'trunk')", [r.dir]);
    seedSides(db, T0 + DAY, '0.9.0', T0 + 4 * DAY, '1.0.0');
    const c = computeChangeImpact(db, undefined, { change: { source: 'plugin_version', id: '1.0.0' } });
    assert.equal(c.kind, 'version');
    assert.ok(!('declared' in c));
  });

  it('the change_impact tool returns the same declared field', async () => {
    const db = devFixture();
    const res = await changeImpactTools(db).handlers['change_impact']!({ agent: 'bro', change: { source: 'plugin_version', id: '102' } });
    const body = JSON.parse((res.content[0] as { text: string }).text) as ChangeImpact;
    assert.deepEqual(body.declared, computeChangeImpact(db, undefined, { change: { source: 'plugin_version', id: '102' } }).declared);
  });

  it('outcomeOf maps each verdict and declared direction', () => {
    assert.equal(outcomeOf('lower', 'lower', 'improved'), 'as_declared');
    assert.equal(outcomeOf('higher', 'lower', 'regressed'), 'as_declared');
    assert.equal(outcomeOf('higher', 'higher', 'regressed'), 'wrong_way');
    assert.equal(outcomeOf('lower', 'higher', 'improved'), 'wrong_way');
    assert.equal(outcomeOf('lower', 'lower', 'no_change'), 'not_moved');
    assert.equal(outcomeOf('higher', 'lower', 'not_enough_data'), 'not_enough_data');
  });

  it('parseDeclaredLog reads only the last line, only registry ids, only (#N) subjects', () => {
    const patch = (path: string, body: string[]) =>
      [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${body.length} @@`, ...body.map((l) => `+${l}`)].join('\n');
    const log = [
      '',
      `feat: x (#7)\n\n${patch('changelog.d/7-a.md', ['### Added', '- **A** (GH 7): a.', 'Metric: unknown_metric lower'])}\n${patch('changelog.d/7-b.md', ['### Added', 'Metric: swe_rework_ratio lower', '- **B** (GH 7): b.'])}\n${patch('changelog.d/7-c.md', ['### Added', '- **C** (GH 7): c.', '', 'Metric: review_fail_rate higher', ''])}`,
      `chore: no pr number\n\n${patch('changelog.d/8-a.md', ['### Added', '- **A** (GH 8): a.', 'Metric: swe_rework_ratio lower'])}`,
    ].join('\x1e');
    assert.deepEqual([...parseDeclaredLog(log)], [[7, [{ metric: 'review_fail_rate', direction: 'higher' }]]]);
  });

  it('the fragment script keeps the registry ids and the line shape of the server', () => {
    const r = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        '--input-type=module',
        '-e',
        `import { METRIC_IDS, METRIC_LINE } from ${JSON.stringify(pathToFileURL(LIB).href)}; process.stdout.write(JSON.stringify({ ids: METRIC_IDS, line: METRIC_LINE.source }));`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr);
    const script = JSON.parse(r.stdout) as { ids: string[]; line: string };
    assert.deepEqual(script.ids, METRICS.map((m) => m.id));
    assert.equal(script.line, METRIC_LINE.source);
  });
});
