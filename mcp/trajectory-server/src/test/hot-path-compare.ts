/**
 * The result shape of hot-path.bench and its --baseline verdict (GH 3232): a
 * hook scenario's p50 or the cheap tool's latency during a gh call regresses
 * when it grows by more than max(20%, 15 ms) over the baseline run.
 */

export interface HookStats {
  procs: number;
  p50: number;
  p95: number;
  max: number;
}

export interface McpStats {
  cheap_alone_ms: number;
  cheap_during_gh_ms: number;
  gh_call_ms: number;
}

export interface BenchResult {
  hooks: Record<string, HookStats>;
  mcp: McpStats;
  env: { node: string; load: number; rounds: number };
}

export interface DeltaRow {
  metric: string;
  baseline: number;
  current: number;
  delta: number;
  allowed: number;
  regressed: boolean;
}

export interface Comparison {
  rows: DeltaRow[];
  unmatched: string[];
  regressed: boolean;
}

export const REGRESSION_RATIO = 0.2;
export const REGRESSION_FLOOR_MS = 15;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// Validates a bench JSON read from disk; throws naming the first bad field.
export function parseBenchResult(text: string, source: string): BenchResult {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch (e) {
    throw new Error(`${source}: not JSON: ${(e as Error).message}`, { cause: e });
  }
  const r = o as Partial<BenchResult> | null;
  if (r === null || typeof r !== 'object' || typeof r.hooks !== 'object' || r.hooks === null) throw new Error(`${source}: missing hooks object`);
  for (const [name, s] of Object.entries(r.hooks)) {
    for (const k of ['procs', 'p50', 'p95', 'max'] as const) {
      if (!isFiniteNumber((s as Partial<HookStats> | null)?.[k])) throw new Error(`${source}: hooks.${name}.${k} is not a number`);
    }
  }
  if (typeof r.mcp !== 'object' || r.mcp === null) throw new Error(`${source}: missing mcp object`);
  for (const k of ['cheap_alone_ms', 'cheap_during_gh_ms', 'gh_call_ms'] as const) {
    if (!isFiniteNumber(r.mcp[k])) throw new Error(`${source}: mcp.${k} is not a number`);
  }
  return r as BenchResult;
}

function deltaRow(metric: string, baseline: number, current: number): DeltaRow {
  const allowed = Math.max(baseline * REGRESSION_RATIO, REGRESSION_FLOOR_MS);
  const delta = current - baseline;
  return { metric, baseline, current, delta, allowed, regressed: delta > allowed };
}

// Every hook scenario both runs measured, by p50, plus cheap_during_gh_ms.
// A scenario only one run has is listed in unmatched and never regresses.
export function compareToBaseline(baseline: BenchResult, current: BenchResult): Comparison {
  const rows: DeltaRow[] = [];
  const unmatched: string[] = [];
  const scenarios = [...new Set([...Object.keys(baseline.hooks), ...Object.keys(current.hooks)])].sort();
  for (const s of scenarios) {
    const b = baseline.hooks[s];
    const c = current.hooks[s];
    if (b === undefined || c === undefined) {
      unmatched.push(s);
      continue;
    }
    rows.push(deltaRow(`hooks.${s}.p50`, b.p50, c.p50));
  }
  rows.push(deltaRow('mcp.cheap_during_gh_ms', baseline.mcp.cheap_during_gh_ms, current.mcp.cheap_during_gh_ms));
  return { rows, unmatched, regressed: rows.some((r) => r.regressed) };
}

export function formatComparison(c: Comparison): string {
  const lines = c.rows.map((r) => {
    const sign = r.delta >= 0 ? '+' : '';
    const tag = r.regressed ? 'REGRESSED' : 'ok';
    return `${r.metric.padEnd(36)} ${r.baseline.toFixed(1).padStart(9)} -> ${r.current.toFixed(1).padStart(9)} ms  ${sign}${r.delta.toFixed(1)} ms (allowed +${r.allowed.toFixed(1)})  ${tag}`;
  });
  for (const s of c.unmatched) lines.push(`hooks.${s}: in only one run, not compared`);
  return lines.join('\n');
}
