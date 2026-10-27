import { parseSlice, sliceKey, type Compare } from './compare.ts';

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
  compare?: Compare | null;
}

export const COMPARE_SECTIONS: ReadonlySet<Section> = new Set(['tokens', 'cost']);
export const comparing = (p: InsightParams) => !!p.compare && COMPARE_SECTIONS.has(p.section);

// pm decision 816: every Compare Periods string.
export const PREV_RANGES = [
  ['prev7d', 'Previous 7 Days'],
  ['prev30d', 'Previous 30 Days'],
  ['prev90d', 'Previous 90 Days'],
] as const;
export const COMPARE_TOGGLE = 'Compare Periods';
export const COMPARE_TOGGLE_TITLE = 'Compare two periods side by side to see what changed.';
export const COMPARE_ON = 'Compare on. Showing Period 1 and Period 2.';
export const COMPARE_OFF = 'Compare off.';
export const COMPARE_SCOPE_NOTE = 'Compare covers Tokens and Cost for now.';
export const SWAP_PERIODS = 'Swap periods';
export const periodName = (n: 1 | 2) => `Period ${n}`;
export const periodType = (n: 1 | 2) => `Period ${n} type`;
export const PERIOD_KINDS = [
  ['dates', 'Dates'],
  ['tasks', 'Tasks'],
] as const;
export const DATE_PRESETS = [
  ['7d', 'Last 7 Days'],
  ['30d', 'Last 30 Days'],
  ['90d', 'Last 90 Days'],
  ...PREV_RANGES,
  ['all', 'All Time'],
  ['custom', 'Custom Dates'],
] as const;
export const DATES_LABEL = 'Dates';
export const FROM_LABEL = 'From';
export const TO_LABEL = 'To';
export const FIRST_TASK = 'First task';
export const LATEST_TASK = 'Latest task';
export const TASKS_HINT = 'Leave To empty for every task from From on.';
export const TASK_ORDER_ERROR = 'To must be the same as or higher than From.';
export const DATE_ORDER_ERROR = 'To must be on or after From.';
export const TASK_NUMBER_ERROR = 'Enter a task number, like 201.';
export const ALL_TASKS = 'All Tasks';
export const ALL_DATES = 'All Dates';
export const tasksRange = (from: number, to: number) => `Tasks ${from}–${to}`;
export const tasksOne = (n: number) => `Task ${n}`;
export const tasksFrom = (from: number) => `Tasks ${from}+`;
export const tasksUpTo = (to: number) => `Tasks up to ${to}`;
export const datesFrom = (day: string) => `From ${day}`;
export const datesThrough = (day: string) => `Through ${day}`;
export const periodLabel = (n: 1 | 2, slice: string) => `${periodName(n)}: ${slice}`;
const runsNoun = (n: number, per: 'run' | 'session' = 'run') => (per === 'session' ? (n === 1 ? 'session' : 'sessions') : n === 1 ? 'run' : 'runs');
export const compareSummary = (p: Array<{ label: string; runs: number }>) =>
  p.map((x, i) => `${periodName((i + 1) as 1 | 2)}: ${x.label}, ${x.runs} ${runsNoun(x.runs)}.`).join(' ');
export const sharedRunsCaption = (n: number) => `${n} ${runsNoun(n)} ${n === 1 ? 'is' : 'are'} in both periods, so the change may look smaller than it is.`;
export const SAME_PERIODS = 'Both periods are the same. Change one to compare.';
export const COMPARE_SUBTITLE = 'Period 1 vs Period 2';
export const vsPeriod1 = (change: string) => `${change} vs Period 1`;
export const NO_CHANGE = 'No Change';
export const NO_BASELINE_TITLE = 'Period 1 has no runs to compare against.';
export const noBaselineAria = (subject: string) => `${subject}: ${NO_BASELINE_TITLE}`;
export const noChangeAria = (subject: string) => `${subject}: no change vs Period 1.`;
export const deltaAria = (subject: string, direction: 'up' | 'down', mag: string, better: boolean | null) =>
  `${subject} ${direction} ${mag} vs Period 1${better === null ? '' : better ? ', better' : ', worse'}.`;
