import { useState } from 'react';
import type { ChangeImpact, ChangeImpactList, ChangeRef, MetricImpact, Verdict } from '../../../../mcp/trajectory-server/src/change-impact/index.ts';
import { useApi, type Row } from '../../api.ts';
import { DataTable, type Column } from '../../DataTable.tsx';
import { FIELD } from '../../shared/classes.ts';
import { Loading } from '../../shared/Loading.tsx';
import { changeImpactApiPath } from './params.ts';

type Query<T> = { data?: T; error: Error | null };

export const CHANGE_IMPACT_TITLE = 'Change impact';
export const CHANGE_IMPACT_SUBTITLE = 'Agent metrics in the runs before and after each change, within 14 days of it. Click a change for its numbers.';
export const CHANGE_IMPACT_EMPTY = 'No changes yet: runs need a plugin version, or a registered repo needs a commit to the agent surface.';
export const NO_SHIFT = 'no significant shift';
export const ALL_SOURCES = 'All';
export const VERDICT_TEXT: Record<Verdict, string> = {
  improved: 'improved',
  regressed: 'regressed',
  no_change: 'no change',
  not_enough_data: 'not enough data',
};

const NUMERIC = 'whitespace-nowrap tabular-nums';
const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const NUMBER = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 });

const num = (v: number | null) => (v === null ? '—' : NUMBER.format(v));
const ci = (v: [number, number] | null) => (v === null ? '—' : `${num(v[0])} – ${num(v[1])}`);
export const localDateTime = (at: string) => DATE_TIME.format(new Date(at));

const isShift = (m: MetricImpact) => m.verdict === 'improved' || m.verdict === 'regressed';
export const shiftsOf = (c: ChangeImpact) => c.metrics.filter(isShift).map((m) => `${m.label} ${VERDICT_TEXT[m.verdict]}`);

const changeKey = (r: ChangeRef) => `${r.source}:${r.id}`;

const LIST_COLUMNS: Column[] = [
  { key: 'label', header: 'Change', truncate: true },
  { key: 'source', header: 'Source' },
  { key: 'at', header: 'At', cell: (r) => <span className={NUMERIC}>{localDateTime(String(r['at']))}</span> },
  { key: 'kind', header: 'Kind' },
  {
    key: 'shifts',
    header: 'Significant shifts',
    cell: (r) => {
      const shifts = r['shifts'] as string[];
      return shifts.length === 0 ? <span className="text-fg-muted">{NO_SHIFT}</span> : shifts.join(', ');
    },
  },
  { key: 'measured_together', header: 'Measured together', title: 'Other changes no run separates from this one', cell: (r) => <span className={NUMERIC}>{String(r['measured_together'])}</span> },
];

const listRows = (changes: ChangeImpact[]): Row[] =>
  changes.map((c) => ({ ...c, key: changeKey(c), shifts: shiftsOf(c), measured_together: c.measured_with.length }) as unknown as Row);

const numCell = (key: string) => (r: Row) => <span className={NUMERIC}>{num(r[key] as number | null)}</span>;

const METRIC_COLUMNS: Column[] = [
  { key: 'label', header: 'Metric' },
  { key: 'n_before', header: 'n before', cell: numCell('n_before') },
  { key: 'n_after', header: 'n after', cell: numCell('n_after') },
  { key: 'median_before', header: 'Median before', cell: numCell('median_before') },
  { key: 'median_after', header: 'Median after', cell: numCell('median_after') },
  { key: 'ratio_of_medians', header: 'Ratio', title: 'Median after / median before', cell: numCell('ratio_of_medians') },
  { key: 'ratio_ci', header: '95% CI', cell: (r) => <span className={NUMERIC}>{ci(r['ratio_ci'] as [number, number] | null)}</span> },
  { key: 'p_holm', header: 'p (Holm)', title: 'Mann-Whitney p, Holm-corrected across the metrics', cell: numCell('p_holm') },
  { key: 'verdict', header: 'Verdict', cell: (r) => VERDICT_TEXT[r['verdict'] as Verdict] },
];

