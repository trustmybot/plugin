import { useState } from 'react';
import type { Row } from '../../api.ts';
import { ChartCard } from '../insights/ChartCard.tsx';
import { BarList, Donut, niceAxis, segmentShare, type Column } from '../insights/charts.tsx';
import type { TableData } from '../insights/csv.ts';
import { MIN_CLOSED, formatHours, labelStats, type LabelStatsData } from './label-stats.ts';

const OPEN = 'var(--fgColor-open)';
const CLOSED = 'var(--fgColor-done)';
const CO_LABEL = 'var(--fgColor-accent)';
const WIDE = '(min-width: 640px)';

const startsOpen = () => typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia(WIDE).matches;

const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'label';

const issues = (n: number) => `${n} ${n === 1 ? 'issue' : 'issues'}`;

const mergedPrs = (n: number) => `${n} merged ${n === 1 ? 'PR' : 'PRs'}`;

export function statusTable({ open, closed }: Pick<LabelStatsData, 'open' | 'closed'>): TableData {
  const total = open + closed;
  return {
    columns: ['Status', 'Count', '%'],
    rows: [
      ['Open', open, segmentShare(open, total)],
      ['Closed', closed, segmentShare(closed, total)],
    ],
  };
}

function Tile({ term, value, hint, primary = false }: { term: string; value: string; hint?: string; primary?: boolean }) {
  return (
    <div className="rounded-md border border-(--borderColor-muted) px-3 py-2" data-tile="">
      <dt className="text-xs text-fg-muted">{term}</dt>
      <dd className={`${primary ? 'text-2xl' : 'text-base'} font-semibold text-fg tabular-nums`}>{value}</dd>
      {hint && <dd className="text-xs text-fg-muted">{hint}</dd>}
    </div>
  );
}

export function LabelStats({ rows, label }: { rows: Row[]; label: string }) {
  const [open, setOpen] = useState(startsOpen);
  const s = labelStats(rows, label);
  const total = s.open + s.closed;
  const range = slug(label);
  const coRows: Column[] = s.coLabels.map((c) => {
    const note = `${c.open} open · ${c.closed} closed`;
    return { key: c.label, label: c.label, value: c.open + c.closed, color: CO_LABEL, note, aria: `${c.label}: ${note}`, tip: `${c.label}: ${note}` };
  });
  const few = `fewer than ${MIN_CLOSED} closed`;
  const prHint = s.prMedianHours === null ? `${mergedPrs(s.mergedPrCount)}, fewer than ${MIN_CLOSED}` : mergedPrs(s.mergedPrCount);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="rounded-md border border-(--borderColor-default)" data-label-stats="">
      <summary className="cursor-pointer px-4 py-2 text-sm font-semibold text-fg focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color)">
        Label stats: {label} <span className="font-normal text-fg-muted">· {issues(total)}</span>
      </summary>
      <div className="grid grid-cols-1 gap-4 border-t border-(--borderColor-muted) p-4 lg:grid-cols-3">
        <ChartCard
          title="Open vs Closed"
          subtitle={issues(total)}
          section="issues-status"
          range={range}
          table={statusTable(s)}
        >
          <Donut
            label={`${label}: ${s.open} open, ${s.closed} closed`}
            totalLabel="issues"
            segments={[
              { key: 'open', label: 'Open', value: s.open, color: OPEN },
              { key: 'closed', label: 'Closed', value: s.closed, color: CLOSED },
            ]}
          />
        </ChartCard>
        <ChartCard
          title="Co-labels"
          subtitle="Other labels on these issues"
          section="issues-co-labels"
          range={range}
          table={{ columns: ['Label', 'Open', 'Closed', 'Total'], rows: s.coLabels.map((c) => [c.label, c.open, c.closed, c.open + c.closed]) }}
        >
          {coRows.length === 0 ? (
            <p className="text-sm text-fg-muted">No other labels on these issues.</p>
          ) : (
            <BarList label={`Co-labels of ${label}: ${coRows.map((r) => r.aria).join('; ')}`} rows={coRows} format={(v) => String(v)} axis={niceAxis((v) => String(v))} />
          )}
        </ChartCard>
        <ChartCard
          title="Time to Close"
          subtitle="Hours from opened to closed or merged"
          section="issues-close-time"
          range={range}
          table={{
            columns: ['Metric', 'Value'],
            rows: [
              ['Median', formatHours(s.medianHours)],
              ['Mean', formatHours(s.meanHours)],
              ['Closed', s.closedCount],
              ['PR merge median', formatHours(s.prMedianHours)],
              ['PR merge mean', formatHours(s.prMeanHours)],
              ['Merged PRs', s.mergedPrCount],
            ],
          }}
        >
          <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-1">
            <Tile term="Median" value={formatHours(s.medianHours)} hint={s.medianHours === null ? few : undefined} primary />
            <Tile term="Mean" value={formatHours(s.meanHours)} hint={s.meanHours === null ? few : 'Skewed by outliers'} />
            <Tile term="Closed" value={String(s.closedCount)} />
            <Tile term="PR merge median" value={formatHours(s.prMedianHours)} hint={prHint} />
            <Tile term="PR merge mean" value={formatHours(s.prMeanHours)} hint={prHint} />
          </dl>
        </ChartCard>
      </div>
    </details>
  );
}
