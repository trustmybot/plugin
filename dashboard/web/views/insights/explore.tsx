import type { ReactNode } from 'react';
import { FIELD } from '../../shared/classes.ts';
import { Loading } from '../../shared/Loading.tsx';
import { Flash } from '../../ui/Flash.tsx';
import { ChartCard } from './ChartCard.tsx';
import { BarList, PairedBarList, niceAxis, type Column, type PairedRow } from './charts.tsx';
import { compareSlug, delta, type Compare, type DeltaMeasure } from './compare.ts';
import { DeltaLabel } from './compare.tsx';
import type { TableData } from './csv.ts';
import { AGENT_COLOR, SERIES_COLOR, compact, duration, durationTicks, pct, plain, usd } from './format.ts';
import {
  AGGS,
  CHANGE_HEADER,
  COMPARE_SUBTITLE,
  DIMS,
  MEASURES,
  RANGES,
  pairText,
  periodRuns,
  periodValue,
  pivotAgg,
  writeInsightParams,
  type AggKey,
  type DimKey,
  type InsightParams,
  type MeasureKey,
} from './params.ts';
import { BothEmpty, CompareCaption, LEGEND_COLOR, OneEmpty, broNote, periodLegend, polarityCaption } from './sections.tsx';
import type { AgentKey, Explore, ExploreComparison, ExploreGroup, ExploreSide, Insights } from './types.ts';

export const CACHE_HIT_HELP = "Cache-hit % is a ratio, so it can't be summed.";
export const COST_HELP = 'Cost is off until model prices are set.';
export const NEEDS_RUNS = 'needs 20 runs';
export const ESTIMATED_TIP = 'Version estimated from the run date';
export const OTHER = 'Other';
export const OTHER_COLOR = 'var(--fgColor-muted)';
const EARLY_MIN = 20;
const ESTIMATED = '≈ ';
const SELECT = `${FIELD} w-auto py-1.5 max-sm:w-full`;

export const mismatchNote = (k: number) =>
  `${k} ${k === 1 ? 'task has' : 'tasks have'} a different review count than their recorded attempts, so round numbers may be off.`;

const runs = (n: number) => `${n} ${n === 1 ? 'run' : 'runs'}`;
const labelOf = <T extends string>(list: ReadonlyArray<readonly [T, string]>, key: string) => list.find(([k]) => k === key)?.[1] ?? key;

const MEASURE_FORMAT: Record<MeasureKey, (v: number) => string> = {
  tokens_out: compact,
  context: compact,
  cache_hit: pct,
  cost: usd,
  duration_ms: duration,
  tool_uses: plain,
};

const formatOf = (measure: MeasureKey, agg: AggKey) => (agg === 'count' ? plain : MEASURE_FORMAT[measure]);

function colorOf(dim: DimKey, value: string): string {
  if (value === OTHER) return OTHER_COLOR;
  if (dim === 'agent' && Object.hasOwn(AGENT_COLOR, value)) return AGENT_COLOR[value as AgentKey];
  return SERIES_COLOR;
}

function valueText(g: ExploreSide, agg: AggKey, fmt: (v: number) => string): string {
  if (g.value !== null) return fmt(g.value);
  return (agg === 'p50' || agg === 'p95') && g.n < EARLY_MIN ? NEEDS_RUNS : '—';
}

export function exploreTable(ex: Explore, params: InsightParams): TableData {
  const agg = pivotAgg(params);
  const fmt = formatOf(params.measure, agg);
  return {
    columns: [...params.dims.map((d) => labelOf(DIMS, d)), 'Runs', `${labelOf(AGGS, agg)} ${labelOf(MEASURES, params.measure)}`],
    rows: ex.groups.map((g) => [...g.key, g.n, valueText(g, agg, fmt)]),
  };
}

// Count and sum grow with the number of runs, so their change is neither good nor bad.
const deltaMeasureOf = (measure: MeasureKey, agg: AggKey): DeltaMeasure => (agg === 'count' || agg === 'sum' ? 'count' : measure);

