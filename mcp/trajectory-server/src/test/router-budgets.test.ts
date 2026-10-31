import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ROUTER_GROUPS, routerTimeoutS } from '../hooks/registry.js';
import { gateOf, percentile, transcriptStats } from './hook-transcripts.js';
import { budgetMs, floorMs, groupBudgetMs, PARSE_ALLOWANCE_MS, p99Term, PRE_ROUTER_TIMEOUT_S } from './router-floors.js';
import { PLUGIN_ROOT } from './router-sandboxes.js';

interface Budget {
  kind: string;
  bench_p99: unknown;
  bench_runs: unknown;
  bench_load_avg: unknown;
  transcript_p99: unknown;
  reason?: unknown;
  transcript_samples: unknown;
  transcript_timed_out: unknown;
  window_days: unknown;
  floor_ms: number;
  budget_ms: number;
  date: unknown;
}

const BUDGETS = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/hooks/router/budgets.json'), 'utf8')) as {
  rounds: number;
  workers: number;
  parse_allowance_ms: number;
  groups: Record<string, { max_budget_ms: number; p99_sum_ms: number; group_budget_ms: number }>;
  gates: Record<string, Budget>;
};
const HOOKS = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks/hooks.json'), 'utf8')) as {
  hooks: Record<string, { matcher: string; hooks: { command: string; timeout: number }[] }[]>;
};

