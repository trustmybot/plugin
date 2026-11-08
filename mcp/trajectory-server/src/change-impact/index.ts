/**
 * Change impact (GH 2600): before/after statistics on the agent metrics for a
 * change from any provider (providers.ts). Shared by the `change_impact` MCP
 * tool, the CLI and the dashboard, so every surface reports the same numbers.
 */
import type { StatsReader } from '../tools/stats.js';
import { METRICS } from './metrics.js';
import {
  CHANGE_SOURCES,
  PROVIDERS,
  providerContext,
  type ChangeEvent,
  type ChangeProvider,
  type ChangeRef,
  type ChangeSource,
  type ProviderContext,
  type SplitSample,
} from './providers.js';
import { bootstrapRatioCi, hashSeed, holm, mannWhitneyU, mean, median, ratioOfMedians } from './stats.js';

export { METRICS, type Metric, type Sample } from './metrics.js';
export { BuildHistory, baseRef, defaultGit, gitSourceFor, type GitCommit, type GitRunner, type GitSource } from './attribution.js';
export {
  AGENT_SURFACE_KEY,
  CHANGE_SOURCES,
  DEFAULT_AGENT_SURFACE,
  PROVIDERS,
  agentSurfaceGlobs,
  changeIdOf,
  providerContext,
  type ChangeEvent,
  type ChangeProvider,
  type ChangeRef,
  type ChangeSource,
  type ProviderContext,
  type RepoRow,
  type Split,
  type SplitSample,
} from './providers.js';

export const DEFAULT_WINDOW_DAYS = 14;
export const DEFAULT_MAX_SAMPLES = 200;
export const DEFAULT_LIMIT = 20;
export const MIN_SAMPLES = 20;
export const ALPHA = 0.05;

const DAY_MS = 86_400_000;

export interface ChangeImpactOptions {
  change?: ChangeRef;
  source?: ChangeSource;
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

export interface ChangeImpact extends ChangeEvent {
  measured_with: ChangeRef[];
  metrics: MetricImpact[];
}

export interface ChangeImpactList {
  sources: ChangeSource[];
  changes: ChangeImpact[];
}

function positiveInt(v: number | undefined, fallback: number, name: string): number {
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || v <= 0) throw new Error(`${name} must be a positive integer`);
  return v;
}

function checkSource(source: unknown): ChangeSource {
  if (!CHANGE_SOURCES.includes(source as ChangeSource)) throw new Error(`source must be one of ${CHANGE_SOURCES.join(', ')}`);
  return source as ChangeSource;
}

function side(samples: SplitSample[], unattributed: number): { values: number[]; stats: SideStats } {
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

function impactOf(
  ctx: ProviderContext,
  provider: ChangeProvider,
  event: ChangeEvent,
  windowDays: number,
  maxSamples: number,
  metricFilter: string | undefined,
): ChangeImpact {
  const at = Date.parse(event.at);
  const windowMs = windowDays * DAY_MS;
  const inWindow = (s: SplitSample) => Math.abs(s.t - at) <= windowMs;
  const nearest = (a: SplitSample, b: SplitSample) => Math.abs(a.t - at) - Math.abs(b.t - at);

  const partial = METRICS.map((metric) => {
    const split = provider.split(event, ctx, metric);
    const unattributed = split.unattributed.filter(inWindow);
    const b = side(split.before.filter(inWindow).sort(nearest).slice(0, maxSamples), unattributed.filter((s) => s.t < at).length);
    const a = side(split.after.filter(inWindow).sort(nearest).slice(0, maxSamples), unattributed.filter((s) => s.t >= at).length);
    const enough = b.stats.n >= MIN_SAMPLES && a.stats.n >= MIN_SAMPLES;
    return {
      metric,
      before: b.stats,
      after: a.stats,
      ratio_of_medians: ratioOfMedians(b.values, a.values),
      ratio_ci: enough && b.stats.median !== 0 ? bootstrapRatioCi(b.values, a.values, hashSeed(`${event.id}:${metric.id}`)) : null,
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
    source: event.source,
    id: event.id,
    label: event.label,
    at: event.at,
    kind: event.kind,
    repo: event.repo,
    measured_with: provider.measuredWith(event, ctx, windowMs),
    metrics,
  };
}

export function computeChangeImpact(
  reader: StatsReader,
  ctx: ProviderContext | undefined,
  opts: ChangeImpactOptions & { change: ChangeRef },
): ChangeImpact;
export function computeChangeImpact(
  reader: StatsReader,
  ctx?: ProviderContext,
  opts?: ChangeImpactOptions,
): ChangeImpact | ChangeImpactList;
export function computeChangeImpact(
  reader: StatsReader,
  ctx: ProviderContext = providerContext(reader),
  opts: ChangeImpactOptions = {},
): ChangeImpact | ChangeImpactList {
  const windowDays = positiveInt(opts.window_days, DEFAULT_WINDOW_DAYS, 'window_days');
  const maxSamples = positiveInt(opts.max_samples, DEFAULT_MAX_SAMPLES, 'max_samples');
  const limit = positiveInt(opts.limit, DEFAULT_LIMIT, 'limit');
  if (opts.metric !== undefined && !METRICS.some((m) => m.id === opts.metric)) {
    throw new Error(`unknown metric ${opts.metric}; one of ${METRICS.map((m) => m.id).join(', ')}`);
  }
  if (opts.change !== undefined) {
    const source = checkSource(opts.change.source);
    const id = opts.change.id;
    if (typeof id !== 'string' || id.length === 0) throw new Error('change.id must be a non-empty string');
    const provider = PROVIDERS.find((p) => p.source === source)!;
    const event = provider.list(ctx).find((e) => e.id === id);
    if (!event) throw new Error(`unknown change ${source}:${id}`);
    return impactOf(ctx, provider, event, windowDays, maxSamples, opts.metric);
  }
  const filter = opts.source === undefined ? undefined : checkSource(opts.source);
  const listed = PROVIDERS.map((provider) => ({ provider, events: provider.list(ctx) }));
  const sources = listed.filter((l) => l.events.length > 0).map((l) => l.provider.source);
  const recent = listed
    .filter((l) => filter === undefined || l.provider.source === filter)
    .flatMap((l) => l.events.map((event) => ({ provider: l.provider, event })))
    .sort((a, b) => Date.parse(b.event.at) - Date.parse(a.event.at))
    .slice(0, limit);
  return { sources, changes: recent.map((r) => impactOf(ctx, r.provider, r.event, windowDays, maxSamples, opts.metric)) };
}

/** Samples per metric started within the last <days> days of <now>. */
export function sampleCounts(reader: StatsReader, days: number, now: Date = new Date()): Record<string, number> {
  const since = now.getTime() - days * DAY_MS;
  return Object.fromEntries(
    METRICS.map((m) => [m.id, m.samples(reader).filter((s) => Date.parse(s.at) >= since).length]),
  );
}
