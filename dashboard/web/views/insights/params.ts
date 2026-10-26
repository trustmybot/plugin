export const SECTIONS = [
  ['tokens', 'Tokens'],
  ['cost', 'Cost'],
  ['time', 'Time'],
  ['quality', 'Quality'],
  ['throughput', 'Throughput'],
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

export const FILTER_KEYS = ['repo', 'agent', 'model', 'effort'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

export interface InsightParams {
  section: Section;
  range: Range;
  metric: MetricKey;
  filters: Record<FilterKey, string>;
}

const pick = <T extends string>(list: ReadonlyArray<readonly [T, string]>, value: string | null | undefined, fallback: T): T =>
  list.find(([key]) => key === value)?.[0] ?? fallback;

export function parseInsightParams(path: string, params: URLSearchParams): InsightParams {
  const section = path.split('/').filter(Boolean)[1];
  return {
    section: pick(SECTIONS, section, 'tokens'),
    range: pick(RANGES, params.get('range'), '30d'),
    metric: pick(METRICS, params.get('m'), 'tokens_out'),
    filters: Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as Record<FilterKey, string>,
  };
}

export function insightHash(p: InsightParams): string {
  const query = new URLSearchParams({ range: p.range });
  for (const k of FILTER_KEYS) query.set(k, p.filters[k]);
  query.set('m', p.metric);
  return `#/insights/${p.section}?${query.toString()}`;
}

export function apiPath(p: InsightParams): string {
  const query = new URLSearchParams({ range: p.range });
  for (const k of FILTER_KEYS) if (p.filters[k]) query.set(k, p.filters[k]);
  return `insights?${query.toString()}`;
}

export function writeInsightParams(next: InsightParams): void {
  window.history.replaceState(null, '', insightHash(next));
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export const activeFilterCount = (p: InsightParams) => FILTER_KEYS.filter((k) => p.filters[k] !== '').length;
