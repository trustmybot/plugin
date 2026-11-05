// Reviewer effort by risk tier (GH 1955): reviewerEffortTier's rule, and the
// reviewer_effort_assigned row bro_atomic_close writes on every close under
// the reviewer_effort_tiers / reviewer_effort_ab config keys.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDB } from './helpers.js';
import { compositeTools } from '../tools/composites.js';
import { configTools } from '../tools/config.js';
import { isDocsOrTestPath, reviewerEffortAbArm, reviewerEffortTier } from '../reviewer-effort.js';
const call = async (handlers, name, args) => (await handlers[name](args));
const parse = (r) => JSON.parse(r.content[0].text);
describe('reviewerEffortTier', () => {
    const tier = (changed, opts = {}) => reviewerEffortTier({ prompt_bearing: opts.prompt_bearing ?? false, changed, high_effort_paths: opts.high ?? [] });
    it('high for a prompt-bearing task, whatever the paths', () => {
        assert.deepEqual(tier(['README.md'], { prompt_bearing: true }), { effort: 'high', reason: 'prompt_bearing' });
        assert.deepEqual(tier([], { prompt_bearing: true }), { effort: 'high', reason: 'prompt_bearing' });
    });
    it('high for a changed path under a high_effort_paths prefix, docs and tests included', () => {
        assert.deepEqual(tier(['src/hooks/gate.ts'], { high: ['src/hooks/'] }), { effort: 'high', reason: 'high_effort_paths' });
        assert.deepEqual(tier(['src/hooks/README.md'], { high: ['src/hooks'] }), { effort: 'high', reason: 'high_effort_paths' });
        assert.deepEqual(tier(['src/hookshot.ts'], { high: ['src/hooks'] }), { effort: 'medium', reason: 'default' }, 'directory semantics');
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
describe('bro_atomic_close assigns the reviewer effort (reviewer_effort_assigned)', () => {
    let ws;
    let repoRoot;
    let db;
    let composites;
    let config;
    let baseSha;
    const NOW = '2026-11-05T12:00:00.000Z';
    const git = (...a) => execFileSync('git', ['-C', repoRoot, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
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
    const commitOn = (branch, paths) => {
        git('checkout', '-q', '-b', branch, baseSha);
        for (const rel of paths) {
            mkdirSync(join(repoRoot, rel, '..'), { recursive: true });
            writeFileSync(join(repoRoot, rel), `${branch}\n`);
        }
        git('add', '.');
        git('commit', '-q', '-m', branch);
        return git('rev-parse', 'HEAD');
    };
    const setConfig = async (key, value) => {
        const r = await call(config.handlers, 'config_set', { agent: 'bro', key, value });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
    };
    const clearConfig = () => db.run(`DELETE FROM plugin_config WHERE key IN ('reviewer_effort', 'reviewer_effort_tiers', 'reviewer_effort_ab', 'high_effort_paths')`);
    const closeTask = async (id, paths, opts = {}) => {
        const branch = `feat/t${id}-${db.get(`SELECT COUNT(*) AS n FROM audit`).n}`;
        const sha = commitOn(branch, paths);
        const exists = db.get('SELECT id FROM tasks WHERE id = ?', [id]);
        if (exists) {
            db.run(`UPDATE tasks SET status = 'completed', commit_sha = ?, files = ? WHERE id = ?`, [sha, JSON.stringify(paths), id]);
        }
        else {
            db.run(`INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, spec_body, repo, files, prompt_bearing, commit_sha, created_at, updated_at)
         VALUES (?, 1, ?, 'dev', 'd', 'completed', 's', 'app', ?, ?, ?, ?, ?)`, [id, `feat/t${id}`, JSON.stringify(paths), opts.prompt_bearing ?? 0, sha, NOW, NOW]);
        }
        const r = await call(composites.handlers, 'bro_atomic_close', { agent: 'bro', task_id: String(id), commit_sha: sha, verification_summary: 'ok' });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        return { payload: parse(r), sha };
    };
    const rowsOf = (id) => db
        .all(`SELECT content_json, from_node, issue_id FROM audit WHERE event_type = 'reviewer_effort_assigned'
          AND json_extract(content_json, '$.task_id') = ? ORDER BY id`, [id])
        .map((r) => JSON.parse(r.content_json));
    it('with both keys unset the effort is the config value, reason config, written right after bro_verification_pass', async () => {
        clearConfig();
        const { payload, sha } = await closeTask(1, ['src/a.ts'], { prompt_bearing: 1 });
        assert.equal(payload.reviewer_effort, 'medium', 'payload carries the config default');
        assert.deepEqual(rowsOf(1), [{ task_id: 1, commit_sha: sha, effort: 'medium', reason: 'config' }]);
        const order = db.all(`SELECT event_type FROM audit WHERE event_type IN ('bro_verification_pass', 'reviewer_effort_assigned') ORDER BY id DESC LIMIT 2`);
        assert.deepEqual(order.map((r) => r.event_type), ['reviewer_effort_assigned', 'bro_verification_pass']);
        const between = db.get(`SELECT COUNT(*) AS n FROM audit WHERE id > (SELECT MAX(id) FROM audit WHERE event_type = 'bro_verification_pass')
          AND id < (SELECT MAX(id) FROM audit WHERE event_type = 'reviewer_effort_assigned')`).n;
        assert.equal(between, 0, 'no row between bro_verification_pass and reviewer_effort_assigned');
        await setConfig('reviewer_effort', 'high');
        const second = await closeTask(3, ['docs/a.md']);
        assert.equal(second.payload.reviewer_effort, 'high', 'a configured reviewer_effort, tiers off');
        assert.deepEqual(rowsOf(3).map((r) => [r['effort'], r['reason']]), [['high', 'config']]);
    });
    it('with reviewer_effort_tiers=true the effort is the tier', async () => {
        clearConfig();
        await setConfig('reviewer_effort_tiers', true);
        await setConfig('high_effort_paths', ['src/core/']);
        const cases = [
            [5, ['README.md', 'src/test/a.test.ts'], 0, 'low', 'docs_tests'],
            [7, ['src/a.ts'], 1, 'high', 'prompt_bearing'],
            [9, ['src/core/x.ts'], 0, 'high', 'high_effort_paths'],
            [11, ['src/a.ts', 'README.md'], 0, 'medium', 'default'],
        ];
        for (const [id, paths, pb, effort, reason] of cases) {
            const { payload } = await closeTask(id, paths, { prompt_bearing: pb });
            assert.equal(payload.reviewer_effort, effort, `task ${id} payload`);
            const rows = rowsOf(id);
            assert.equal(rows.length, 1, `task ${id}: one row`);
            assert.deepEqual([rows[0]['effort'], rows[0]['reason'], rows[0]['arm']], [effort, reason, undefined], `task ${id} row`);
        }
    });
    it('with reviewer_effort_ab set: even ids tiered, odd ids fixed, enrollment stops at target, a re-close keeps the arm', async () => {
        clearConfig();
        await setConfig('reviewer_effort_ab', { label: 'gh-1955', target: 2 });
        assert.equal(reviewerEffortAbArm(20), 'tiered');
        assert.equal(reviewerEffortAbArm(21), 'fixed');
        const even = await closeTask(20, ['docs/guide.md']);
        assert.equal(even.payload.reviewer_effort, 'low', 'tiered arm: the docs tier');
        assert.deepEqual(rowsOf(20), [{ task_id: 20, commit_sha: even.sha, effort: 'low', reason: 'docs_tests', label: 'gh-1955', arm: 'tiered' }]);
        const odd = await closeTask(21, ['docs/guide.md']);
        assert.equal(odd.payload.reviewer_effort, 'medium', 'fixed arm: the config effort');
        assert.deepEqual(rowsOf(21), [{ task_id: 21, commit_sha: odd.sha, effort: 'medium', reason: 'config', label: 'gh-1955', arm: 'fixed' }]);
        const late = await closeTask(22, ['docs/guide.md']);
        assert.equal(late.payload.reviewer_effort, 'medium', 'target reached: not enrolled, tiers off -> config');
        assert.deepEqual(rowsOf(22).map((r) => [r['effort'], r['reason'], r['label'], r['arm']]), [['medium', 'config', undefined, undefined]]);
        await setConfig('reviewer_effort_tiers', true);
        const lateTiered = await closeTask(24, ['docs/guide.md']);
        assert.equal(lateTiered.payload.reviewer_effort, 'low', 'not enrolled follows reviewer_effort_tiers');
        assert.equal(rowsOf(24)[0]['arm'], undefined);
        const rework = await closeTask(21, ['docs/guide.md', 'src/test/b.test.ts']);
        assert.equal(rework.payload.reviewer_effort, 'medium', 're-close keeps the fixed arm though tiers is on');
        const rows = rowsOf(21);
        assert.equal(rows.length, 2, 'one row per close');
        assert.deepEqual([rows[1]['commit_sha'], rows[1]['arm'], rows[1]['label'], rows[1]['reason']], [rework.sha, 'fixed', 'gh-1955', 'config']);
        const reworkEven = await closeTask(20, ['src/a.ts']);
        assert.equal(reworkEven.payload.reviewer_effort, 'medium', 're-close keeps the tiered arm with the new tier');
        assert.deepEqual(rowsOf(20).map((r) => r['arm']), ['tiered', 'tiered']);
        const enrolled = db.get(`SELECT COUNT(DISTINCT json_extract(content_json, '$.task_id')) AS n FROM audit
        WHERE event_type = 'reviewer_effort_assigned' AND json_extract(content_json, '$.label') = 'gh-1955'`).n;
        assert.equal(enrolled, 2, 'enrollment stopped at target');
    });
    it('an unchecked scope (waived, no git) is the config effort even with tiers on', async () => {
        clearConfig();
        await setConfig('reviewer_effort_tiers', true);
        db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('nowhere', ?, 'dev')`, [join(ws, 'missing')]);
        db.run(`INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, spec_body, repo, files, commit_sha, created_at, updated_at)
       VALUES (31, 1, 'feat/t31', 'dev', 'd', 'completed', 's', 'nowhere', '["docs/a.md"]', 'abcdef1', ?, ?)`, [NOW, NOW]);
        const r = await call(composites.handlers, 'bro_atomic_close', {
            agent: 'bro', task_id: '31', commit_sha: 'abcdef1', verification_summary: 'ok',
            waive_scope_gate: true, scope_waiver_reason: 'synthetic close outside a git checkout',
        });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        assert.equal(parse(r).reviewer_effort, 'medium');
        assert.deepEqual(rowsOf(31).map((row) => [row['effort'], row['reason']]), [['medium', 'config']]);
    });
});
describe('config_set: reviewer_effort_tiers and reviewer_effort_ab shapes', () => {
    it('accepts only a boolean tiers switch and a {label, target} A/B', async () => {
        const db = tempDB();
        try {
            const config = configTools(db);
            const set = async (key, value) => call(config.handlers, 'config_set', { agent: 'bro', key, value });
            for (const value of [true, false])
                assert.ok(!(await set('reviewer_effort_tiers', value)).isError, `tiers ${value}`);
            for (const value of ['true', 1, {}, ['x']]) {
                const r = await set('reviewer_effort_tiers', value);
                assert.ok(r.isError && parse(r).error.includes('must be a boolean'), `tiers refuses ${JSON.stringify(value)}`);
            }
            assert.ok(!(await set('reviewer_effort_ab', { label: 'gh-1955', target: 20 })).isError, 'a valid A/B');
            for (const value of [{ label: '', target: 1 }, { label: 'x', target: 0 }, { label: 'x', target: 1.5 }, { label: 'x' }, 'x', [1]]) {
                const r = await set('reviewer_effort_ab', value);
                assert.ok(r.isError && parse(r).error.includes('typed_field_violation'), `A/B refuses ${JSON.stringify(value)}`);
            }
        }
        finally {
            db.close();
        }
    });
});
//# sourceMappingURL=reviewer-effort.test.js.map