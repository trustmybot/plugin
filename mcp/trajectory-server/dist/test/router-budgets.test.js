import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ROUTER_GROUPS, routerTimeoutS } from '../hooks/registry.js';
import { gateOf, percentile, transcriptStats } from './hook-transcripts.js';
import { budgetMs, floorMs, PARSE_ALLOWANCE_MS, PRE_R1_TIMEOUT_S } from './router-floors.js';
import { PLUGIN_ROOT } from './router-sandboxes.js';
const BUDGETS = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/hooks/router/budgets.json'), 'utf8'));
const HOOKS = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks/hooks.json'), 'utf8'));
describe('router budgets.json (GH 1861)', () => {
    const gates = ROUTER_GROUPS.flatMap((g) => g.gates);
    it('comes from a bench of at least 20 rounds on 4 workers', () => {
        assert.ok(BUDGETS.rounds >= 20, `rounds ${BUDGETS.rounds}`);
        assert.equal(BUDGETS.workers, 4);
    });
    it('holds exactly the router gates', () => {
        assert.deepEqual(Object.keys(BUDGETS.gates).sort(), gates.map((g) => g.name).sort());
    });
    for (const gate of gates) {
        it(`${gate.name}: floor is its pre-R1 timeout share, both p99 inputs present, budget from the formula`, () => {
            const b = BUDGETS.gates[gate.name];
            assert.equal(b.kind, gate.kind);
            assert.equal(b.floor_ms, floorMs(gate.name));
            if (gate.kind === 'enforcement')
                assert.ok(b.budget_ms >= b.floor_ms, `${b.budget_ms} >= ${b.floor_ms}`);
            assert.equal(typeof b.bench_p99, 'number');
            assert.ok(b.bench_runs >= 20 * 4);
            assert.equal(typeof b.bench_load_avg, 'number');
            if (b.transcript_p99 === null)
                assert.ok(typeof b.reason === 'string' && b.reason !== '', 'a null transcript_p99 carries a reason');
            else
                assert.equal(typeof b.transcript_p99, 'number');
            for (const k of ['transcript_samples', 'transcript_timed_out', 'window_days'])
                assert.equal(typeof b[k], 'number', k);
            assert.match(String(b.date), /^\d{4}-\d{2}-\d{2}$/);
            assert.equal(b.budget_ms, budgetMs(b.floor_ms, b.bench_p99, b.transcript_p99));
            assert.equal(gate.budgetMs, b.budget_ms, 'ROUTER_GROUPS reads budgets.json');
        });
    }
    it('a floor matches the timeout of each registration the gate still has in hooks.json', () => {
        for (const groups of Object.values(HOOKS.hooks)) {
            for (const g of groups) {
                for (const h of g.hooks) {
                    const gate = gateOf(h.command);
                    if (gate !== null && gate in PRE_R1_TIMEOUT_S)
                        assert.equal(h.timeout, PRE_R1_TIMEOUT_S[gate], `${gate} under ${g.matcher}`);
                }
            }
        }
    });
    it('budget_sum_ms is the sum of the per-gate budgets, parse_allowance_ms the recorded allowance', () => {
        assert.equal(BUDGETS.budget_sum_ms, Object.values(BUDGETS.gates).reduce((n, b) => n + b.budget_ms, 0));
        assert.equal(BUDGETS.budget_sum_ms, gates.reduce((n, g) => n + g.budgetMs, 0));
        assert.equal(BUDGETS.parse_allowance_ms, PARSE_ALLOWANCE_MS);
    });
    it('the router registration timeout covers the parse allowance plus every gate budget run in turn', () => {
        const entry = HOOKS.hooks.PreToolUse.flatMap((g) => g.hooks).find((h) => h.command.endsWith('dist/hooks.js" PreToolUse'));
        assert.ok(entry);
        assert.ok(entry.timeout * 1000 >= BUDGETS.parse_allowance_ms + BUDGETS.budget_sum_ms, `${entry.timeout} s < ${BUDGETS.parse_allowance_ms} + ${BUDGETS.budget_sum_ms} ms`);
        assert.equal(entry.timeout, routerTimeoutS());
        assert.equal(routerTimeoutS(), Math.ceil((BUDGETS.parse_allowance_ms + BUDGETS.budget_sum_ms) / 1000));
    });
    it('the formula: max(floor, ceil(2 x max(bench_p99, transcript_p99)) + 200)', () => {
        assert.equal(budgetMs(5000, 10, null), 5000);
        assert.equal(budgetMs(5000, 10, 3000.2), 6201);
        assert.equal(budgetMs(5000, 2900, 100), 6000);
    });
});
describe('transcript hook durations', () => {
    it('reads PreToolUse dispatch.sh gate attachments of the three hook result types within the window', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'tmb-transcripts-'));
        try {
            const now = Date.parse('2026-10-20T12:00:00Z');
            const at = (days) => new Date(now - days * 864e5).toISOString();
            const line = (type, gate, ms, extra = {}, ts = at(1)) => JSON.stringify({ timestamp: ts, attachment: { type, hookEvent: 'PreToolUse', command: `"/x/scripts/hooks/dispatch.sh" ${gate}`, durationMs: ms, ...extra } });
            mkdirSync(join(dir, 'proj/sub'), { recursive: true });
            writeFileSync(join(dir, 'proj/a.jsonl'), [
                line('hook_success', 'git-guards', 100),
                line('hook_blocking_error', 'git-guards', 300),
                line('hook_non_blocking_error', 'git-guards', 6000, { timedOut: true }),
                line('hook_cancelled', 'git-guards', 9999),
                line('hook_success', 'git-guards', 9999, {}, at(20)),
                JSON.stringify({ timestamp: at(1), attachment: { type: 'hook_success', hookEvent: 'PostToolUse', command: '"/x/dispatch.sh" git-guards', durationMs: 9999 } }),
                JSON.stringify({ timestamp: at(1), attachment: { type: 'hook_success', hookEvent: 'PreToolUse', command: 'node "/x/dist/hooks.js" PreToolUse', durationMs: 9999 } }),
                'not json',
            ].join('\n'));
            writeFileSync(join(dir, 'proj/sub/b.jsonl'), line('hook_success', 'commit-msg-lint', 40));
            writeFileSync(join(dir, 'proj/old.jsonl'), line('hook_success', 'commit-msg-lint', 9999));
            const old = (now - 30 * 864e5) / 1000;
            utimesSync(join(dir, 'proj/old.jsonl'), old, old);
            const s = await transcriptStats(dir, 14, 'PreToolUse', now);
            assert.equal(s.files, 2);
            assert.deepEqual(s.gates.get('git-guards'), { ms: [100, 300, 6000], timedOut: 1 });
            assert.deepEqual(s.gates.get('commit-msg-lint'), { ms: [40], timedOut: 0 });
            assert.equal(s.gates.size, 2);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('percentile is the reference parser one: sorted[min(n - 1, floor(p n))]', () => {
        assert.equal(percentile([], 0.99), null);
        assert.equal(percentile([5, 1, 3], 0.5), 3);
        assert.equal(percentile([5, 1, 3], 0.99), 5);
        assert.equal(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 0.99), 100);
    });
});
//# sourceMappingURL=router-budgets.test.js.map