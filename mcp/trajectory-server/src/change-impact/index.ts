/**
 * Change impact (GH 2600): before/after statistics on the agent metrics for a
 * merged change. Shared by the `change_impact` MCP tool, the CLI and the
 * dashboard, so every surface reports the same numbers.
 */
import type { StatsReader } from '../tools/stats.js';
import { BuildHistory, type GitSource } from './attribution.js';
import { METRICS, type Metric } from './metrics.js';
import { bootstrapRatioCi, hashSeed, holm, mannWhitneyU, mean, median, ratioOfMedians } from './stats.js';

export { METRICS, type Metric, type Sample } from './metrics.js';
export { BuildHistory, GitUnavailableError, defaultGitSource, gitSourceAt, type GitCommit, type GitSource } from './attribution.js';

export const DEFAULT_WINDOW_DAYS = 14;
export const DEFAULT_MAX_SAMPLES = 200;
export const DEFAULT_LIMIT = 20;
export const MIN_SAMPLES = 20;
export const ALPHA = 0.05;

const DAY_MS = 86_400_000;

export interface ChangeImpactOptions {
  change?: number;
  metric?: string;
  window_days?: number;
  max_samples?: number;
  limit?: number;
}

export interface SideStats {
  n: number;
  median: number | null;
  mean: number | null;
  estimated_n: number;
  unattributed_n: number;
}

export type Verdict = 'improved' | 'regressed' | 'no_change' | 'not_enough_data';

export interface MetricImpact {
  id: string;
  label: string;
  unit: string;
  direction: 'lower' | 'higher';
  before: SideStats;
  after: SideStats;
  ratio_of_medians: number | null;
  ratio_ci: [number, number] | null;
  p: number | null;
  p_holm: number | null;
  verdict: Verdict;
}

export interface ChangeImpact {
  change: number;
  merged_at: string;
  build_index: number;
  measured_with: number[];
  metrics: MetricImpact[];
}

interface Attributed {
  t: number;
  value: number;
  idx: number | null;
  estimated: boolean;
}

interface MetricData {
  metric: Metric;
  samples: Attributed[];
}

function loadMetricData(reader: StatsReader, history: BuildHistory): MetricData[] {
  return METRICS.map((metric) => ({
    metric,
    samples: metric
      .samples(reader)
      .map((s) => {
        const a = history.attribute(s.version, s.at);
        return { t: Date.parse(s.at), value: s.value, idx: a?.idx ?? null, estimated: a?.estimated ?? false };
      })
      .filter((s) => !Number.isNaN(s.t)),
  }));
}

function positiveInt(v: number | undefined, fallback: number, name: string): number {
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || v <= 0) throw new Error(`${name} must be a positive integer`);
  return v;
}

function side(samples: Attributed[], unattributed: number): { values: number[]; stats: SideStats } {
  const values = samples.map((s) => s.value);
  return {
    values,
    stats: {
      n: values.length,
      median: median(values),
      mean: mean(values),
      estimated_n: samples.filter((s) => s.estimated).length,
      unattributed_n: unattributed,
    },
  };
}

function verdictOf(direction: 'lower' | 'higher', before: SideStats, after: SideStats, pHolm: number): Verdict {
  if (pHolm >= ALPHA) return 'no_change';
  let shift = (after.median ?? 0) - (before.median ?? 0);
  if (shift === 0) shift = (after.mean ?? 0) - (before.mean ?? 0);
  if (shift === 0) return 'no_change';
  return (shift < 0) === (direction === 'lower') ? 'improved' : 'regressed';
}

function measuredWith(data: MetricData[], history: BuildHistory, change: number, idxC: number): number[] {
  let lo = -1;
  let hi = Number.POSITIVE_INFINITY;
  for (const d of data) {
    for (const s of d.samples) {
      if (s.idx === null) continue;
      if (s.idx < idxC) lo = Math.max(lo, s.idx);
      else hi = Math.min(hi, s.idx);
    }
  }
  return history
    .prs()
    .filter((p) => p.idx > lo && p.idx < hi && p.pr !== change)
    .map((p) => p.pr);
}

