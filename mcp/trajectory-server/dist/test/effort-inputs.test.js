// World-model effort inputs in shadow mode (GH 1904): effortInputs/effortTier
// on a seeded world model, the effort_inputs_recorded row task_provision and
// task_create_batch write without changing the task's effort, the read-only
// scripts/maintenance/effort-inputs.ts CLI and the effort-ab-report join.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempDB } from './helpers.js';
import { taskTools } from '../tools/tasks.js';
import { compositeTools } from '../tools/composites.js';
import { configTools } from '../tools/config.js';
import { effortAbArm } from '../effort-ab.js';
import { CALLER_SPREAD_HIGH, effortInputs, effortTier } from '../effort-inputs.js';
import { effortAbReport, formatEffortAbReport } from '../effort-ab-report.js';
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CLI = join(PLUGIN_ROOT, 'scripts', 'maintenance', 'effort-inputs.ts');
const REPO = 'app';
const call = async (handlers, name, args) => (await handlers[name](args));
const parse = (r) => JSON.parse(r.content[0].text);
function addSymbol(db, path, kind, name) {
    db.run(`INSERT INTO wm_symbols (repo, path, kind, qualified_name, start_line, end_line, body_hash) VALUES (?, ?, ?, ?, 1, 9, 'h')`, [REPO, path, kind, name]);
    return db.get('SELECT last_insert_rowid() AS id').id;
}
function addEdge(db, src, dst, kind) {
    db.run(`INSERT INTO wm_edges (src_id, dst_id, dst_name, kind, resolution, line) VALUES (?, ?, 'x', ?, 'exact', 1)`, [src, dst, kind]);
}
// doThing (src/x.ts) has callers in src/x.ts, lib/a.ts and lib/b.ts and a
// test; saveThing (src/y.ts) writes table things, read by lib/report.ts and a
// test; tidy (src/z.ts) has one caller in lib/a.ts.
function seedWorldModel(db) {
    const doThing = addSymbol(db, 'src/x.ts', 'function', 'doThing');
    addEdge(db, addSymbol(db, 'src/x.ts', 'function', 'localCaller'), doThing, 'calls');
    addEdge(db, addSymbol(db, 'lib/a.ts', 'function', 'aCaller'), doThing, 'calls');
    addEdge(db, addSymbol(db, 'lib/b.ts', 'function', 'bCaller'), doThing, 'calls');
    addEdge(db, addSymbol(db, 'src/test/x.test.ts', 'function', 'xTest'), doThing, 'calls');
    const saveThing = addSymbol(db, 'src/y.ts', 'function', 'saveThing');
    const things = addSymbol(db, 'src/schema.sql', 'sql_table', 'things');
    addEdge(db, saveThing, things, 'writes_table');
    addEdge(db, addSymbol(db, 'lib/report.ts', 'function', 'readThings'), things, 'reads_table');
    addEdge(db, addSymbol(db, 'src/test/y.test.ts', 'function', 'yTest'), things, 'reads_table');
    const tidy = addSymbol(db, 'src/z.ts', 'function', 'tidy');
    addEdge(db, addSymbol(db, 'lib/c.ts', 'function', 'cCaller'), tidy, 'calls');
}
const task = (spec, files, extra = {}) => ({
    spec_body: spec, files, prompt_bearing: false, rework: false, ...extra,
});
describe('effortInputs and effortTier (GH 1904)', () => {
    it('SC1: a one-file spec whose symbol has no caller outside files[] gives low', () => {
        const db = tempDB();
        try {
            seedWorldModel(db);
            const inputs = effortInputs(db, REPO, task('Edit `doThing`.', ['src/x.ts', 'lib/', 'src/test/']));
            assert.equal(inputs.files_in_scope, 3);
            assert.equal(effortTier(inputs).tier, 'medium', 'three files in scope is not low');
            const one = effortInputs(db, REPO, task('Edit `tidy`.', ['src/z.ts']));
            assert.equal(one.caller_files_outside_scope, 1);
            assert.equal(effortTier(one).tier, 'medium', 'one outside caller file is not low');
            const low = effortInputs(db, REPO, task('Edit `localCaller`.', ['src/x.ts']));
            assert.deepEqual(low, {
                files_in_scope: 1, symbols_named: 1, symbols_resolved: 1, direct_callers: 0, caller_files_outside_scope: 0,
                tables_written: 0, outside_table_readers: 0, tests_reached: 0,
                enforcement: false, prompt_bearing: false, rework: false, wm_available: true,
            });
            assert.equal(effortTier(low).tier, 'low');
        }
        finally {
            db.close();
        }
    });
    it('SC1: callers in CALLER_SPREAD_HIGH or more files outside files[] give high', () => {
        const db = tempDB();
        try {
            seedWorldModel(db);
            const inputs = effortInputs(db, REPO, task('Change `doThing()` in `src/x.ts`.', ['src/x.ts']));
            assert.equal(CALLER_SPREAD_HIGH, 2);
            assert.equal(inputs.symbols_resolved, 1);
            assert.equal(inputs.direct_callers, 3, 'non-test callers');
            assert.equal(inputs.caller_files_outside_scope, 2, 'lib/a.ts and lib/b.ts; src/x.ts is in scope, the test is not a caller');
            assert.equal(inputs.tests_reached, 1);
            const { tier, reason } = effortTier(inputs);
            assert.equal(tier, 'high');
            assert.match(reason, /callers in 2 files outside files\[\]/);
        }
        finally {
            db.close();
        }
    });
    it('SC1: a spec that writes a table read outside files[] gives high; in-scope or test readers do not', () => {
        const db = tempDB();
        try {
            seedWorldModel(db);
            const outside = effortInputs(db, REPO, task('Change `saveThing`.', ['src/y.ts']));
            assert.deepEqual([outside.tables_written, outside.outside_table_readers], [1, 1]);
            assert.equal(effortTier(outside).tier, 'high');
            const covered = effortInputs(db, REPO, task('Change `saveThing`.', ['src/y.ts', 'lib/report.ts']));
            assert.deepEqual([covered.tables_written, covered.outside_table_readers], [1, 0]);
            assert.equal(effortTier(covered).tier, 'medium', 'a table written keeps it off low');
        }
        finally {
            db.close();
        }
    });
    it('SC1: prompt_bearing, rework and enforcement (high_effort_paths) each give high', () => {
        const db = tempDB();
        try {
            seedWorldModel(db);
            const spec = 'Edit `localCaller`.';
            assert.equal(effortTier(effortInputs(db, REPO, task(spec, ['src/x.ts'], { prompt_bearing: true }))).reason, 'prompt_bearing');
            assert.equal(effortTier(effortInputs(db, REPO, task(spec, ['src/x.ts'], { rework: true }))).reason, 'rework');
            db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('high_effort_paths', '["src/"]')`);
            const enforced = effortInputs(db, REPO, task(spec, ['src/x.ts']));
            assert.equal(enforced.enforcement, true);
            assert.deepEqual(effortTier(enforced), { tier: 'high', reason: 'high_effort_paths' });
        }
        finally {
            db.close();
        }
    });
    it('SC1: everything else gives medium', () => {
        const db = tempDB();
        try {
            seedWorldModel(db);
            const inputs = effortInputs(db, REPO, task('Edit `tidy` and `unknownName`.', ['src/z.ts', 'src/w.ts']));
            assert.deepEqual([inputs.symbols_named, inputs.symbols_resolved, inputs.caller_files_outside_scope], [2, 1, 1]);
            assert.deepEqual(effortTier(inputs), { tier: 'medium', reason: 'default' });
        }
        finally {
            db.close();
        }
    });
    it('SC1: an empty world model or a failing lookup gives wm_available false and medium without throwing', () => {
        const db = tempDB();
        try {
            const empty = effortInputs(db, REPO, task('Edit `doThing`.', ['src/x.ts']));
            assert.equal(empty.wm_available, false);
            assert.deepEqual([empty.symbols_resolved, empty.direct_callers, empty.caller_files_outside_scope], [0, 0, 0]);
            assert.deepEqual(effortTier(empty), { tier: 'medium', reason: 'no_world_model' });
            assert.equal(effortInputs(db, null, task('Edit `doThing`.', ['src/x.ts'])).wm_available, false);
        }
        finally {
            db.close();
        }
        const broken = { get: () => { throw new Error('boom'); }, all: () => { throw new Error('boom'); } };
        const failed = effortInputs(broken, REPO, task('Edit `doThing`.', ['src/x.ts']));
        assert.equal(failed.wm_available, false);
        assert.equal(failed.files_in_scope, 0);
        assert.equal(effortTier(failed).tier, 'medium');
    });
});
const SPEC = ['## Description', 'Change `doThing` in `src/x.ts`.', '', '## Success Criteria', '- SC1: works'].join('\n');
const WAIVERS = {
    waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
    waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
    waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
    waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
};
function setup(opts) {
    const ws = mkdtempSync(join(tmpdir(), 'tmb-effort-inputs-'));
    const repoRoot = join(ws, 'app');
    mkdirSync(repoRoot, { recursive: true });
    const git = (...a) => execFileSync('git', ['-C', repoRoot, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'main')`, [repoRoot]);
    db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
          VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
    if (opts.seed)
        seedWorldModel(db);
    const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
    const tasks = taskTools(db);
    const config = configTools(db);
    const provision = async (branchId) => {
        const r = await call(composites.handlers, 'task_provision', {
            agent: 'bro', issue_id: 1, branch_id: branchId, decision_body: 'Chosen approach: effort inputs fixture.',
            task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app' },
        });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        return parse(r);
    };
    const batch = async (items) => {
        const r = await call(tasks.handlers, 'task_create_batch', {
            ...WAIVERS, agent: 'bro', issue_id: '1',
            tasks: items.map((t) => ({ description: 'd', spec_body: SPEC, files: ['src/x.ts'], repo: 'app', ...t })),
        });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        return parse(r).tasks;
    };
    const enableAb = async () => {
        const r = await call(config.handlers, 'config_set', { agent: 'bro', key: 'swe_effort_ab', value: { label: 't', target: 10 } });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
    };
    const recorded = () => db.all(`SELECT content_json, issue_id, from_node FROM audit WHERE event_type = 'effort_inputs_recorded' ORDER BY id`).map((r) => ({ ...JSON.parse(r.content_json), issue_id: r.issue_id, from_node: r.from_node }));
    const stored = (id) => db.get('SELECT effort FROM tasks WHERE id = ?', [id]).effort;
    return { db, provision, batch, enableAb, recorded, stored, cleanup: () => { db.close(); rmSync(ws, { recursive: true, force: true }); } };
}
describe('effort_inputs_recorded from task_provision and task_create_batch (GH 1904)', () => {
    it('SC2/SC3: one row per task, effort and effort_reason the same with a high suggestion as with none, A/B arm included', async () => {
        const outcomes = {};
        for (const seed of [false, true]) {
            const s = setup({ seed });
            try {
                await s.enableAb();
                const p1 = await s.provision('feat/ei-p1');
                const p2 = await s.provision('feat/ei-p2');
                const b = await s.batch([{ branch_id: 'feat/ei-b1' }, { branch_id: 'feat/ei-b2' }]);
                const created = [
                    { id: p1.task_id, effort: p1.effort, reason: p1.effort_reason },
                    { id: p2.task_id, effort: p2.effort, reason: p2.effort_reason },
                    ...b.map((t) => ({ id: t.id, effort: t.effort, reason: t.effort_reason })),
                ];
                for (const t of created) {
                    assert.equal(t.reason, 'ab_arm');
                    assert.equal(t.effort, effortAbArm(t.id));
                    assert.equal(s.stored(t.id), t.effort);
                }
                outcomes[String(seed)] = created.map((t) => [t.effort, t.reason]);
                const rows = s.recorded();
                assert.deepEqual(rows.map((r) => r.task_id), created.map((t) => t.id), 'one row per task');
                for (const [i, r] of rows.entries()) {
                    assert.equal(r.effort, created[i].effort, 'the row records the effort the task runs at');
                    assert.equal(r.issue_id, 1);
                    assert.equal(r.from_node, 'bro');
                    assert.equal(r.inputs.wm_available, seed);
                    assert.equal(r.suggested_tier, seed ? 'high' : 'medium');
                }
                for (const p of [p1, p2]) {
                    assert.ok(p.effort_inputs, 'task_provision returns effort_inputs');
                    assert.equal(p.effort_inputs.suggested_tier, seed ? 'high' : 'medium');
                    assert.equal(typeof p.effort_inputs.reason, 'string');
                }
            }
            finally {
                s.cleanup();
            }
        }
        assert.deepEqual(outcomes['true'], outcomes['false'], 'stored effort and reason do not depend on the row');
    });
});
describe('effort-inputs.ts CLI and the effort-ab-report join (GH 1904)', () => {
    it('SC4/SC5: prints one JSON line with a tier per task, writes nothing; the report shows suggested_tier per task', () => {
        const dir = mkdtempSync(join(tmpdir(), 'tmb-effort-inputs-cli-'));
        const dbPath = join(dir, 'copy.db');
        const db = tempDB({ path: dbPath });
        try {
            seedWorldModel(db);
            db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'main')`, [dir]);
            db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
              VALUES (7, 'o', 'd', 'open', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
            const insertTask = (id, spec, files) => db.run(`INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, title, description, status, spec_body, repo, files, effort, created_at, updated_at)
           VALUES (?, 7, ?, 'main', 't', 'd', 'closed', ?, 'app', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z')`, [id, `feat/c${id}`, spec, JSON.stringify(files), effortAbArm(id)]);
            insertTask(10, 'Change `doThing`.', ['src/x.ts']);
            insertTask(11, 'Edit `localCaller`.', ['src/x.ts']);
            for (const id of [10, 11]) {
                db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
           VALUES (7, ?, 'bro', 'effort_ab_enrolled', 's', ?, '2026-01-01T00:00:00.000Z')`, [`feat/c${id}`, JSON.stringify({ label: 'fx', arm: effortAbArm(id), task_id: id })]);
            }
            db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
         VALUES (7, 'feat/c10', 'bro', 'effort_inputs_recorded', 's', ?, '2026-01-01T00:00:00.000Z')`, [JSON.stringify({ task_id: 10, inputs: {}, suggested_tier: 'medium', reason: 'old', effort: 'high' })]);
            db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
         VALUES (7, 'feat/c10', 'bro', 'effort_inputs_recorded', 's', ?, '2026-01-01T00:00:01.000Z')`, [JSON.stringify({ task_id: 10, inputs: {}, suggested_tier: 'high', reason: 'newest', effort: 'high' })]);
            const report = effortAbReport(db, 'fx', new Date());
            const high = report.arms.find((a) => a.arm === 'high');
            const medium = report.arms.find((a) => a.arm === 'medium');
            assert.deepEqual(high.suggested_tiers, [{ task_id: 10, suggested_tier: 'high' }], 'the newest row wins');
            assert.deepEqual(medium.suggested_tiers, [{ task_id: 11, suggested_tier: null }], 'no row shows null');
            assert.deepEqual(high.suggested_tier_counts, { low: 0, medium: 0, high: 1, null: 0 });
            assert.deepEqual(medium.suggested_tier_counts, { low: 0, medium: 0, high: 0, null: 1 });
            const text = formatEffortAbReport(report);
            assert.match(text, /^ {2}suggested_tier\s+low=0 medium=0 high=1 null=0$/m);
            assert.match(text, /^\s+10:high$/m);
            assert.match(text, /^\s+11:null$/m);
        }
        finally {
            db.close();
        }
        const counts = () => {
            const ro = tempDB({ path: dbPath, seedScan: false });
            try {
                return ro.get('SELECT COUNT(*) AS n FROM audit').n;
            }
            finally {
                ro.close();
            }
        };
        try {
            const before = counts();
            const res = spawnSync(process.execPath, [CLI, '--db', dbPath, '--repo', REPO, '--tasks', '10,11,99'], { encoding: 'utf8' });
            assert.equal(res.status, 0, res.stderr);
            const lines = res.stdout.trim().split('\n').map((l) => JSON.parse(l));
            assert.deepEqual(lines.map((l) => [l.task_id, l.suggested_tier ?? l.error, l.effort ?? null]), [
                [10, 'high', 'high'],
                [11, 'low', 'medium'],
                [99, 'no such task', null],
            ]);
            assert.equal(lines[0].inputs.caller_files_outside_scope, 2);
            assert.equal(counts(), before, 'the CLI writes no audit row');
            const usage = spawnSync(process.execPath, [CLI, '--db', dbPath, '--tasks', 'x'], { encoding: 'utf8' });
            assert.equal(usage.status, 2);
            const missing = spawnSync(process.execPath, [CLI, '--db', join(dir, 'absent.db'), '--tasks', '1'], { encoding: 'utf8' });
            assert.equal(missing.status, 2);
            assert.match(missing.stderr, /no trajectory DB at/);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=effort-inputs.test.js.map