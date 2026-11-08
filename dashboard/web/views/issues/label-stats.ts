import type { Row } from '../../api.ts';
import { parseLabels } from './labels.tsx';

export const CO_LABEL_TOP = 8;
export const MIN_CLOSED = 3;
const HOUR_MS = 3_600_000;

export interface CoLabel {
  label: string;
  open: number;
  closed: number;
}

export interface LabelStatsData {
  open: number;
  closed: number;
  coLabels: CoLabel[];
  closedCount: number;
  medianHours: number | null;
  meanHours: number | null;
  mergedPrCount: number;
  prMedianHours: number | null;
  prMeanHours: number | null;
}

export const isOpen = (issue: Row) => issue['status'] === 'open';

export const hasLabel = (issue: Row, label: string) => parseLabels(issue['labels']).includes(label);

export function labelsByCount(rows: Row[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) for (const l of new Set(parseLabels(r['labels']))) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function closeHours(issue: Row): number | null {
  const created = Date.parse(String(issue['created_at'] ?? ''));
  const closed = Date.parse(String(issue['closed_at'] ?? ''));
  if (Number.isNaN(created) || Number.isNaN(closed) || closed < created) return null;
  return (closed - created) / HOUR_MS;
}

function issuePrs(issue: Row): Array<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(String(issue['prs'] ?? '[]'));
    return Array.isArray(parsed) ? parsed.filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object') : [];
  } catch {
    return [];
  }
}

// Open-to-merge hours of every merged PR closing a matching issue, each PR
// counted once (by repo and number) however many matching issues it closes.
function mergeHours(matching: Row[]): number[] {
  const byPr = new Map<string, number>();
  for (const issue of matching) {
    for (const pr of issuePrs(issue)) {
      const created = Date.parse(String(pr['created_at'] ?? ''));
      const merged = Date.parse(String(pr['merged_at'] ?? ''));
      if (Number.isNaN(created) || Number.isNaN(merged) || merged < created) continue;
      byPr.set(`${String(issue['repo'] ?? '')}#${String(pr['number'])}`, (merged - created) / HOUR_MS);
    }
  }
  return [...byPr.values()];
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function coLabels(matching: Row[], label: string): CoLabel[] {
  const by = new Map<string, CoLabel>();
  for (const r of matching) {
    const open = isOpen(r);
    for (const l of new Set(parseLabels(r['labels']))) {
      if (l === label) continue;
      const c = by.get(l) ?? { label: l, open: 0, closed: 0 };
      if (open) c.open += 1;
      else c.closed += 1;
      by.set(l, c);
    }
  }
  const total = (c: CoLabel) => c.open + c.closed;
  const ranked = [...by.values()].sort((a, b) => total(b) - total(a) || a.label.localeCompare(b.label));
  const rest = ranked.slice(CO_LABEL_TOP);
  if (rest.length === 0) return ranked;
  const other = rest.reduce((o, c) => ({ label: 'Other', open: o.open + c.open, closed: o.closed + c.closed }), { label: 'Other', open: 0, closed: 0 });
  return [...ranked.slice(0, CO_LABEL_TOP), other];
}

export function labelStats(matching: Row[], label: string): LabelStatsData {
  const closedRows = matching.filter((r) => !isOpen(r));
  const hours = closedRows.map(closeHours).filter((h): h is number => h !== null);
  const enough = hours.length >= MIN_CLOSED;
  const prHours = mergeHours(matching);
  const enoughPrs = prHours.length >= MIN_CLOSED;
  return {
    open: matching.length - closedRows.length,
    closed: closedRows.length,
    coLabels: coLabels(matching, label),
    closedCount: closedRows.length,
    medianHours: enough ? median(hours) : null,
    meanHours: enough ? mean(hours) : null,
    mergedPrCount: prHours.length,
    prMedianHours: enoughPrs ? median(prHours) : null,
    prMeanHours: enoughPrs ? mean(prHours) : null,
  };
}

export const formatHours = (h: number | null) => (h === null ? '—' : `${h < 10 ? h.toFixed(1) : Math.round(h).toLocaleString('en-US')} h`);