describe('router budgets.json (GH 1861)', () => {
  const gates = [...new Map(ROUTER_GROUPS.flatMap((g) => g.gates).map((g) => [g.name, g])).values()];

  it('comes from a bench of at least 20 rounds on 4 workers', () => {
    assert.ok(BUDGETS.rounds >= 20, `rounds ${BUDGETS.rounds}`);
    assert.equal(BUDGETS.workers, 4);
  });

  it('holds exactly the router gates', () => {
    assert.deepEqual(Object.keys(BUDGETS.gates).sort(), gates.map((g) => g.name).sort());
  });

  for (const gate of gates) {
    it(`${gate.name}: floor is its pre-router timeout share, both p99 inputs present, budget from the formula`, () => {
      const b = BUDGETS.gates[gate.name];
      assert.equal(b.kind, gate.kind);
      assert.equal(b.floor_ms, floorMs(gate.name));
      if (gate.kind === 'enforcement') assert.ok(b.budget_ms >= b.floor_ms, `${b.budget_ms} >= ${b.floor_ms}`);
      assert.equal(typeof b.bench_p99, 'number');
      assert.ok((b.bench_runs as number) >= 20 * 4);
      assert.equal(typeof b.bench_load_avg, 'number');
      if (b.transcript_p99 === null) assert.ok(typeof b.reason === 'string' && b.reason !== '', 'a null transcript_p99 carries a reason');
      else assert.equal(typeof b.transcript_p99, 'number');
      for (const k of ['transcript_samples', 'transcript_timed_out', 'window_days'] as const) assert.equal(typeof b[k], 'number', k);
      assert.match(String(b.date), /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(b.budget_ms, budgetMs(b.floor_ms, b.bench_p99 as number, b.transcript_p99 as number | null));
      assert.equal(gate.budgetMs, b.budget_ms, 'ROUTER_GROUPS reads budgets.json');
    });
  }

  it('a floor matches the timeout of each registration the gate still has in hooks.json', () => {
    for (const groups of Object.values(HOOKS.hooks)) {
      for (const g of groups) {
        for (const h of g.hooks) {
          const gate = gateOf(h.command);
          if (gate !== null && gate in PRE_ROUTER_TIMEOUT_S) assert.equal(h.timeout, PRE_ROUTER_TIMEOUT_S[gate], `${gate} under ${g.matcher}`);
        }
      }
    }
  });

  it('holds exactly one entry per router group', () => {
    assert.deepEqual(Object.keys(BUDGETS.groups).sort(), ROUTER_GROUPS.map((g) => g.matcher).sort());
  });

  for (const group of ROUTER_GROUPS) {
    it(`${group.matcher}: group_budget_ms follows max(max_budget_ms, ceil(1.5 x p99_sum_ms)) over its own gates`, () => {
      const b = BUDGETS.groups[group.matcher];
      const members = group.gates.map((g) => BUDGETS.gates[g.name]);
      assert.equal(b.max_budget_ms, Math.max(...members.map((m) => m.budget_ms)));
      assert.equal(b.max_budget_ms, Math.max(...group.gates.map((g) => g.budgetMs)));
      const sum = members.reduce((n, m) => n + p99Term(m.bench_p99 as number, m.transcript_p99 as number | null), 0);
      assert.equal(b.p99_sum_ms, Math.round(sum * 10) / 10);
      assert.equal(b.group_budget_ms, groupBudgetMs(b.max_budget_ms, b.p99_sum_ms));
      assert.equal(group.groupBudgetMs, b.group_budget_ms, 'ROUTER_GROUPS reads budgets.json');
    });

    it(`${group.matcher}: its hooks.json timeout is routerTimeoutS(group), covering the parse allowance plus its group budget`, () => {
      const entries = HOOKS.hooks.PreToolUse.filter((g) => g.matcher === group.matcher);
      assert.equal(entries.length, 1);
      const { timeout, command } = entries[0].hooks[0];
      assert.ok(command.endsWith('dist/hooks.js" PreToolUse'));
      assert.ok(timeout * 1000 >= BUDGETS.parse_allowance_ms + group.groupBudgetMs, `${timeout} s`);
      assert.equal(timeout, routerTimeoutS(group));
      assert.equal(timeout, Math.ceil((BUDGETS.parse_allowance_ms + BUDGETS.groups[group.matcher].group_budget_ms) / 1000) + 1);
    });
  }

  it('swe-verification-gate keeps its chain-table budget as its floor', () => {
    assert.equal(BUDGETS.gates['swe-verification-gate'].floor_ms, 1_830_000);
  });

  it('the group formula and the parse allowance', () => {
    assert.equal(BUDGETS.parse_allowance_ms, PARSE_ALLOWANCE_MS);
    assert.equal(groupBudgetMs(16000, 100), 16000);
    assert.equal(groupBudgetMs(16000, 21492), 32238);
    assert.equal(groupBudgetMs(1000, 1000.1), 1501);
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
      const at = (days: number): string => new Date(now - days * 864e5).toISOString();
      const line = (type: string, gate: string, ms: number, extra: Record<string, unknown> = {}, ts = at(1)): string =>
        JSON.stringify({ timestamp: ts, attachment: { type, hookEvent: 'PreToolUse', command: `"/x/scripts/hooks/dispatch.sh" ${gate}`, durationMs: ms, ...extra } });
      mkdirSync(join(dir, 'proj/sub'), { recursive: true });
      writeFileSync(
        join(dir, 'proj/a.jsonl'),
        [
          line('hook_success', 'git-guards', 100),
          line('hook_blocking_error', 'git-guards', 300),
          line('hook_non_blocking_error', 'git-guards', 6000, { timedOut: true }),
          line('hook_cancelled', 'git-guards', 9999),
          line('hook_success', 'git-guards', 9999, {}, at(20)),
          JSON.stringify({ timestamp: at(1), attachment: { type: 'hook_success', hookEvent: 'PostToolUse', command: '"/x/dispatch.sh" git-guards', durationMs: 9999 } }),
          JSON.stringify({ timestamp: at(1), attachment: { type: 'hook_success', hookEvent: 'PreToolUse', command: 'node "/x/dist/hooks.js" PreToolUse', durationMs: 9999 } }),
          'not json',
        ].join('\n'),
      );
      writeFileSync(join(dir, 'proj/sub/b.jsonl'), line('hook_success', 'commit-msg-lint', 40));
      writeFileSync(join(dir, 'proj/old.jsonl'), line('hook_success', 'commit-msg-lint', 9999));
      const old = (now - 30 * 864e5) / 1000;
      utimesSync(join(dir, 'proj/old.jsonl'), old, old);
      const s = await transcriptStats(dir, 14, 'PreToolUse', now);
      assert.equal(s.files, 2);
      assert.deepEqual(s.gates.get('git-guards'), { ms: [100, 300, 6000], timedOut: 1 });
      assert.deepEqual(s.gates.get('commit-msg-lint'), { ms: [40], timedOut: 0 });
      assert.equal(s.gates.size, 2);
    } finally {
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
