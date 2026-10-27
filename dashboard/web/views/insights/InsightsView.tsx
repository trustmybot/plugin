import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useApi } from '../../api.ts';
import { FIELD } from '../../shared/classes.ts';
import { Loading } from '../../shared/Loading.tsx';
import { currentHash, subscribeHash } from '../../shared/route.ts';
import { Disclosure } from '../../ui/Disclosure.tsx';
import { NavList } from '../../ui/NavList.tsx';
import {
  AGENT_LEVEL_FILTERS,
  FILTER_LABELS,
  METRICS,
  RANGES,
  SECTIONS,
  TASK_LEVEL_SECTIONS,
  activeFilterCount,
  apiPath,
  exploreApiPath,
  insightHash,
  isLegacyExploreHash,
  parseInsightParams,
  writeInsightParams,
  type FilterKey,
  type InsightParams,
  type Section,
} from './params.ts';
import { ExploreSection } from './explore.tsx';
import { CostSection, EFFORT_CAPTION, QualitySection, TASK_LEVEL_CAPTION, ThroughputSection, TimeSection, TokensSection } from './sections.tsx';
import type { Explore, Insights } from './types.ts';

type Query<T> = { data?: T; error: Error | null };

const SELECT = `${FIELD} w-auto py-1.5`;

function useInsightParams(): InsightParams {
  const hash = useSyncExternalStore(subscribeHash, currentHash, currentHash);
  const { params, legacy } = useMemo(() => {
    const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
    const search = new URLSearchParams(query);
    return { params: parseInsightParams(path, search), legacy: isLegacyExploreHash(path, search) };
  }, [hash]);
  useEffect(() => {
    if (legacy) window.history.replaceState(null, '', insightHash(params));
  }, [legacy, params]);
  return params;
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: ReadonlyArray<readonly [string, string]>; onChange: (v: string) => void }) {
  return (
    <label className="flex min-w-0 items-center gap-2 text-sm text-fg-muted">
      {label}
      <select className={SELECT} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, text]) => (
          <option key={v} value={v}>{text}</option>
        ))}
      </select>
    </label>
  );
}

const ANY: readonly [string, string] = ['', 'Any'];
const AGENT_OPTIONS = [ANY, ['swe', 'swe'], ['code-reviewer', 'code-reviewer'], ['bro', 'bro']] as const;
const EFFORT_OPTIONS = [ANY, ['low', 'low'], ['medium', 'medium'], ['high', 'high']] as const;

function FilterBar({ params, data }: { params: InsightParams; data: Insights | undefined }) {
  const set = (patch: Partial<InsightParams>) => writeInsightParams({ ...params, ...patch });
  const setFilter = (key: FilterKey) => (value: string) => set({ filters: { ...params.filters, [key]: value } });
  const withCurrent = (list: string[], current: string) => [ANY, ...[...new Set([...list, ...(current ? [current] : [])])].map((v) => [v, v] as const)];
  const n = activeFilterCount(params);
  const taskLevel = TASK_LEVEL_SECTIONS.has(params.section);
  const agentLevelSet = AGENT_LEVEL_FILTERS.some((k) => params.filters[k] !== '');
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Select label="Period" value={params.range} options={RANGES} onChange={(v) => set({ range: v as InsightParams['range'] })} />
        {params.section === 'tokens' && <Select label="Metric" value={params.metric} options={METRICS} onChange={(v) => set({ metric: v as InsightParams['metric'] })} />}
      </div>
      <Disclosure summary={<span className="tabular-nums">Filters ({n})</span>} defaultOpen={n > 0}>
        <div className="flex min-h-(--control-medium-size) flex-wrap gap-3">
          <Select label={FILTER_LABELS.repo} value={params.filters.repo} options={withCurrent(data?.options.repos ?? [], params.filters.repo)} onChange={setFilter('repo')} />
          {!taskLevel && <Select label={FILTER_LABELS.agent} value={params.filters.agent} options={AGENT_OPTIONS} onChange={setFilter('agent')} />}
          {!taskLevel && <Select label={FILTER_LABELS.model} value={params.filters.model} options={withCurrent(data?.options.models ?? [], params.filters.model)} onChange={setFilter('model')} />}
          <Select label={FILTER_LABELS.effort} value={params.filters.effort} options={EFFORT_OPTIONS} onChange={setFilter('effort')} />
        </div>
        {taskLevel && agentLevelSet && <p className="mt-2 text-xs text-fg-muted">{TASK_LEVEL_CAPTION}</p>}
        <p className="mt-2 text-xs text-fg-muted">{EFFORT_CAPTION}</p>
      </Disclosure>
    </div>
  );
}

function SectionView({ data, params, explore }: { data: Insights; params: InsightParams; explore?: Query<Explore> }) {
  switch (params.section) {
    case 'explore': return <ExploreSection data={data} params={params} explore={explore} />;
    case 'cost': return <CostSection data={data} params={params} />;
    case 'time': return <TimeSection data={data} params={params} />;
    case 'quality': return <QualitySection data={data} params={params} />;
    case 'throughput': return <ThroughputSection data={data} params={params} />;
    default: return <TokensSection data={data} params={params} />;
  }
}

export function InsightsLayout({ params, q, explore }: { params: InsightParams; q: Query<Insights>; explore?: Query<Explore> }) {
  const items = SECTIONS.map(([key, label]) => ({ key, label, href: insightHash({ ...params, section: key }) }));
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[12rem_minmax(0,1fr)]">
      <NavList label="Insights sections" items={items} current={params.section} className="max-md:hidden" />
      <div className="min-w-0 space-y-4">
        <div className="md:hidden">
          <Select label="Section" value={params.section} options={SECTIONS} onChange={(v) => writeInsightParams({ ...params, section: v as Section })} />
        </div>
        <FilterBar params={params} data={q.data} />
        <Loading q={q}>{(data) => <SectionView data={data} params={params} explore={explore} />}</Loading>
      </div>
    </div>
  );
}

function ExploreView({ params, q }: { params: InsightParams; q: Query<Insights> }) {
  const explore = useApi<Explore>(exploreApiPath(params), { keepPrevious: true });
  return <InsightsLayout params={params} q={q} explore={explore} />;
}

export function InsightsView() {
  const params = useInsightParams();
  const q = useApi<Insights>(apiPath(params), { keepPrevious: true });
  return params.section === 'explore' ? <ExploreView params={params} q={q} /> : <InsightsLayout params={params} q={q} />;
}