const sideText = (s: ExploreSide, agg: AggKey, fmt: (v: number) => string) => (s.n === 0 ? '—' : valueText(s, agg, fmt));

const compareColumns = (params: InsightParams, header: string) => [
  ...params.dims.map((d) => labelOf(DIMS, d)),
  periodRuns(1, 'run'),
  periodValue(1, header),
  periodRuns(2, 'run'),
  periodValue(2, header),
  CHANGE_HEADER,
];

export function exploreCompareTable(ex: ExploreComparison, params: InsightParams): TableData {
  const { agg, fmt, header, what } = pivotCopy(params);
  const measure = deltaMeasureOf(params.measure, agg);
  return {
    columns: compareColumns(params, header),
    rows: ex.groups.map((g) => [
      ...g.key,
      g.p1.n,
      sideText(g.p1, agg, fmt),
      g.p2.n,
      sideText(g.p2, agg, fmt),
      delta(measure, `${g.key.join(', ')} ${what}`, g.p1.value, g.p2.value).text,
    ]),
  };
}

function PivotSelect({ name, lead, value, options, disabled, onChange }: {
  name: string;
  lead?: string;
  value: string;
  options: ReadonlyArray<readonly [string, string]>;
  disabled?: ReadonlySet<string>;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex min-w-0 items-center gap-2 text-sm text-fg-muted max-sm:w-full">
      {lead && <span aria-hidden="true">{lead}</span>}
      <span className="sr-only">{name}</span>
      <select className={SELECT} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, text]) => (
          <option key={v} value={v} disabled={disabled?.has(v)}>{text}</option>
        ))}
      </select>
    </label>
  );
}

function Pivot({ params, priced }: { params: InsightParams; priced: boolean }) {
  const set = (patch: Partial<InsightParams>) => writeInsightParams({ ...params, ...patch });
  const [first, second] = params.dims as [DimKey, DimKey | undefined];
  const cacheHit = params.measure === 'cache_hit';
  const setMeasure = (v: string) => set({ measure: v as MeasureKey });
  const setFirst = (v: string) => set({ dims: [v as DimKey, ...(second && second !== v ? [second] : [])] });
  const setSecond = (v: string) => set({ dims: v ? [first, v as DimKey] : [first] });
  return (
    <div className="space-y-1">
      <div role="group" aria-label="Pivot" className="flex flex-wrap items-center gap-2 max-sm:flex-col max-sm:items-stretch">
        <PivotSelect
          name="Aggregate"
          value={pivotAgg(params)}
          options={AGGS}
          disabled={cacheHit ? new Set(AGGS.map(([k]) => k).filter((k) => k !== 'avg')) : undefined}
          onChange={(v) => set({ agg: v as AggKey })}
        />
        <PivotSelect name="Measure" lead="of" value={params.measure} options={MEASURES} disabled={priced ? undefined : new Set(['cost'])} onChange={setMeasure} />
        <PivotSelect name="Dimension" lead="by" value={first} options={DIMS} onChange={setFirst} />
        <PivotSelect name="Then by" lead="then" value={second ?? ''} options={[['', 'None'], ...DIMS]} disabled={new Set([first])} onChange={setSecond} />
      </div>
      {cacheHit && <p className="text-xs text-fg-muted">{CACHE_HIT_HELP}</p>}
      {!priced && <p className="text-xs text-fg-muted">{COST_HELP}</p>}
    </div>
  );
}

function columnOf(g: ExploreGroup, params: InsightParams, fmt: (v: number) => string, what: string): Column {
  const agg = pivotAgg(params);
  const dim = params.dims.at(-1)!;
  const name = g.key.at(-1)!;
  const text = valueText(g, agg, fmt);
  const estimated = params.dims.includes('plugin_version') && g.key.some((k) => k.startsWith(ESTIMATED)) ? ` · ${ESTIMATED_TIP}` : '';
  return {
    key: g.key.join('\u0000'),
    label: `${name} · ${runs(g.n)}`,
    value: g.value ?? 0,
    note: g.value === null ? text : undefined,
    color: colorOf(dim, name),
    aria: `${g.key.join(', ')}, ${runs(g.n)}: ${what} ${text}${estimated}`,
    tip: `${g.key.join(' · ')}: ${text}${estimated}`,
  };
}

