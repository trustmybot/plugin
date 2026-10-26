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
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
  ['90d', 'Last 90 days'],
  ['all', 'All time'],
] as const;
export type Range = (typeof RANGES)[number][0];

export const METRICS = [
  ['tokens_out', 'Output tokens'],
  ['context', 'Context'],
  ['cache_hit', 'Cache-hit %'],
  ['tool_uses', 'Tool uses'],
] as const;
export type MetricKey = (typeof METRICS)[number][0];

export const MEASURES = [
  ['tokens_out', 'Output tokens'],
  ['context', 'Context'],
  ['cache_hit', 'Cache-hit %'],
  ['cost', 'Cost'],
  ['duration_ms', 'Duration'],
  ['tool_uses', 'Tool uses'],
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
  ['agent', 'agent'],
  ['model', 'model'],
  ['effort', 'effort'],
  ['repo', 'repo'],
  ['exit_reason', 'exit reason'],
  ['usage_source', 'usage source'],
  ['resumed', 'resumed or fresh'],
  ['prompt_bearing', 'prompt-bearing'],
  ['task_status', 'task status'],
  ['day', 'day'],
  ['week', 'week'],
  ['review_round', 'review round'],
  ['plugin_version', 'plugin version'],
] as const;
export type DimKey = (typeof DIMS)[number][0];

export const FILTER_KEYS = ['repo', 'agent', 'model', 'effort'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

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

export function parseInsightParams(path: string, params: URLSearchParams): InsightParams {
  const section = path.split('/').filter(Boolean)[1];
  return {
    section: pick(SECTIONS, section, 'tokens'),
    range: pick(RANGES, params.get('range'), '30d'),
    metric: pick(METRICS, params.get('m'), 'tokens_out'),
    measure: pick(MEASURES, params.get('m'), 'tokens_out'),
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
  query.set('m', p.section === 'explore' ? p.measure : p.metric);
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
