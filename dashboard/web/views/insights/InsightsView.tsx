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
  compareApiPath,
  comparing,
  efficiencyApiPath,
  exploreApiPath,
  insightHash,
  OWN_WINDOW_SECTIONS,
  isLegacyExploreHash,
  parseInsightParams,
  writeInsightParams,
  type FilterKey,
  type InsightParams,
  type Section,
} from './params.ts';
import { ChangeImpactSection, useChangeImpact, type ChangeImpactProps } from './change-impact.tsx';
import { CompareExploreSection, ExploreSection } from './explore.tsx';
import {
  CompareCostSection,
  CompareEfficiencySection,
  CompareQualitySection,
  CompareThroughputSection,
  CompareTimeSection,
  CompareTokensSection,
  CostSection,
  EFFORT_CAPTION,
  EfficiencySection,
  QualitySection,
  TASK_LEVEL_CAPTION,
  ThroughputSection,
  TimeSection,
  TokensSection,
} from './sections.tsx';
import { CompareSummary, CompareToggle, PeriodPickers } from './compare.tsx';
import type { Compare } from './compare.ts';
import type { Comparison, Efficiency, EfficiencyComparison, Explore, ExploreComparison, Insights } from './types.ts';

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

function FilterBar({ params, data, cmp }: { params: InsightParams; data: Insights | undefined; cmp: Comparison | undefined }) {
  const set = (patch: Partial<InsightParams>) => writeInsightParams({ ...params, ...patch });
  const setFilter = (key: FilterKey) => (value: string) => set({ filters: { ...params.filters, [key]: value } });
  const withCurrent = (list: string[], current: string) => [ANY, ...[...new Set([...list, ...(current ? [current] : [])])].map((v) => [v, v] as const)];
  const n = activeFilterCount(params);
  const taskLevel = TASK_LEVEL_SECTIONS.has(params.section);
  const agentLevelSet = AGENT_LEVEL_FILTERS.some((k) => params.filters[k] !== '');
  const options = (cmp ?? data)?.options;
  const maxTask = options?.max_task_id;
  const on = comparing(params) && params.compare ? params.compare : null;
  return (
    <div className="space-y-2">
      <div className={`flex flex-wrap gap-3 ${on ? 'items-start' : 'items-center'}`}>
        <CompareToggle params={params} maxTask={maxTask} />
        {on ? (
          <PeriodPickers params={params} compare={on} maxTask={maxTask} />
        ) : (
          <Select label="Period" value={params.range} options={RANGES} onChange={(v) => set({ range: v as InsightParams['range'] })} />
        )}
        {params.section === 'tokens' && <Select label="Metric" value={params.metric} options={METRICS} onChange={(v) => set({ metric: v as InsightParams['metric'] })} />}
      </div>
      {on && cmp && <CompareSummary cmp={cmp} compare={on} />}
      <Disclosure summary={<span className="tabular-nums">Filters ({n})</span>} defaultOpen={n > 0}>
        <div className="flex min-h-(--control-medium-size) flex-wrap gap-3">
          <Select label={FILTER_LABELS.repo} value={params.filters.repo} options={withCurrent(options?.repos ?? [], params.filters.repo)} onChange={setFilter('repo')} />
          {!taskLevel && <Select label={FILTER_LABELS.agent} value={params.filters.agent} options={AGENT_OPTIONS} onChange={setFilter('agent')} />}
          {!taskLevel && <Select label={FILTER_LABELS.model} value={params.filters.model} options={withCurrent(options?.models ?? [], params.filters.model)} onChange={setFilter('model')} />}
          <Select label={FILTER_LABELS.effort} value={params.filters.effort} options={EFFORT_OPTIONS} onChange={setFilter('effort')} />
        </div>
        {taskLevel && agentLevelSet && <p className="mt-2 text-xs text-fg-muted">{TASK_LEVEL_CAPTION}</p>}
        <p className="mt-2 text-xs text-fg-muted">{EFFORT_CAPTION}</p>
      </Disclosure>
    </div>
  );
}

interface SectionQueries {
  explore?: Query<Explore> | undefined;
  exploreCmp?: Query<ExploreComparison> | undefined;
  efficiency?: Query<Efficiency> | undefined;
  efficiencyCmp?: Query<EfficiencyComparison> | undefined;
  changeImpact?: ChangeImpactProps | undefined;
}

function SectionView({ data, params, explore, efficiency }: { data: Insights; params: InsightParams } & SectionQueries) {
  switch (params.section) {
    case 'explore': return <ExploreSection data={data} params={params} explore={explore} />;
    case 'cost': return <CostSection data={data} params={params} />;
    case 'time': return <TimeSection data={data} params={params} />;
    case 'quality': return <QualitySection data={data} params={params} />;
    case 'efficiency': return <EfficiencySection efficiency={efficiency} />;
    case 'throughput': return <ThroughputSection data={data} params={params} />;
    default: return <TokensSection data={data} params={params} />;
  }
}