function panelsOf(groups: ExploreGroup[]): Array<[string, ExploreGroup[]]> {
  const panels = new Map<string, ExploreGroup[]>();
  for (const g of groups) panels.set(g.key[0]!, [...(panels.get(g.key[0]!) ?? []), g]);
  return [...panels];
}

function pivotCopy(params: InsightParams) {
  const agg = pivotAgg(params);
  const fmt = formatOf(params.measure, agg);
  const axis = params.measure === 'duration_ms' && agg !== 'count' ? (max: number) => durationTicks(max) : niceAxis(fmt);
  const header = `${labelOf(AGGS, agg)} ${labelOf(MEASURES, params.measure)}`;
  const what = `${labelOf(AGGS, agg)} ${labelOf(MEASURES, params.measure).toLowerCase()}`;
  const title = `${header} by ${params.dims.map((d) => labelOf(DIMS, d)).join(' Then ')}`;
  return { agg, fmt, axis, header, what, title };
}

function ExploreChart({ ex, params }: { ex: Explore; params: InsightParams }) {
  const { agg, fmt, axis, what, title } = pivotCopy(params);
  const period = labelOf(RANGES, params.range);
  const footnotes: ReactNode[] = [];
  if (params.dims.includes('review_round') && ex.review_round_mismatch > 0) footnotes.push(mismatchNote(ex.review_round_mismatch));
  let body: ReactNode;
  if (ex.groups.length === 0) {
    body = <p className="text-sm text-fg-muted">No runs match these filters.</p>;
  } else if (params.dims.length === 1) {
    const rows = ex.groups.map((g) => columnOf(g, params, fmt, what));
    body = <BarList label={`${title}: ${rows.map((r) => r.aria).join('; ')}`} rows={rows} format={fmt} axis={axis} />;
  } else {
    const max = Math.max(0, ...ex.groups.map((g) => g.value ?? 0));
    body = (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {panelsOf(ex.groups).map(([panel, groups]) => {
          const rows = groups.map((g) => columnOf(g, params, fmt, what));
          return (
            <section key={panel} className="min-w-0 space-y-1" aria-label={panel} data-panel="">
              <h4 className="text-xs font-semibold text-fg">{panel}</h4>
              <BarList label={`${panel}: ${rows.map((r) => r.aria).join('; ')}`} rows={rows} format={fmt} axis={axis} max={max} />
            </section>
          );
        })}
      </div>
    );
  }
  return (
    <ChartCard
      title={title}
      subtitle={`${period} · ${runs(ex.groups.reduce((s, g) => s + g.n, 0))}`}
      section="explore"
      range={params.range}
      table={exploreTable(ex, params)}
      caption={footnotes.length > 0 ? footnotes : undefined}
    >
      {body}
    </ChartCard>
  );
}

function ExploreShell({ params, priced, children }: { params: InsightParams; priced: boolean; children: ReactNode }) {
  return (
    <div className="space-y-4">
      <h2 className="border-b border-(--borderColor-muted) pb-2 text-base font-semibold text-fg">Explore</h2>
      <Pivot params={params} priced={priced} />
      {params.measure === 'cost' && !priced ? <Flash>{COST_HELP}</Flash> : children}
    </div>
  );
}

export function ExploreSection({ data, params, explore }: { data: Insights; params: InsightParams; explore?: { data?: Explore; error: Error | null } }) {
  return (
    <ExploreShell params={params} priced={data.cost.priced}>
      <Loading q={explore ?? { error: null }}>{(ex) => <ExploreChart ex={ex} params={params} />}</Loading>
    </ExploreShell>
  );
}

const CELL = 'px-1 py-1 whitespace-nowrap';

