import type { AgentKey } from './types.ts';

export const AGENT_COLOR: Record<AgentKey, string> = {
  swe: 'var(--data-green-color-emphasis)',
  reviewer: 'var(--data-orange-color-emphasis)',
  bro: 'var(--data-blue-color-emphasis)',
};

export const THROUGHPUT_COLOR = 'var(--data-purple-color-emphasis)';

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const PLAIN = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

export const compact = (n: number | null) => (n === null ? '—' : COMPACT.format(n));
export const plain = (n: number | null) => (n === null ? '—' : PLAIN.format(n));
export const usd = (n: number) => USD.format(n);
export const pct = (n: number | null) => (n === null ? '—' : `${PLAIN.format(n * 100)}%`);
export const ratio = (passed: number, total: number) => (total === 0 ? null : passed / total);

export function duration(ms: number | null): string {
  if (ms === null) return '—';
  const s = ms / 1000;
  if (s < 60) return `${PLAIN.format(s)}s`;
  if (s < 3600) return `${PLAIN.format(s / 60)}m`;
  return `${PLAIN.format(s / 3600)}h`;
}

export function shortDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
