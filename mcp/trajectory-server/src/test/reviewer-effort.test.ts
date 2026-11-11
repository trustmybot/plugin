// Reviewer effort by risk tier (GH 1955): reviewerEffortTier's rule, and the
// reviewer_effort_assigned row review_handoff writes on every handoff under
// the reviewer_effort_tiers / reviewer_effort_ab config keys, and the model
// and effort reviewer_tier_settings gives each tier (GH 2932).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { tempDB } from './helpers.js';
import { compositeTools } from '../tools/composites.js';
import { configTools, REVIEWER_TIER_SETTINGS_KEY } from '../tools/config.js';
import { isDocsOrTestPath, reviewerEffortAbArm, reviewerEffortTier } from '../reviewer-effort.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

const call = async (handlers: Handlers, name: string, args: Record<string, unknown>): Promise<RawResult> =>
  (await handlers[name]!(args)) as RawResult;
const parse = (r: RawResult) => JSON.parse(r.content[0]!.text);

describe('reviewerEffortTier', () => {
  const tier = (changed: string[], opts: { prompt_bearing?: boolean; high?: string[] } = {}) =>
    reviewerEffortTier({ prompt_bearing: opts.prompt_bearing ?? false, changed, high_effort_paths: opts.high ?? [] });

  it('high for a prompt-bearing task, whatever the paths', () => {
    assert.deepEqual(tier(['README.md'], { prompt_bearing: true }), { effort: 'high', reason: 'prompt_bearing' });
    assert.deepEqual(tier([], { prompt_bearing: true }), { effort: 'high', reason: 'prompt_bearing' });
  });

  it('high for a changed path under a high_effort_paths prefix, docs and tests included', () => {
    assert.deepEqual(tier(['src/hooks/gate.ts'], { high: ['src/hooks/'] }), { effort: 'high', reason: 'high_effort_paths' });
    assert.deepEqual(tier(['src/hooks/README.md'], { high: ['src/hooks'] }), { effort: 'high', reason: 'high_effort_paths' });
    assert.deepEqual(tier(['src/hookshot.ts'], { high: ['src/hooks'] }), { effort: 'medium', reason: 'default' }, 'directory semantics');
  });

  it("SC4: a './'-prefixed changed path raises the tier against its prefix", () => {
    assert.deepEqual(tier(['./hooks/x.ts'], { high: ['hooks'] }), { effort: 'high', reason: 'high_effort_paths' });
  });

  it('low for docs-only, tests-only, or docs-plus-tests', () => {
    const low = { effort: 'low', reason: 'docs_tests' };
    assert.deepEqual(tier(['README.md', 'docs/guide.txt', 'a/docs/b/c.png']), low, 'docs');
    assert.deepEqual(tier(['src/test/a.test.ts', 'tests/x.sh', 'pkg/__tests__/y.js', 'src/a.spec.ts', 'test/z.ts']), low, 'tests');
    assert.deepEqual(tier(['CHANGELOG.md', 'src/test/a.test.ts']), low, 'docs plus tests');
  });

  it('medium for any other mix, or an empty list', () => {
    const medium = { effort: 'medium', reason: 'default' };
    assert.deepEqual(tier(['src/a.ts']), medium, 'code');
    assert.deepEqual(tier(['README.md', 'src/a.ts']), medium, 'docs plus code');
    assert.deepEqual(tier(['src/test/a.test.ts', 'src/a.ts']), medium, 'tests plus code');
    assert.deepEqual(tier([]), medium, 'empty');
  });

  it('docs and test paths are judged by segment and basename', () => {
    assert.equal(isDocsOrTestPath('docs'), false, 'a file named docs is not under docs/');
    assert.equal(isDocsOrTestPath('src/docsite/a.ts'), false, 'docsite is not docs');
    assert.equal(isDocsOrTestPath('src/testing/a.ts'), false, 'testing is not a test segment');
    assert.equal(isDocsOrTestPath('src/attest.ts'), false, 'attest.ts carries no .test.');
  });
});