function CompareExploreTable({ ex, params }: { ex: ExploreComparison; params: InsightParams }) {
  const { agg, fmt, header, what } = pivotCopy(params);
  const measure = deltaMeasureOf(params.measure, agg);
  return (
    <table className="w-full text-sm tabular-nums" data-explore-compare="">
      <thead>
        <tr className="border-b border-(--borderColor-muted) text-left text-xs text-fg-muted">
          {compareColumns(params, header).map((h) => (
            <th key={h} scope="col" className={`${CELL} font-semibold`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ex.groups.map((g) => (
          <tr key={g.key.join('\u0000')}>
            {g.key.map((k, i) => (
              <th key={i} scope="row" className={`${CELL} text-left font-normal text-fg-muted`}>
                {k}
              </th>
            ))}
            <td className={`${CELL} text-fg-muted`}>{g.p1.n}</td>
            <td className={`${CELL} text-fg`}>{sideText(g.p1, agg, fmt)}</td>
            <td className={`${CELL} text-fg-muted`}>{g.p2.n}</td>
            <td className={`${CELL} font-semibold text-fg`}>{sideText(g.p2, agg, fmt)}</td>
            <td className={CELL}>
              <DeltaLabel measure={measure} subject={`${g.key.join(', ')} ${what}`} p1={g.p1.value} p2={g.p2.value} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CompareExploreChart({ ex, params, compare }: { ex: ExploreComparison; params: InsightParams; compare: Compare }) {
  const { agg, fmt, axis, header, what, title } = pivotCopy(params);
  const measure = deltaMeasureOf(params.measure, agg);
  const dim = params.dims.at(-1)!;
  const rows: PairedRow[] = ex.groups.map((g) => {
    const name = g.key.join(' · ');
    const subject = `${g.key.join(', ')} ${what}`;
    const d = delta(measure, subject, g.p1.value, g.p2.value);
    const text = pairText(name, sideText(g.p1, agg, fmt), sideText(g.p2, agg, fmt));
    return {
      key: g.key.join('\u0000'),
      label: name,
      color: colorOf(dim, g.key.at(-1)!),
      p1: g.p1.value,
      p2: g.p2.value,
      aria: `${text}. ${d.aria}`,
      tip: `${text}, ${d.text}`,
      deltaText: d.text,
      delta: <DeltaLabel measure={measure} subject={subject} p1={g.p1.value} p2={g.p2.value} />,
    };
  });
  return (
    <ChartCard
      title={title}
      subtitle={`${COMPARE_SUBTITLE} · ${header}`}
      section="explore"
      range={compareSlug(compare)}
      table={exploreCompareTable(ex, params)}
      legend={periodLegend(compare, LEGEND_COLOR)}
      caption={polarityCaption(measure)}
    >
      <div className="space-y-3">
        <CompareExploreTable ex={ex} params={params} />
        <PairedBarList label={`${title}: ${rows.map((r) => r.aria).join('; ')}`} rows={rows} format={fmt} axis={axis} />
      </div>
    </ChartCard>
  );
}

function CompareExploreBody({ ex, params, compare }: { ex: ExploreComparison; params: InsightParams; compare: Compare }) {
  const runs = [ex.groups.reduce((s, g) => s + g.p1.n, 0), ex.groups.reduce((s, g) => s + g.p2.n, 0)] as const;
  if (runs[0] === 0 && runs[1] === 0) return <BothEmpty params={params} compare={compare} />;
  return (
    <>
      <OneEmpty runs={runs} compare={compare} />
      <CompareExploreChart ex={ex} params={params} compare={compare} />
      <CompareCaption text={broNote({ cmp: ex, compare })} />
    </>
  );
}

export function CompareExploreSection({ params, compare, priced, explore }: {
  params: InsightParams;
  compare: Compare;
  priced: boolean;
  explore?: { data?: ExploreComparison; error: Error | null } | undefined;
}) {
  return (
    <ExploreShell params={params} priced={priced}>
      <Loading q={explore ?? { error: null }}>{(ex) => <CompareExploreBody ex={ex} params={params} compare={compare} />}</Loading>
    </ExploreShell>
  );
}