function impactOf(
  data: MetricData[],
  history: BuildHistory,
  change: number,
  windowDays: number,
  maxSamples: number,
  metricFilter: string | undefined,
): ChangeImpact {
  const idxC = history.indexOfPr(change);
  if (idxC === undefined) throw new Error(`change ${change} is not a merged PR on ${history.target}`);
  const mergedAt = Date.parse(history.commits[idxC]!.at);
  const windowMs = windowDays * DAY_MS;
  const nearest = (a: Attributed, b: Attributed) => Math.abs(a.t - mergedAt) - Math.abs(b.t - mergedAt);

  const partial = data.map(({ metric, samples }) => {
    const inWindow = samples.filter((s) => Math.abs(s.t - mergedAt) <= windowMs);
    const unBefore = inWindow.filter((s) => s.idx === null && s.t < mergedAt).length;
    const unAfter = inWindow.filter((s) => s.idx === null && s.t >= mergedAt).length;
    const b = side(inWindow.filter((s) => s.idx !== null && s.idx < idxC).sort(nearest).slice(0, maxSamples), unBefore);
    const a = side(inWindow.filter((s) => s.idx !== null && s.idx >= idxC).sort(nearest).slice(0, maxSamples), unAfter);
    const enough = b.stats.n >= MIN_SAMPLES && a.stats.n >= MIN_SAMPLES;
    return {
      metric,
      before: b.stats,
      after: a.stats,
      ratio_of_medians: ratioOfMedians(b.values, a.values),
      ratio_ci: enough && b.stats.median !== 0 ? bootstrapRatioCi(b.values, a.values, hashSeed(`${change}:${metric.id}`)) : null,
      p: enough ? mannWhitneyU(a.values, b.values).p : null,
    };
  });

  const tested = partial.filter((m) => m.p !== null);
  const adjusted = holm(tested.map((m) => m.p as number));
  const pHolm = new Map(tested.map((m, i) => [m.metric.id, adjusted[i]!]));

  const metrics: MetricImpact[] = partial
    .filter((m) => metricFilter === undefined || m.metric.id === metricFilter)
    .map((m) => {
      const ph = pHolm.get(m.metric.id) ?? null;
      return {
        id: m.metric.id,
        label: m.metric.label,
        unit: m.metric.unit,
        direction: m.metric.direction,
        before: m.before,
        after: m.after,
        ratio_of_medians: m.ratio_of_medians,
        ratio_ci: m.ratio_ci,
        p: m.p,
        p_holm: ph,
        verdict: ph === null ? 'not_enough_data' : verdictOf(m.metric.direction, m.before, m.after, ph),
      };
    });

  return {
    change,
    merged_at: new Date(mergedAt).toISOString(),
    build_index: idxC,
    measured_with: measuredWith(data, history, change, idxC),
    metrics,
  };
}

export function computeChangeImpact(reader: StatsReader, git: GitSource, opts: ChangeImpactOptions & { change: number }): ChangeImpact;
export function computeChangeImpact(reader: StatsReader, git: GitSource, opts?: ChangeImpactOptions): ChangeImpact | { changes: ChangeImpact[] };
export function computeChangeImpact(
  reader: StatsReader,
  git: GitSource,
  opts: ChangeImpactOptions = {},
): ChangeImpact | { changes: ChangeImpact[] } {
  const windowDays = positiveInt(opts.window_days, DEFAULT_WINDOW_DAYS, 'window_days');
  const maxSamples = positiveInt(opts.max_samples, DEFAULT_MAX_SAMPLES, 'max_samples');
  const limit = positiveInt(opts.limit, DEFAULT_LIMIT, 'limit');
  if (opts.change !== undefined && !Number.isInteger(opts.change)) throw new Error('change must be an integer PR number');
  if (opts.metric !== undefined && !METRICS.some((m) => m.id === opts.metric)) {
    throw new Error(`unknown metric ${opts.metric}; one of ${METRICS.map((m) => m.id).join(', ')}`);
  }
  const history = new BuildHistory(git);
  const data = loadMetricData(reader, history);
  if (opts.change !== undefined) return impactOf(data, history, opts.change, windowDays, maxSamples, opts.metric);
  const recent = history.prs().slice(-limit).reverse();
  return { changes: recent.map((p) => impactOf(data, history, p.pr, windowDays, maxSamples, opts.metric)) };
}

/** Samples per metric started within the last <days> days of <now>. */
export function sampleCounts(reader: StatsReader, days: number, now: Date = new Date()): Record<string, number> {
  const since = now.getTime() - days * DAY_MS;
  return Object.fromEntries(
    METRICS.map((m) => [m.id, m.samples(reader).filter((s) => Date.parse(s.at) >= since).length]),
  );
}
