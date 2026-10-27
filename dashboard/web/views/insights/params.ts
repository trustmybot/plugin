export const SECTIONS = [
  ['tokens', 'Tokens'],
  ['cost', 'Cost'],
  ['time', 'Time'],
  ['quality', 'Quality'],
  ['throughput', 'Throughput'],
  ['explore', 'Explore'],
] as const;
export type Section = (typeof SECTIONS)[number][0];

export const RANGES = [
  ['7d', 'Last 7 Days'],
  ['30d', 'Last 30 Days'],
  ['90d', 'Last 90 Days'],
  ['all', 'All Time'],
] as const;
export type Range = (typeof RANGES)[number][0];

export const PERIOD_LOWER: Record<Range, string> = {
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  '90d': 'last 90 days',
  all: 'all time',
};

export const METRICS = [
  ['tokens_out', 'Output Tokens'],
  ['context', 'Context'],
  ['cache_hit', 'Cache-Hit %'],
  ['tool_uses', 'Tool Uses'],
] as const;
export type MetricKey = (typeof METRICS)[number][0];

// pm decision 758: the histogram subtitle fragment and the From/To column
// headers both come from here, so they cannot drift apart.
export const METRIC_COPY: Record<MetricKey, { by: string; unit: string; noun: string }> = {
  tokens_out: { by: 'Output Tokens', unit: 'Tokens', noun: 'output tokens' },
  context: { by: 'Context Size', unit: 'Tokens', noun: 'context' },
  cache_hit: { by: 'Cache-Hit %', unit: '%', noun: 'cache-hit %' },
  tool_uses: { by: 'Tool Uses', unit: 'Uses', noun: 'tool uses' },
};

export const histogramSubtitle = (m: MetricKey, per: 'run' | 'session') => `${per === 'session' ? 'Sessions' : 'Runs'} by ${METRIC_COPY[m].by}`;
export const histogramColumns = (m: MetricKey) => [`From (${METRIC_COPY[m].unit})`, `To (${METRIC_COPY[m].unit})`] as const;

export const MEASURES = [
  ['tokens_out', 'Output Tokens'],
  ['context', 'Context'],
  ['cache_hit', 'Cache-Hit %'],
  ['cost', 'Cost'],
  ['duration_ms', 'Duration'],
  ['tool_uses', 'Tool Uses'],
] as const;
export type MeasureKey = (typeof MEASURES)[number][0];

export const AGGS = [
  ['avg', 'Average'],
  ['p50', 'p50'],
  ['p95', 'p95'],
  ['max', 'Max'],
  ['sum', 'Sum'],
  ['count', 'Count'],
] as const;
export type AggKey = (typeof AGGS)[number][0];

export const DIMS = [
  ['agent', 'Agent'],
  ['model', 'Model'],
  ['effort', 'Effort'],
  ['repo', 'Repo'],
  ['exit_reason', 'Exit Reason'],
  ['usage_source', 'Usage Source'],
  ['resumed', 'Resumed or Fresh'],
  ['prompt_bearing', 'Prompt-Bearing'],
  ['task_status', 'Task Status'],
  ['day', 'Day'],
  ['week', 'Week'],
  ['review_round', 'Review Round'],
  ['plugin_version', 'Plugin Version'],
] as const;
export type DimKey = (typeof DIMS)[number][0];

export const FILTER_KEYS = ['repo', 'agent', 'model', 'effort'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

export const FILTER_LABELS: Record<FilterKey, string> = { repo: 'Repo', agent: 'Agent', model: 'Model', effort: 'Effort' };

export const TASK_LEVEL_SECTIONS: ReadonlySet<string> = new Set(['quality', 'throughput']);
export const AGENT_LEVEL_FILTERS: readonly FilterKey[] = ['agent', 'model'];

export interface InsightParams {
  section: Section;
  range: Range;
  metric: MetricKey;
  measure: MeasureKey;
  agg: AggKey;
  dims: DimKey[];
  filters: Record<FilterKey, string>;
}

const DEFAULT_AGG: AggKey = 'p50';
const DEFAULT_DIMS: DimKey[] = ['agent'];

const pick = <T extends string>(list: ReadonlyArray<readonly [T, string]>, value: string | null | undefined, fallback: T): T =>
  list.find(([key]) => key === value)?.[0] ?? fallback;

function parseDims(raw: string | null): DimKey[] {
  const dims = [...new Set((raw ?? '').split(','))].filter((d): d is DimKey => DIMS.some(([k]) => k === d)).slice(0, 2);
  return dims.length > 0 ? dims : DEFAULT_DIMS;
}

const sectionOf = (path: string): Section => pick(SECTIONS, path.split('/').filter(Boolean)[1], 'tokens');

// Explore links from before GH 2050 carry the Measure in `m`.
export const isLegacyExploreHash = (path: string, params: URLSearchParams) => sectionOf(path) === 'explore' && !params.has('x') && params.has('m');

export function parseInsightParams(path: string, params: URLSearchParams): InsightParams {
  const section = sectionOf(path);
  return {
    section,
    range: pick(RANGES, params.get('range'), '30d'),
    metric: pick(METRICS, params.get('m'), 'tokens_out'),
    measure: pick(MEASURES, isLegacyExploreHash(path, params) ? params.get('m') : params.get('x'), 'tokens_out'),
    agg: pick(AGGS, params.get('a'), DEFAULT_AGG),
    dims: parseDims(params.get('g')),
    filters: Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as Record<FilterKey, string>,
  };
}

// Cache-hit % is a ratio of sums, so its only aggregate is the average.
export const pivotAgg = (p: InsightParams): AggKey => (p.measure === 'cache_hit' ? 'avg' : p.agg);

const pivotQuery = (p: InsightParams, query: URLSearchParams, always: boolean) => {
  if (always || p.agg !== DEFAULT_AGG) query.set('a', always ? pivotAgg(p) : p.agg);
  if (always || p.dims.join() !== DEFAULT_DIMS.join()) query.set('g', p.dims.join(','));
};

const withCommas = (query: URLSearchParams) => query.toString().replace(/%2C/g, ',');

export function insightHash(p: InsightParams): string {
  const query = new URLSearchParams({ range: p.range });
  for (const k of FILTER_KEYS) query.set(k, p.filters[k]);
  query.set('m', p.metric);
  query.set('x', p.measure);
  pivotQuery(p, query, false);
  return `#/insights/${p.section}?${withCommas(query)}`;
}

const filterQuery = (p: InsightParams) => {
  const query = new URLSearchParams({ range: p.range });
  for (const k of FILTER_KEYS) if (p.filters[k]) query.set(k, p.filters[k]);
  return query;
};

export const apiPath = (p: InsightParams) => `insights?${filterQuery(p).toString()}`;

export function exploreApiPath(p: InsightParams): string {
  const query = filterQuery(p);
  query.set('m', p.measure);
  pivotQuery(p, query, true);
  return `insights/explore?${withCommas(query)}`;
}

export function writeInsightParams(next: InsightParams): void {
  window.history.replaceState(null, '', insightHash(next));
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export const activeFilterCount = (p: InsightParams) => FILTER_KEYS.filter((k) => p.filters[k] !== '').length;

export const clearFilters = (p: InsightParams): InsightParams => ({ ...p, filters: { repo: '', agent: '', model: '', effort: '' } });

export const activeFilterList = (p: InsightParams) =>
  FILTER_KEYS.filter((k) => p.filters[k] !== '')
    .map((k) => `${FILTER_LABELS[k]}: ${p.filters[k]}`)
    .join(' · ');