function CompareSectionView({ exploreCmp, efficiencyCmp, ...props }: { cmp: Comparison; params: InsightParams; compare: Compare } & Pick<SectionQueries, 'exploreCmp' | 'efficiencyCmp'>) {
  switch (props.params.section) {
    case 'explore': return <CompareExploreSection params={props.params} compare={props.compare} priced={props.cmp.p1.cost.priced} explore={exploreCmp} />;
    case 'efficiency': return <CompareEfficiencySection compare={props.compare} efficiency={efficiencyCmp} />;
    case 'cost': return <CompareCostSection {...props} />;
    case 'time': return <CompareTimeSection {...props} />;
    case 'quality': return <CompareQualitySection {...props} />;
    case 'throughput': return <CompareThroughputSection {...props} />;
    default: return <CompareTokensSection {...props} />;
  }
}

const NO_CHANGE_IMPACT: ChangeImpactProps = { list: { error: null }, source: '', selected: null, onSource: () => {}, onSelect: () => {} };

export function InsightsLayout({ params, q, explore, exploreCmp, efficiency, efficiencyCmp, cmp, changeImpact }: { params: InsightParams; q: Query<Insights>; cmp?: Query<Comparison> } & SectionQueries) {
  const items = SECTIONS.map(([key, label]) => ({ key, label, href: insightHash({ ...params, section: key }) }));
  const compare = comparing(params) && cmp ? params.compare : null;
  const own = OWN_WINDOW_SECTIONS.has(params.section);
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[12rem_minmax(0,1fr)]">
      <NavList label="Insights sections" items={items} current={params.section} className="max-md:hidden" />
      <div className="min-w-0 space-y-4">
        <div className="md:hidden">
          <Select label="Section" value={params.section} options={SECTIONS} onChange={(v) => writeInsightParams({ ...params, section: v as Section })} />
        </div>
        {!own && <FilterBar params={params} data={q.data} cmp={compare ? cmp?.data : undefined} />}
        {own ? (
          <ChangeImpactSection {...(changeImpact ?? NO_CHANGE_IMPACT)} />
        ) : compare && cmp ? (
          <Loading q={cmp}>
            {(data) => <CompareSectionView cmp={data} params={params} compare={compare} exploreCmp={exploreCmp} efficiencyCmp={efficiencyCmp} />}
          </Loading>
        ) : (
          <Loading q={q}>{(data) => <SectionView data={data} params={params} explore={explore} efficiency={efficiency} />}</Loading>
        )}
      </div>
    </div>
  );
}

const isComparison = (d: Explore | ExploreComparison): d is ExploreComparison => 'bro_excluded' in d;

// One query per path keeps the last body on screen while the next loads; a
// body of the other mode, kept across the Compare toggle, is not shown.
function ExploreView({ params, q, cmp }: { params: InsightParams; q: Query<Insights>; cmp?: Query<Comparison> | undefined }) {
  const res = useApi<Explore | ExploreComparison>(exploreApiPath(params), { keepPrevious: true });
  if (comparing(params)) {
    const data = res.data && isComparison(res.data) ? res.data : undefined;
    return <InsightsLayout params={params} q={q} cmp={cmp} exploreCmp={{ data, error: res.error }} />;
  }
  const data = res.data && !isComparison(res.data) ? res.data : undefined;
  return <InsightsLayout params={params} q={q} explore={{ data, error: res.error }} />;
}

const isEfficiencyComparison = (d: Efficiency | EfficiencyComparison): d is EfficiencyComparison => 'p1' in d;

function EfficiencyView({ params, q, cmp }: { params: InsightParams; q: Query<Insights>; cmp?: Query<Comparison> | undefined }) {
  const res = useApi<Efficiency | EfficiencyComparison>(efficiencyApiPath(params), { keepPrevious: true });
  if (comparing(params)) {
    const data = res.data && isEfficiencyComparison(res.data) ? res.data : undefined;
    return <InsightsLayout params={params} q={q} cmp={cmp} efficiencyCmp={{ data, error: res.error }} />;
  }
  const data = res.data && !isEfficiencyComparison(res.data) ? res.data : undefined;
  return <InsightsLayout params={params} q={q} efficiency={{ data, error: res.error }} />;
}

function ChangeImpactView({ params, q }: { params: InsightParams; q: Query<Insights> }) {
  return <InsightsLayout params={params} q={q} changeImpact={useChangeImpact()} />;
}

export function InsightsView() {
  const params = useInsightParams();
  const on = comparing(params);
  const own = OWN_WINDOW_SECTIONS.has(params.section);
  const q = useApi<Insights>(apiPath(params), { keepPrevious: true, enabled: !on && !own });
  const cmp = useApi<Comparison>(compareApiPath(params), { keepPrevious: true, enabled: on });
  if (own) return <ChangeImpactView params={params} q={q} />;
  if (params.section === 'explore') return <ExploreView params={params} q={q} cmp={on ? cmp : undefined} />;
  if (params.section === 'efficiency') return <EfficiencyView params={params} q={q} cmp={on ? cmp : undefined} />;
  return <InsightsLayout params={params} q={q} cmp={on ? cmp : undefined} />;
}