export const LOWER_BETTER = 'Lower is better.';
export const HIGHER_BETTER = 'Higher is better.';
export const PER_TASK_HEADING = 'Per Task';
export const PER_TASK_TILES = {
  tokens_out: 'Output Tokens per Task',
  context: 'Context per Task',
  cache_hit: 'Cache-Hit %',
  cost: 'Cost per Task',
} as const;
export const perTaskSubject = { tokens_out: 'output tokens per task', context: 'context per task', cache_hit: 'cache-hit %', cost: 'cost per task' } as const;
export const period1Value = (v: string) => `${periodName(1)}: ${v}`;
export const MEASURE_HEADER = 'Measure';
export const CHANGE_HEADER = 'Change';
export const compareMeasured = (p: Array<{ n: number; total: number }>, per: 'run' | 'session') =>
  p.map((x, i) => `${periodName((i + 1) as 1 | 2)}: ${x.n} of ${x.total} ${runsNoun(x.total, per)}.`).join(' ');
export const periodEarly = (n: 1 | 2, early: string) => `${periodName(n)} · ${early}`;
export const periodRuns = (n: 1 | 2, per: 'run' | 'session') => `${periodName(n)} ${per === 'session' ? 'Sessions' : 'Runs'}`;
export const periodShare = (n: 1 | 2) => `${periodName(n)} Share`;
export const overlayTip = (range: string, p: Array<{ share: string; count: number }>, per: 'run' | 'session') =>
  `${range}: ${p.map((x, i) => `${periodName((i + 1) as 1 | 2)} ${x.share} (${x.count} ${runsNoun(x.count, per)})`).join(', ')}`;
export const overlayAria = (head: string, p: Array<{ n: number; p50: string | null; p95: string | null }>) =>
  `${head}: ${p.map((x, i) => `${periodName((i + 1) as 1 | 2)} ${x.n} measured${x.p50 === null ? '' : `, p50 ${x.p50}, p95 ${x.p95}`}`).join('; ')}`;
export const OUTLIERS_P2 = `, ${periodName(2)}`;
export const BRO_EXCLUDED_CAPTION = "bro sessions aren't tied to a task, so they're left out of both periods.";
export const BRO_TASKS_CAPTION = "bro sessions aren't tied to a task, so task ranges leave them out.";
export const NO_RUNS_EITHER = 'No Runs in Either Period';
export const noRunsEither = (p1: string, p2: string) => `Nothing in ${p1} or ${p2} matches. Widen a period or clear filters.`;
export const noRunsIn = (n: 1 | 2, label: string) => `No runs in ${periodName(n)} (${label}). Widen it to compare.`;
export const COST_PER_RUN_AGENT = 'Cost per Run by Agent';
export const COST_PER_RUN_MODEL = 'Cost per Run by Model';
export const COST_PER_RUN_UNIT = 'USD per Run';
export const BRO_COST_PER_SESSION = 'bro Cost per Session';
export const COST_PER_SESSION_UNIT = 'USD per Session';
export const costPerRunSubject = (name: string) => `${name} cost per run`;
export const periodCost = (n: 1 | 2) => `${periodName(n)} USD per Run`;
export const periodUnpriced = (n: 1 | 2, count: number) =>
  `${periodName(n)}: ${count} measured ${count === 1 ? 'run has' : 'runs have'} no price for their model and ${count === 1 ? 'is' : 'are'} left out.`;
export const NAME_HEADER = 'Name';
export const pairText = (label: string, v1: string, v2: string) => `${label}: ${periodName(1)} ${v1}, ${periodName(2)} ${v2}`;


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
    ...compareOf(params),
  };
}

// A hash without both periods carries no `compare` key, so pre-compare params compare equal.
function compareOf(params: URLSearchParams): { compare?: Compare } {
  const p1 = parseSlice(params.get('p1'));
  const p2 = parseSlice(params.get('p2'));
  return p1 && p2 ? { compare: { p1, p2 } } : {};
}

const compareQuery = (c: Compare | null | undefined) => (c ? `&p1=${sliceKey(c.p1)}&p2=${sliceKey(c.p2)}` : '');

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
  return `#/insights/${p.section}?${withCommas(query)}${compareQuery(p.compare)}`;
}

const filterQuery = (p: InsightParams) => {
  const query = new URLSearchParams({ range: p.range });
  for (const k of FILTER_KEYS) if (p.filters[k]) query.set(k, p.filters[k]);
  return query;
};

export const apiPath = (p: InsightParams) => `insights?${filterQuery(p).toString()}`;

export function compareApiPath(p: InsightParams): string {
  const query = filterQuery(p);
  query.delete('range');
  return `insights/compare?${query.toString()}${compareQuery(p.compare)}`.replace('?&', '?');
}

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
