import type { ReactNode } from 'react';
import { FIELD } from '../../shared/classes.ts';
import { Loading } from '../../shared/Loading.tsx';
import { Flash } from '../../ui/Flash.tsx';
import { ChartCard } from './ChartCard.tsx';
import { BarList, niceAxis, type Column } from './charts.tsx';
import type { TableData } from './csv.ts';
import { AGENT_COLOR, SERIES_COLOR, compact, duration, durationTicks, pct, plain, usd } from './format.ts';
import { AGGS, DIMS, MEASURES, RANGES, pivotAgg, writeInsightParams, type AggKey, type DimKey, type InsightParams, type MeasureKey } from './params.ts';
import type { AgentKey, Explore, ExploreGroup, Insights } from './types.ts';

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

function valueText(g: ExploreGroup, agg: AggKey, fmt: (v: number) => string): string {
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

function ExploreChart({ ex, params }: { ex: Explore; params: InsightParams }) {
  const agg = pivotAgg(params);
  const fmt = formatOf(params.measure, agg);
  const axis = params.measure === 'duration_ms' && agg !== 'count' ? (max: number) => durationTicks(max) : niceAxis(fmt);
  const what = `${labelOf(AGGS, agg)} ${labelOf(MEASURES, params.measure).toLowerCase()}`;
  const title = `${labelOf(AGGS, agg)} ${labelOf(MEASURES, params.measure)} by ${params.dims.map((d) => labelOf(DIMS, d)).join(' Then ')}`;
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

export function ExploreSection({ data, params, explore }: { data: Insights; params: InsightParams; explore?: { data?: Explore; error: Error | null } }) {
  const priced = data.cost.priced;
  return (
    <div className="space-y-4">
      <h2 className="border-b border-(--borderColor-muted) pb-2 text-base font-semibold text-fg">Explore</h2>
      <Pivot params={params} priced={priced} />
      {params.measure === 'cost' && !priced ? (
        <Flash>{COST_HELP}</Flash>
      ) : (
        <Loading q={explore ?? { error: null }}>{(ex) => <ExploreChart ex={ex} params={params} />}</Loading>
      )}
    </div>
  );
}
