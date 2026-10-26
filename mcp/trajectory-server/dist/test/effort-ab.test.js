// The opt-in swe effort A/B (GH 1745): plugin_config.swe_effort_ab enrolls
// eligible new tasks from task_provision and task_create_batch at their id's
// parity arm, up to the label's target, and scripts/maintenance/effort-ab-report.ts
// reports the arms from a DB opened read-only.
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
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const REPORT = join(PLUGIN_ROOT, 'scripts', 'maintenance', 'effort-ab-report.ts');
const call = async (handlers, name, args) => (await handlers[name](args));
const parse = (r) => JSON.parse(r.content[0].text);
const SPEC = ['## Description', 'do the thing', '', '## Success Criteria', '- SC1: works'].join('\n');
const WAIVERS = {
    waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
    waive_branch_gate: true, waive_branch_gate_reason: 'unit-test synthetic branch gate; not under test',
    waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test',
    waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic decision; not under test',
};
function setup() {
    const ws = mkdtempSync(join(tmpdir(), 'tmb-effort-ab-'));
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
    const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
    const config = configTools(db);
    const tasks = taskTools(db);
    const provision = async (branchId, extra = {}) => {
        const r = await call(composites.handlers, 'task_provision', {
            agent: 'bro', issue_id: 1, branch_id: branchId, decision_body: 'Chosen approach: effort A/B fixture.',
            task: { description: 'd', spec_body: SPEC, files: ['src/x.ts'], verification: ['true'], repo: 'app', ...extra },
        });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        return parse(r);
    };
    const batch = async (items) => {
        const r = await call(tasks.handlers, 'task_create_batch', {
            ...WAIVERS, agent: 'bro', issue_id: '1',
            tasks: items.map((t) => ({ description: 'd', ...t })),
        });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
        return parse(r).tasks;
    };
    const enable = async (value) => {
        const r = await call(config.handlers, 'config_set', { agent: 'bro', key: 'swe_effort_ab', value });
        assert.ok(!r.isError, JSON.stringify(parse(r)));
    };
    const enrolled = () => db.all(`SELECT content_json, from_node, issue_id FROM audit WHERE event_type = 'effort_ab_enrolled' ORDER BY id`).map((r) => ({ ...JSON.parse(r.content_json), from_node: r.from_node, issue_id: r.issue_id }));
    const effortOf = (id) => db.get('SELECT effort FROM tasks WHERE id = ?', [id]).effort;
    return {
        db, composites, config, provision, batch, enable, enrolled, effortOf,
        cleanup: () => { db.close(); rmSync(ws, { recursive: true, force: true }); },
    };
}
describe('swe effort A/B enrollment (GH 1745)', () => {
    it('SC1: with swe_effort_ab unset or malformed, task_provision and task_create_batch keep the computed effort and reason', async () => {
        const s = setup();
        try {
            const p = await s.provision('feat/ab-off');
            assert.deepEqual([p.effort, p.effort_reason], ['medium', 'default']);
            const b = await s.batch([{ branch_id: 'feat/ab-off-b1' }, { branch_id: 'feat/ab-off-b2', effort: 'medium' }]);
            assert.deepEqual(b.map((t) => [t.effort, t.effort_reason]), [['medium', 'default'], ['medium', 'explicit']]);
            s.db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('swe_effort_ab', '{"label":"t","target":0}')`);
            const malformed = await s.provision('feat/ab-malformed');
            assert.deepEqual([malformed.effort, malformed.effort_reason], ['medium', 'default']);
            s.db.run(`UPDATE plugin_config SET value_json = 'not json' WHERE key = 'swe_effort_ab'`);
            const unparseable = await s.batch([{ branch_id: 'feat/ab-unparseable' }]);
            assert.deepEqual([unparseable[0].effort, unparseable[0].effort_reason], ['medium', 'default']);
            assert.equal(s.enrolled().length, 0);
        }
        finally {
            s.cleanup();
        }
    });
    it('SC2: task_provision enrolls eligible tasks at the parity arm up to target; the third is not enrolled', async () => {
        const s = setup();
        try {
            await s.enable({ label: 't', target: 2 });
            const first = await s.provision('feat/ab-p1');
            const second = await s.provision('feat/ab-p2', { effort: 'medium' });
            const third = await s.provision('feat/ab-p3');
            for (const t of [first, second]) {
                const arm = t.task_id % 2 === 0 ? 'high' : 'medium';
                assert.deepEqual([t.effort, t.effort_reason], [arm, 'ab_arm']);
                assert.equal(s.effortOf(t.task_id), arm, 'tasks.effort holds the arm the spawn gate checks');
            }
            assert.notEqual(first.effort, second.effort, 'consecutive ids land in both arms');
            assert.deepEqual([third.effort, third.effort_reason], ['medium', 'default']);
            assert.deepEqual(s.enrolled(), [
                { label: 't', arm: effortAbArm(first.task_id), task_id: first.task_id, from_node: 'bro', issue_id: 1 },
                { label: 't', arm: effortAbArm(second.task_id), task_id: second.task_id, from_node: 'bro', issue_id: 1 },
            ]);
        }
        finally {
            s.cleanup();
        }
    });
    it('SC2: task_create_batch enrolls the same way, counting rows per label', async () => {
        const s = setup();
        try {
            await s.enable({ label: 't', target: 2 });
            const created = await s.batch([{ branch_id: 'feat/ab-b1' }, { branch_id: 'feat/ab-b2' }, { branch_id: 'feat/ab-b3' }]);
            assert.deepEqual(created.map((t) => [t.effort, t.effort_reason]), [[effortAbArm(created[0].id), 'ab_arm'], [effortAbArm(created[1].id), 'ab_arm'], ['medium', 'default']]);
            for (const t of created)
                assert.equal(s.effortOf(t.id), t.effort);
            assert.equal(s.enrolled().length, 2);
            await s.enable({ label: 'second-run', target: 1 });
            const next = await s.batch([{ branch_id: 'feat/ab-b4' }]);
            assert.equal(next[0].effort_reason, 'ab_arm', 'a new label starts its own count');
            assert.equal(s.enrolled().length, 3);
        }
        finally {
            s.cleanup();
        }
    });
    it('SC3: explicit high or low, prompt_bearing, high_effort_paths, task_reopen and task_retry are never enrolled', async () => {
        const s = setup();
        try {
            const reworked = await s.provision('fix/ab-rework');
            await s.enable({ label: 't', target: 10 });
            const r = await call(s.config.handlers, 'config_set', { agent: 'bro', key: 'high_effort_paths', value: ['hot/'] });
            assert.ok(!r.isError);
            assert.deepEqual([(await s.provision('feat/ab-high', { effort: 'high' })).effort_reason], ['explicit']);
            assert.deepEqual([(await s.provision('feat/ab-low', { effort: 'low' })).effort], ['low']);
            assert.equal((await s.provision('feat/ab-bearing', { prompt_bearing: 1 })).effort_reason, 'prompt_bearing');
            assert.equal((await s.provision('feat/ab-hot', { files: ['hot/x.ts'] })).effort_reason, 'high_effort_paths');
            const b = await s.batch([
                { branch_id: 'feat/ab-bh', effort: 'high' },
                { branch_id: 'feat/ab-bb', prompt_bearing: 1 },
                { branch_id: 'feat/ab-bp', files: ['hot/y.ts'] },
            ]);
            assert.deepEqual(b.map((t) => t.effort_reason), ['explicit', 'prompt_bearing', 'high_effort_paths']);
            s.db.run(`UPDATE tasks SET status = 'closed' WHERE id = ?`, [reworked.task_id]);
            const reopen = await call(s.composites.handlers, 'task_reopen', { agent: 'bro', task_id: reworked.task_id, reason: 'review failed' });
            assert.ok(!reopen.isError, JSON.stringify(parse(reopen)));
            assert.equal(s.effortOf(reworked.task_id), 'high');
            s.db.run(`UPDATE tasks SET status = 'failed' WHERE id = ?`, [reworked.task_id]);
            const retry = await call(s.composites.handlers, 'task_retry', {
                agent: 'bro', failed_task_id: String(reworked.task_id), new_branch_id: 'fix/ab-rework-v2', corrected_spec_body: SPEC,
                retry_rationale: 'rework', description: 'd', effort: 'medium',
            });
            assert.ok(!retry.isError, JSON.stringify(parse(retry)));
            assert.equal(s.effortOf(parse(retry).task_id), 'medium');
            assert.equal(s.enrolled().length, 0);
        }
        finally {
            s.cleanup();
        }
    });
    it('config_set refuses a malformed swe_effort_ab and accepts {label, target}', async () => {
        const s = setup();
        try {
            for (const value of ['on', [], { label: 't' }, { label: '', target: 2 }, { label: 't', target: 0 }, { label: 't', target: 1.5 }]) {
                const bad = await call(s.config.handlers, 'config_set', { agent: 'bro', key: 'swe_effort_ab', value });
                assert.equal(bad.isError, true, JSON.stringify(value));
                assert.match(String(parse(bad).error), /^typed_field_violation: config key "swe_effort_ab" must be an object/);
            }
            await s.enable({ label: 'gh-1745', target: 20 });
        }
        finally {
            s.cleanup();
        }
    });
});
describe('effort-ab-report.ts (GH 1745)', () => {
    it('SC4: prints both arms with all five metrics from a fixture DB, read-only', () => {
        const dir = mkdtempSync(join(tmpdir(), 'tmb-effort-ab-report-'));
        const dbPath = join(dir, 'fixture.db');
        const db = tempDB({ path: dbPath });
        try {
            db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
              VALUES (7, 'o', 'd', 'open', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
            const task = (id, closedAt) => db.run(`INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, title, description, status, effort, created_at, updated_at)
           VALUES (?, 7, ?, 'main', 't', 'd', 'closed', ?, '2026-01-01T00:00:00.000Z', ?)`, [id, `feat/r${id}`, effortAbArm(id), closedAt]);
            task(10, '2026-01-01T01:00:00.000Z');
            task(12, '2026-01-01T03:00:00.000Z');
            task(11, '2026-01-01T02:00:00.000Z');
            for (const id of [10, 11, 12]) {
                db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
           VALUES (7, ?, 'bro', 'effort_ab_enrolled', 's', ?, '2026-01-01T00:00:00.000Z')`, [`feat/r${id}`, JSON.stringify({ label: 'fx', arm: effortAbArm(id), task_id: id })]);
            }
            const run = (taskId, tools, cacheRead) => db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, tool_uses, cache_read_tokens, duration_ms, completed_at)
           VALUES (?, 7, 'swe', ?, ?, 1000, '2026-01-01T00:30:00.000Z')`, [taskId, tools, cacheRead]);
            run(10, 40, 1000);
            run(10, 20, 500);
            run(12, 10, 300);
            run(11, 7, 70);
            db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, tool_uses, cache_read_tokens, duration_ms) VALUES (10, 7, 'code-reviewer', 999, 999, 1)`);
            db.run(`INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, created_at) VALUES (10, 1, 'code-reviewer', 'fail', 1, '2026-01-01T00:40:00.000Z')`);
            db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
              VALUES (7, NULL, 'hook:close-issue-on-merge', 'issue_auto_closed_on_merge', 's', '{"gh_iid":1}', '2026-01-01T04:00:00.000Z')`);
        }
        finally {
            db.close();
        }
        try {
            const res = spawnSync(process.execPath, [REPORT, '--db', dbPath, '--label', 'fx'], { encoding: 'utf8' });
            assert.equal(res.status, 0, res.stderr);
            const out = res.stdout;
            assert.match(out, /^effort A\/B 'fx'$/m);
            assert.match(out, /^arm high: 2 task\(s\) \[10, 12\]$/m);
            assert.match(out, /^arm medium: 1 task\(s\) \[11\]$/m);
            const high = out.slice(out.indexOf('arm high'), out.indexOf('arm medium'));
            const medium = out.slice(out.indexOf('arm medium'));
            const metric = (block, name) => {
                const m = new RegExp(`^  ${name}\\s+median\\s+(\\S+)\\s+mean\\s+(\\S+)\\s+n=(\\d+)$`, 'm').exec(block);
                assert.ok(m, `${name} line in:\n${block}`);
                return [m[1], m[2], m[3]];
            };
            assert.deepEqual(metric(high, 'wall_clock_ms'), ['7200000', '7200000', '2']);
            assert.deepEqual(metric(high, 'tool_uses'), ['35', '35', '2']);
            assert.deepEqual(metric(high, 'cache_read_tokens'), ['900', '900', '2']);
            assert.deepEqual(metric(high, 'review_fail_count'), ['0.5', '0.5', '2']);
            assert.deepEqual(metric(high, 'time_to_merge_ms'), ['14400000', '14400000', '2']);
            assert.deepEqual(metric(medium, 'wall_clock_ms'), ['7200000', '7200000', '1']);
            assert.deepEqual(metric(medium, 'tool_uses'), ['7', '7', '1']);
            assert.deepEqual(metric(medium, 'cache_read_tokens'), ['70', '70', '1']);
            assert.deepEqual(metric(medium, 'review_fail_count'), ['0', '0', '1']);
            assert.deepEqual(metric(medium, 'time_to_merge_ms'), ['14400000', '14400000', '1']);
            const missing = spawnSync(process.execPath, [REPORT, '--db', join(dir, 'absent.db'), '--label', 'fx'], { encoding: 'utf8' });
            assert.equal(missing.status, 2);
            assert.match(missing.stderr, /no trajectory DB at/);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=effort-ab.test.js.map