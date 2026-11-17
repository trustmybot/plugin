// hot-path.bench --baseline (GH 3232): a hook p50 or cheap_during_gh_ms worse by more than max(20%, 15 ms) regresses.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type BenchResult, compareToBaseline, formatComparison, parseBenchResult } from './hot-path-compare.js';

function result(p50: Record<string, number>, cheapDuringGh: number): BenchResult {
  const hooks: BenchResult['hooks'] = {};
  for (const [name, v] of Object.entries(p50)) hooks[name] = { procs: 1, p50: v, p95: v * 1.5, max: v * 2 };
  return { hooks, mcp: { cheap_alone_ms: 2, cheap_during_gh_ms: cheapDuringGh, gh_call_ms: 1010 }, env: { node: 'v22.16.0', load: 1, rounds: 10 } };
}

const BASE = result({ 'PreToolUse Bash': 100, SessionStart: 400 }, 1000);

describe('compareToBaseline', () => {
  it('flags a hook p50 beyond 20% of a large baseline', () => {
    const c = compareToBaseline(BASE, result({ 'PreToolUse Bash': 100, SessionStart: 481 }, 1000));
    assert.equal(c.regressed, true);
    assert.deepEqual(c.rows.filter((r) => r.regressed).map((r) => r.metric), ['hooks.SessionStart.p50']);
  });

  it('flags a hook p50 beyond the 15 ms floor of a small baseline', () => {
    const c = compareToBaseline(result({ 'PreToolUse Read': 40 }, 1000), result({ 'PreToolUse Read': 56 }, 1000));
    assert.equal(c.regressed, true);
  });

  it('flags cheap_during_gh_ms beyond 20%', () => {
    const c = compareToBaseline(BASE, result({ 'PreToolUse Bash': 100, SessionStart: 400 }, 1201));
    assert.deepEqual(c.rows.filter((r) => r.regressed).map((r) => r.metric), ['mcp.cheap_during_gh_ms']);
  });

  it('passes an improvement', () => {
    const c = compareToBaseline(BASE, result({ 'PreToolUse Bash': 40, SessionStart: 120 }, 5));
    assert.equal(c.regressed, false);
    assert.ok(c.rows.every((r) => r.delta < 0));
  });

  it('passes a slowdown within noise: 20% of a large baseline, 15 ms of a small one', () => {
    const c = compareToBaseline(BASE, result({ 'PreToolUse Bash': 115, SessionStart: 480 }, 1200));
    assert.equal(c.regressed, false);
  });

  it('lists a scenario only one run has without failing on it', () => {
    const c = compareToBaseline(BASE, result({ 'PreToolUse Bash': 100 }, 1000));
    assert.deepEqual(c.unmatched, ['SessionStart']);
    assert.equal(c.regressed, false);
  });

  it('prints a delta line for every compared row', () => {
    const text = formatComparison(compareToBaseline(BASE, result({ 'PreToolUse Bash': 100, SessionStart: 481 }, 900)));
    assert.match(text, /hooks\.SessionStart\.p50 .*\+81\.0 ms .*REGRESSED/);
    assert.match(text, /mcp\.cheap_during_gh_ms .*-100\.0 ms .*ok/);
  });
});

describe('parseBenchResult', () => {
  it('reads a written result back', () => {
    assert.deepEqual(parseBenchResult(JSON.stringify(BASE), 'b.json'), BASE);
  });

  it('names the missing field', () => {
    const broken = { ...BASE, mcp: { cheap_alone_ms: 1, gh_call_ms: 1 } };
    assert.throws(() => parseBenchResult(JSON.stringify(broken), 'b.json'), /b\.json: mcp\.cheap_during_gh_ms is not a number/);
    assert.throws(() => parseBenchResult('{', 'b.json'), /b\.json: not JSON/);
  });
});