describe('review_handoff assigns the reviewer effort (reviewer_effort_assigned)', () => {
  let ws: string;
  let repoRoot: string;
  let db: TrajectoryDB;
  let composites: ReturnType<typeof compositeTools>;
  let config: ReturnType<typeof configTools>;
  let baseSha: string;
  const NOW = '2026-11-05T12:00:00.000Z';
  const git = (...a: string[]) => execFileSync('git', ['-C', repoRoot, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

  before(() => {
    ws = mkdtempSync(join(tmpdir(), 'tmb-reviewer-effort-'));
    repoRoot = join(ws, 'app');
    mkdirSync(repoRoot, { recursive: true });
    git('init', '-q', '-b', 'dev');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    writeFileSync(join(repoRoot, 'seed.txt'), 'seed\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    baseSha = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/dev', baseSha);
    db = tempDB();
    db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'dev')`, [repoRoot]);
    db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'o', 'd', 'open', ?, ?)`, [NOW, NOW]);
    composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
    config = configTools(db);
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  const commitOn = (branch: string, paths: string[]): string => {
    git('checkout', '-q', '-b', branch, baseSha);
    for (const rel of paths) {
      mkdirSync(join(repoRoot, rel, '..'), { recursive: true });
      writeFileSync(join(repoRoot, rel), `${branch}\n`);
    }
    git('add', '.');
    git('commit', '-q', '-m', branch);
    return git('rev-parse', 'HEAD');
  };

  const setConfig = async (key: string, value: unknown) => {
    const r = await call(config.handlers, 'config_set', { agent: 'bro', key, value });
    assert.ok(!r.isError, JSON.stringify(parse(r)));
  };
  const clearConfig = () =>
    db.run(`DELETE FROM plugin_config WHERE key IN ('reviewer_effort', 'reviewer_effort_tiers', 'reviewer_effort_ab', 'high_effort_paths', 'reviewer_tier_settings')`);

  const handOff = async (id: number, paths: string[], opts: { prompt_bearing?: 0 | 1 } = {}) => {
    const branch = `feat/t${id}-${db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit`)!.n}`;
    const sha = commitOn(branch, paths);
    const exists = db.get<{ id: number }>('SELECT id FROM tasks WHERE id = ?', [id]);
    if (exists) {
      db.run(`UPDATE tasks SET status = 'completed', commit_sha = ?, files = ? WHERE id = ?`, [sha, JSON.stringify(paths), id]);
    } else {
      db.run(
        `INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, spec_body, repo, files, prompt_bearing, commit_sha, created_at, updated_at)
         VALUES (?, 1, ?, 'dev', 'd', 'completed', 's', 'app', ?, ?, ?, ?, ?)`,
        [id, `feat/t${id}`, JSON.stringify(paths), opts.prompt_bearing ?? 0, sha, NOW, NOW],
      );
    }
    const r = await call(composites.handlers, 'review_handoff', { agent: 'bro', task_id: String(id) });
    assert.ok(!r.isError, JSON.stringify(parse(r)));
    return { payload: parse(r) as { reviewer_effort: string }, sha };
  };

  const rowsOf = (id: number) =>
    db
      .all<{ content_json: string; from_node: string; issue_id: number }>(
        `SELECT content_json, from_node, issue_id FROM audit WHERE event_type = 'reviewer_effort_assigned'
          AND json_extract(content_json, '$.task_id') = ? ORDER BY id`,
        [id],
      )
      .map((r) => JSON.parse(r.content_json) as Record<string, unknown>);

  it('with both keys unset the effort is the config value, reason config, written right after review_handoff', async () => {
    clearConfig();
    const { payload, sha } = await handOff(1, ['src/a.ts'], { prompt_bearing: 1 });
    assert.equal(payload.reviewer_effort, 'medium', 'payload carries the config default');
    assert.deepEqual(rowsOf(1), [{ task_id: 1, commit_sha: sha, effort: 'medium', reason: 'config' }]);
    const order = db.all<{ event_type: string }>(
      `SELECT event_type FROM audit WHERE event_type IN ('review_handoff', 'reviewer_effort_assigned') ORDER BY id DESC LIMIT 2`,
    );
    assert.deepEqual(order.map((r) => r.event_type), ['reviewer_effort_assigned', 'review_handoff']);
    const between = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit WHERE id > (SELECT MAX(id) FROM audit WHERE event_type = 'review_handoff')
          AND id < (SELECT MAX(id) FROM audit WHERE event_type = 'reviewer_effort_assigned')`,
    )!.n;
    assert.equal(between, 0, 'no row between review_handoff and reviewer_effort_assigned');

    await setConfig('reviewer_effort', 'high');
    const second = await handOff(3, ['docs/a.md']);
    assert.equal(second.payload.reviewer_effort, 'high', 'a configured reviewer_effort, tiers off');
    assert.deepEqual(rowsOf(3).map((r) => [r['effort'], r['reason']]), [['high', 'config']]);
  });

  it('with reviewer_effort_tiers=true the effort is the tier', async () => {
    clearConfig();
    await setConfig('reviewer_effort_tiers', true);
    await setConfig('high_effort_paths', ['src/core/']);
    const cases: Array<[number, string[], 0 | 1, string, string]> = [
      [5, ['README.md', 'src/test/a.test.ts'], 0, 'low', 'docs_tests'],
      [7, ['src/a.ts'], 1, 'high', 'prompt_bearing'],
      [9, ['src/core/x.ts'], 0, 'high', 'high_effort_paths'],
      [11, ['src/a.ts', 'README.md'], 0, 'medium', 'default'],
    ];
    for (const [id, paths, pb, effort, reason] of cases) {
      const { payload } = await handOff(id, paths, { prompt_bearing: pb });
      assert.equal(payload.reviewer_effort, effort, `task ${id} payload`);
      const rows = rowsOf(id);
      assert.equal(rows.length, 1, `task ${id}: one row`);
      assert.deepEqual([rows[0]!['effort'], rows[0]!['reason'], rows[0]!['arm']], [effort, reason, undefined], `task ${id} row`);
    }
  });

  it('with reviewer_effort_ab set: even ids tiered, odd ids fixed, enrollment stops at target, a re-handoff keeps the arm', async () => {
    clearConfig();
    await setConfig('reviewer_effort_ab', { label: 'gh-1955', target: 2 });
    assert.equal(reviewerEffortAbArm(20), 'tiered');
    assert.equal(reviewerEffortAbArm(21), 'fixed');

    const even = await handOff(20, ['docs/guide.md']);
    assert.equal(even.payload.reviewer_effort, 'low', 'tiered arm: the docs tier');
    assert.deepEqual(rowsOf(20), [{ task_id: 20, commit_sha: even.sha, effort: 'low', reason: 'docs_tests', label: 'gh-1955', arm: 'tiered' }]);

    const odd = await handOff(21, ['docs/guide.md']);
    assert.equal(odd.payload.reviewer_effort, 'medium', 'fixed arm: the config effort');
    assert.deepEqual(rowsOf(21), [{ task_id: 21, commit_sha: odd.sha, effort: 'medium', reason: 'config', label: 'gh-1955', arm: 'fixed' }]);

    const late = await handOff(22, ['docs/guide.md']);
    assert.equal(late.payload.reviewer_effort, 'medium', 'target reached: not enrolled, tiers off -> config');
    assert.deepEqual(rowsOf(22).map((r) => [r['effort'], r['reason'], r['label'], r['arm']]), [['medium', 'config', undefined, undefined]]);

    await setConfig('reviewer_effort_tiers', true);
    const lateTiered = await handOff(24, ['docs/guide.md']);
    assert.equal(lateTiered.payload.reviewer_effort, 'low', 'not enrolled follows reviewer_effort_tiers');
    assert.equal(rowsOf(24)[0]!['arm'], undefined);

    const rework = await handOff(21, ['docs/guide.md', 'src/test/b.test.ts']);
    assert.equal(rework.payload.reviewer_effort, 'medium', 're-handoff keeps the fixed arm though tiers is on');
    const rows = rowsOf(21);
    assert.equal(rows.length, 2, 'one row per handoff');
    assert.deepEqual([rows[1]!['commit_sha'], rows[1]!['arm'], rows[1]!['label'], rows[1]!['reason']], [rework.sha, 'fixed', 'gh-1955', 'config']);

    const reworkEven = await handOff(20, ['src/a.ts']);
    assert.equal(reworkEven.payload.reviewer_effort, 'medium', 're-handoff keeps the tiered arm with the new tier');
    assert.deepEqual(rowsOf(20).map((r) => r['arm']), ['tiered', 'tiered']);
    const enrolled = db.get<{ n: number }>(
      `SELECT COUNT(DISTINCT json_extract(content_json, '$.task_id')) AS n FROM audit
        WHERE event_type = 'reviewer_effort_assigned' AND json_extract(content_json, '$.label') = 'gh-1955'`,
    )!.n;
    assert.equal(enrolled, 2, 'enrollment stopped at target');
  });

  it('SC1: reviewer_tier_settings gives the tier its model and effort; a reason with no entry keeps the plain tier', async () => {
    clearConfig();
    await setConfig('reviewer_effort_tiers', true);
    await setConfig('reviewer_tier_settings', { docs_tests: { model: 'sonnet', effort: 'high' }, default: { effort: 'low' } });

    const docs = await handOff(41, ['README.md', 'src/test/a.test.ts']);
    assert.equal(docs.payload.reviewer_effort, 'high', 'docs_tests effort from the setting');
    assert.deepEqual(rowsOf(41), [{ task_id: 41, commit_sha: docs.sha, effort: 'high', model: 'sonnet', reason: 'docs_tests' }]);
    const summary = db.get<{ summary: string }>(
      `SELECT summary FROM audit WHERE event_type = 'reviewer_effort_assigned' AND json_extract(content_json, '$.task_id') = 41`,
    )!.summary;
    assert.match(summary, /effort high, model sonnet \(docs_tests\)/);

    const prompt = await handOff(43, ['src/a.ts'], { prompt_bearing: 1 });
    assert.equal(prompt.payload.reviewer_effort, 'high');
    assert.deepEqual(rowsOf(43), [{ task_id: 43, commit_sha: prompt.sha, effort: 'high', reason: 'prompt_bearing' }], 'no entry: no model');

    const code = await handOff(45, ['src/a.ts']);
    assert.equal(code.payload.reviewer_effort, 'low', 'an effort-only entry overrides the effort');
    assert.deepEqual(rowsOf(45), [{ task_id: 45, commit_sha: code.sha, effort: 'low', reason: 'default' }], 'an effort-only entry adds no model');
  });

  it('SC1: the fixed/config path never carries a model', async () => {
    clearConfig();
    await setConfig('reviewer_tier_settings', { docs_tests: { model: 'sonnet', effort: 'high' } });
    const off = await handOff(51, ['docs/a.md']);
    assert.equal(off.payload.reviewer_effort, 'medium', 'tiers off: config effort');
    assert.deepEqual(rowsOf(51), [{ task_id: 51, commit_sha: off.sha, effort: 'medium', reason: 'config' }]);

    await setConfig('reviewer_effort_ab', { label: 'gh-2932', target: 2 });
    await handOff(53, ['docs/a.md']);
    assert.deepEqual(rowsOf(53).map((r) => [r['effort'], r['model'], r['reason'], r['arm']]), [['medium', undefined, 'config', 'fixed']]);
    await handOff(54, ['docs/a.md']);
    assert.deepEqual(rowsOf(54).map((r) => [r['effort'], r['model'], r['reason'], r['arm']]), [['high', 'sonnet', 'docs_tests', 'tiered']]);
  });

  it('SC3: an unset or malformed reviewer_tier_settings leaves every tier assignment as it was', async () => {
    for (const [i, raw] of [null, 'not json', '[1]', '{"docs_tests":{"model":"gpt-x"}}', '{"docs":{"model":"sonnet"}}', '{"docs_tests":{"effort":"max"}}'].entries()) {
      clearConfig();
      await setConfig('reviewer_effort_tiers', true);
      if (raw !== null) db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('reviewer_tier_settings', ?)`, [raw]);
      const id = 61 + 2 * i;
      const { payload, sha } = await handOff(id, ['docs/a.md']);
      assert.equal(payload.reviewer_effort, 'low', `${raw}: plain docs tier`);
      assert.deepEqual(rowsOf(id), [{ task_id: id, commit_sha: sha, effort: 'low', reason: 'docs_tests' }], `${raw}: row as before`);
    }
  });

  it('an unchecked scope (no git checkout) is the config effort even with tiers on', async () => {
    clearConfig();
    await setConfig('reviewer_effort_tiers', true);
    db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('nowhere', ?, 'dev')`, [join(ws, 'missing')]);
    db.run(
      `INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, spec_body, repo, files, commit_sha, created_at, updated_at)
       VALUES (31, 1, 'feat/t31', 'dev', 'd', 'completed', 's', 'nowhere', '["docs/a.md"]', 'abcdef1', ?, ?)`,
      [NOW, NOW],
    );
    const r = await call(composites.handlers, 'review_handoff', { agent: 'bro', task_id: '31' });
    assert.ok(!r.isError, JSON.stringify(parse(r)));
    assert.equal(parse(r).reviewer_effort, 'medium');
    assert.deepEqual(rowsOf(31).map((row) => [row['effort'], row['reason']]), [['medium', 'config']]);
  });

  it('SC1: an unchecked scope gets no model from reviewer_tier_settings', async () => {
    clearConfig();
    await setConfig('reviewer_effort_tiers', true);
    await setConfig('reviewer_tier_settings', { docs_tests: { model: 'sonnet', effort: 'high' }, default: { model: 'haiku' } });
    db.run(
      `INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, spec_body, repo, files, commit_sha, created_at, updated_at)
       VALUES (33, 1, 'feat/t33', 'dev', 'd', 'completed', 's', 'nowhere', '["docs/a.md"]', 'abcdef2', ?, ?)`,
      [NOW, NOW],
    );
    const r = await call(composites.handlers, 'review_handoff', { agent: 'bro', task_id: '33' });
    assert.ok(!r.isError, JSON.stringify(parse(r)));
    assert.deepEqual(rowsOf(33), [{ task_id: 33, commit_sha: 'abcdef2', effort: 'medium', reason: 'config' }]);
  });
});

