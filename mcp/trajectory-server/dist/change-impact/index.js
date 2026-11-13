import { METRICS } from './metrics.js';
import { CHANGE_SOURCES, PROVIDERS, providerContext, } from './providers.js';
import { bootstrapRatioCi, hashSeed, holm, mannWhitneyU, mean, median, ratioOfMedians } from './stats.js';
import { declaredByPr, outcomeOf } from './declared.js';
export { METRICS } from './metrics.js';
export { METRIC_LINE, declaredByPr, outcomeOf, parseDeclaredLog } from './declared.js';
export { BuildHistory, baseRef, defaultGit, gitSourceFor } from './attribution.js';
export { AGENT_SURFACE_KEY, CHANGE_SOURCES, DEFAULT_AGENT_SURFACE, PROVIDERS, agentSurfaceGlobs, changeIdOf, providerContext, } from './providers.js';
export const DEFAULT_WINDOW_DAYS = 14;
export const DEFAULT_MAX_SAMPLES = 200;
export const DEFAULT_LIMIT = 20;
export const MIN_SAMPLES = 20;
export const ALPHA = 0.05;
const DAY_MS = 86_400_000;
function positiveInt(v, fallback, name) {
    if (v === undefined)
        return fallback;
    if (!Number.isInteger(v) || v <= 0)
        throw new Error(`${name} must be a positive integer`);
    return v;
}
function checkSource(source) {
    if (!CHANGE_SOURCES.includes(source))
        throw new Error(`source must be one of ${CHANGE_SOURCES.join(', ')}`);
    return source;
}
function side(samples, unattributed) {
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
function daily(samples) {
    const byDay = new Map();
    for (const s of samples) {
        const day = new Date(s.t).toISOString().slice(0, 10);
        const values = byDay.get(day);
        if (values)
            values.push(s.value);
        else
            byDay.set(day, [s.value]);
    }
    return [...byDay.keys()].sort().map((day) => {
        const values = byDay.get(day);
        return { day, n: values.length, median: median(values) };
    });
}
function verdictOf(direction, before, after, pHolm) {
    if (pHolm >= ALPHA)
        return 'no_change';
    let shift = (after.median ?? 0) - (before.median ?? 0);
    if (shift === 0)
        shift = (after.mean ?? 0) - (before.mean ?? 0);
    if (shift === 0)
        return 'no_change';
    return (shift < 0) === (direction === 'lower') ? 'improved' : 'regressed';
}
function impactOf(ctx, provider, event, windowDays, maxSamples, metricFilter, series) {
    const at = Date.parse(event.at);
    const windowMs = windowDays * DAY_MS;
    const inWindow = (s) => Math.abs(s.t - at) <= windowMs;
    const nearest = (a, b) => Math.abs(a.t - at) - Math.abs(b.t - at);
    const partial = METRICS.map((metric) => {
        const split = provider.split(event, ctx, metric);
        const unattributed = split.unattributed.filter(inWindow);
        const kept = (samples) => samples.filter(inWindow).sort(nearest).slice(0, maxSamples);
        const beforeSamples = kept(split.before);
        const afterSamples = kept(split.after);
        const b = side(beforeSamples, unattributed.filter((s) => s.t < at).length);
        const a = side(afterSamples, unattributed.filter((s) => s.t >= at).length);
        const enough = b.stats.n >= MIN_SAMPLES && a.stats.n >= MIN_SAMPLES;
        return {
            metric,
            series: series ? { before: daily(beforeSamples), after: daily(afterSamples) } : undefined,
            before: b.stats,
            after: a.stats,
            ratio_of_medians: ratioOfMedians(b.values, a.values),
            ratio_ci: enough && b.stats.median !== 0 ? bootstrapRatioCi(b.values, a.values, hashSeed(`${event.id}:${metric.id}`)) : null,
            p: enough ? mannWhitneyU(a.values, b.values).p : null,
        };
    });
    const tested = partial.filter((m) => m.p !== null);
    const adjusted = holm(tested.map((m) => m.p));
    const pHolm = new Map(tested.map((m, i) => [m.metric.id, adjusted[i]]));
    const all = partial.map((m) => {
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
            ...(m.series ? { series: m.series } : {}),
        };
    });
    const metrics = all.filter((m) => metricFilter === undefined || m.id === metricFilter);
    const declared = declaredOf(ctx, event, all);
    return {
        source: event.source,
        id: event.id,
        label: event.label,
        at: event.at,
        kind: event.kind,
        repo: event.repo,
        measured_with: provider.measuredWith(event, ctx, windowMs),
        metrics,
        ...(declared.length > 0 ? { declared } : {}),
    };
}
function declaredOf(ctx, event, metrics) {
    if (event.source !== 'plugin_version' || event.kind !== 'build')
        return [];
    return (declaredByPr(ctx).get(Number(event.id)) ?? []).flatMap((d) => {
        const m = metrics.find((x) => x.id === d.metric);
        return m ? [{ metric: d.metric, direction: d.direction, outcome: outcomeOf(d.direction, m.direction, m.verdict) }] : [];
    });
}
export function computeChangeImpact(reader, ctx = providerContext(reader), opts = {}) {
    const windowDays = positiveInt(opts.window_days, DEFAULT_WINDOW_DAYS, 'window_days');
    const maxSamples = positiveInt(opts.max_samples, DEFAULT_MAX_SAMPLES, 'max_samples');
    const limit = positiveInt(opts.limit, DEFAULT_LIMIT, 'limit');
    if (opts.metric !== undefined && !METRICS.some((m) => m.id === opts.metric)) {
        throw new Error(`unknown metric ${opts.metric}; one of ${METRICS.map((m) => m.id).join(', ')}`);
    }
    if (opts.change !== undefined) {
        const source = checkSource(opts.change.source);
        const id = opts.change.id;
        if (typeof id !== 'string' || id.length === 0)
            throw new Error('change.id must be a non-empty string');
        const repo = opts.change.repo ?? undefined;
        if (repo !== undefined && (typeof repo !== 'string' || repo.length === 0))
            throw new Error('change.repo must be a non-empty string');
        const provider = PROVIDERS.find((p) => p.source === source);
        const matches = provider.list(ctx).filter((e) => e.id === id && (repo === undefined || e.repo === repo));
        if (matches.length === 0)
            throw new Error(`unknown change ${source}:${id}${repo === undefined ? '' : ` in repo ${repo}`}`);
        if (matches.length > 1) {
            const repos = [...new Set(matches.map((e) => e.repo ?? '(none)'))].join(', ');
            throw new Error(`ambiguous change ${source}:${id} matches repos ${repos}; pass change.repo`);
        }
        const event = matches[0];
        return impactOf(ctx, provider, event, windowDays, maxSamples, opts.metric, opts.series === true);
    }
    const filter = opts.source === undefined ? undefined : checkSource(opts.source);
    const listed = PROVIDERS.map((provider) => ({ provider, events: provider.list(ctx) }));
    const sources = listed.filter((l) => l.events.length > 0).map((l) => l.provider.source);
    const recent = listed
        .filter((l) => filter === undefined || l.provider.source === filter)
        .flatMap((l) => l.events.map((event) => ({ provider: l.provider, event })))
        .sort((a, b) => Date.parse(b.event.at) - Date.parse(a.event.at))
        .slice(0, limit);
    return { sources, changes: recent.map((r) => impactOf(ctx, r.provider, r.event, windowDays, maxSamples, opts.metric, opts.series === true)) };
}
/** Samples per metric started within the last <days> days of <now>. */
export function sampleCounts(reader, days, now = new Date()) {
    const since = now.getTime() - days * DAY_MS;
    return Object.fromEntries(METRICS.map((m) => [m.id, m.samples(reader).filter((s) => Date.parse(s.at) >= since).length]));
}
//# sourceMappingURL=index.js.map