const metricRows = (metrics: MetricImpact[]): Row[] =>
  metrics.map((m) => ({
    label: m.label,
    n_before: m.before.n,
    n_after: m.after.n,
    median_before: m.before.median,
    median_after: m.after.median,
    ratio_of_medians: m.ratio_of_medians,
    ratio_ci: m.ratio_ci,
    p_holm: m.p_holm,
    verdict: m.verdict,
  }));

function SourceSelect({ sources, value, onChange }: { sources: string[]; value: string; onChange: (v: string) => void }) {
  const options = [...new Set([...sources, ...(value ? [value] : [])])];
  return (
    <label className="flex min-w-0 items-center gap-2 text-sm text-fg-muted">
      Source
      <select className={`${FIELD} w-auto py-1.5`} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{ALL_SOURCES}</option>
        {options.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
    </label>
  );
}

function ChangeDetail({ change }: { change: ChangeImpact }) {
  return (
    <section className="space-y-2" aria-label={`Change ${change.label}`}>
      <h3 className="text-sm font-semibold text-fg">{change.label}</h3>
      <p className="text-xs text-fg-muted">
        {change.source} · {change.kind} · {localDateTime(change.at)}
      </p>
      <DataTable rows={metricRows(change.metrics)} columns={METRIC_COLUMNS} filter={false} />
      <MeasuredWith refs={change.measured_with} />
    </section>
  );
}

function MeasuredWith({ refs }: { refs: ChangeRef[] }) {
  if (refs.length === 0) return <p className="text-xs text-fg-muted">Measured with: no other change.</p>;
  return (
    <p className="text-xs text-fg-muted">
      Measured with: {refs.map(changeKey).join(', ')}. No run separates these changes from this one, so their effects cannot be told apart.
    </p>
  );
}

export interface ChangeImpactProps {
  list: Query<ChangeImpactList>;
  detail?: Query<ChangeImpact> | undefined;
  source: string;
  selected: ChangeRef | null;
  onSource: (source: string) => void;
  onSelect: (ref: ChangeRef) => void;
}

export function ChangeImpactSection({ list, detail, source, selected, onSource, onSelect }: ChangeImpactProps) {
  return (
    <div className="space-y-4">
      <h2 className="border-b border-(--borderColor-muted) pb-2 text-base font-semibold text-fg">{CHANGE_IMPACT_TITLE}</h2>
      <p className="text-sm text-fg-muted">{CHANGE_IMPACT_SUBTITLE}</p>
      <Loading q={list}>
        {(l) => (
          <>
            <SourceSelect sources={l.sources} value={source} onChange={onSource} />
            {l.changes.length === 0 ? (
              <p className="text-sm text-fg-muted">{CHANGE_IMPACT_EMPTY}</p>
            ) : (
              <DataTable
                rows={listRows(l.changes)}
                columns={LIST_COLUMNS}
                filter={false}
                onRowClick={(r) => onSelect({ source: r['source'] as ChangeRef['source'], id: String(r['id']) })}
              />
            )}
          </>
        )}
      </Loading>
      {selected && <Loading q={detail ?? { error: null }}>{(c) => <ChangeDetail change={c} />}</Loading>}
    </div>
  );
}

export function useChangeImpact(): ChangeImpactProps {
  const [source, setSource] = useState('');
  const [selected, setSelected] = useState<ChangeRef | null>(null);
  const list = useApi<ChangeImpactList>(changeImpactApiPath(source), { keepPrevious: true });
  const detail = useApi<ChangeImpact>(changeImpactApiPath(selected?.source ?? '', selected?.id ?? ''), { enabled: selected !== null });
  return {
    list,
    detail,
    source,
    selected,
    onSource: (s) => {
      setSource(s);
      setSelected(null);
    },
    onSelect: setSelected,
  };
}