describe('SC4: reviewer_tier_settings on a project that is not the plugin repo', () => {
  let ws: string;
  let repoRoot: string;
  let db: TrajectoryDB;
  let composites: ReturnType<typeof compositeTools>;
  let baseSha: string;
  const NOW = '2026-11-11T12:00:00.000Z';
  const git = (...a: string[]) => execFileSync('git', ['-C', repoRoot, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const write = (rel: string, text: string) => {
    mkdirSync(join(repoRoot, rel, '..'), { recursive: true });
    writeFileSync(join(repoRoot, rel), text);
  };

  before(() => {
    ws = mkdtempSync(join(tmpdir(), 'tmb-reviewer-tier-fixture-'));
    repoRoot = join(ws, 'parser');
    mkdirSync(repoRoot, { recursive: true });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    write('guide/intro.md', '# Parser\n');
    write('lib/parse.spec.ts', 'export {};\n');
    write('src/app.ts', 'export const app = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    baseSha = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', baseSha);
    db = tempDB();
    db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('parser', ?, 'main')`, [repoRoot]);
    db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'o', 'd', 'open', ?, ?)`, [NOW, NOW]);
    db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('reviewer_effort_tiers', 'true')`);
    db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('reviewer_tier_settings', '{"docs_tests":{"model":"sonnet","effort":"high"}}')`);
    composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  const handOff = async (id: number, files: Record<string, string>) => {
    const branch = `feat/p${id}`;
    git('checkout', '-q', '-b', branch, baseSha);
    for (const [rel, text] of Object.entries(files)) write(rel, text);
    git('add', '.');
    git('commit', '-q', '-m', branch);
    const sha = git('rev-parse', 'HEAD');
    db.run(
      `INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, spec_body, repo, files, commit_sha, worktree_path, created_at, updated_at)
       VALUES (?, 1, ?, 'main', 'd', 'completed', 's', 'parser', ?, ?, ?, ?, ?)`,
      [id, branch, JSON.stringify(Object.keys(files)), sha, repoRoot, NOW, NOW],
    );
    const r = await call(composites.handlers, 'review_handoff', { agent: 'bro', task_id: String(id), session_id: 'sess-2932' });
    assert.ok(!r.isError, JSON.stringify(parse(r)));
    const row = db.get<{ content_json: string }>(
      `SELECT content_json FROM audit WHERE event_type = 'reviewer_effort_assigned' AND json_extract(content_json, '$.task_id') = ?`,
      [id],
    )!;
    return { payload: parse(r) as { reviewer_effort: string; reviewer_spawn: Record<string, unknown> }, row: JSON.parse(row.content_json) as Record<string, unknown> };
  };

  it('a guide/ doc plus a lib/*.spec.ts change is docs_tests, reviewed by sonnet at high', async () => {
    const { payload, row } = await handOff(2, { 'guide/intro.md': '# Parser v2\n', 'lib/parse.spec.ts': 'export const t = 1;\n' });
    assert.deepEqual([row['effort'], row['model'], row['reason']], ['high', 'sonnet', 'docs_tests']);
    assert.equal(payload.reviewer_effort, 'high');
    assert.equal(payload.reviewer_spawn['model'], 'sonnet');
    assert.equal(payload.reviewer_spawn['effort'], 'high');
  });

  it('a src/ change is the default tier with no model', async () => {
    const { payload, row } = await handOff(4, { 'src/app.ts': 'export const app = 2;\n' });
    assert.deepEqual([row['effort'], row['model'], row['reason']], ['medium', undefined, 'default']);
    assert.ok(!('model' in payload.reviewer_spawn), JSON.stringify(payload.reviewer_spawn));
  });
});

describe('config_set: reviewer_effort_tiers and reviewer_effort_ab shapes', () => {
  it('accepts only a boolean tiers switch and a {label, target} A/B', async () => {
    const db = tempDB();
    try {
      const config = configTools(db);
      const set = async (key: string, value: unknown) => call(config.handlers, 'config_set', { agent: 'bro', key, value });
      for (const value of [true, false]) assert.ok(!(await set('reviewer_effort_tiers', value)).isError, `tiers ${value}`);
      for (const value of ['true', 1, {}, ['x']]) {
        const r = await set('reviewer_effort_tiers', value);
        assert.ok(r.isError && parse(r).error.includes('must be a boolean'), `tiers refuses ${JSON.stringify(value)}`);
      }
      assert.ok(!(await set('reviewer_effort_ab', { label: 'gh-1955', target: 20 })).isError, 'a valid A/B');
      for (const value of [{ label: '', target: 1 }, { label: 'x', target: 0 }, { label: 'x', target: 1.5 }, { label: 'x' }, 'x', [1]]) {
        const r = await set('reviewer_effort_ab', value);
        assert.ok(r.isError && parse(r).error.includes('typed_field_violation'), `A/B refuses ${JSON.stringify(value)}`);
      }
    } finally {
      db.close();
    }
  });

  it('reviewer_tier_settings takes known reasons with a known model and effort only', async () => {
    const db = tempDB();
    try {
      const config = configTools(db);
      const set = async (value: unknown) => call(config.handlers, 'config_set', { agent: 'bro', key: REVIEWER_TIER_SETTINGS_KEY, value });
      const valid = [
        {},
        { docs_tests: { model: 'sonnet', effort: 'high' } },
        { prompt_bearing: { model: 'opus' }, high_effort_paths: { effort: 'high' }, default: {}, docs_tests: { model: 'fable', effort: 'low' } },
        { default: { model: 'haiku', effort: 'medium' } },
      ];
      for (const value of valid) assert.ok(!(await set(value)).isError, `accepts ${JSON.stringify(value)}`);
      const invalid = [
        { docs: { model: 'sonnet' } },
        { config: { effort: 'high' } },
        { docs_tests: { model: 'gpt-5' } },
        { docs_tests: { effort: 'max' } },
        { docs_tests: { model: 'sonnet', temperature: 1 } },
        { docs_tests: 'sonnet' },
        { docs_tests: null },
        ['docs_tests'],
        'sonnet',
        true,
      ];
      for (const value of invalid) {
        const r = await set(value);
        assert.ok(r.isError && (parse(r) as { error: string }).error.includes('typed_field_violation'), `refuses ${JSON.stringify(value)}`);
      }
    } finally {
      db.close();
    }
  });
});
