import type { AgentKey } from './types.ts';

export const AGENT_COLOR: Record<AgentKey, string> = {
  swe: 'var(--data-pink-color-emphasis)',
  'code-reviewer': 'var(--data-orange-color-emphasis)',
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

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DURATION_STEPS = [SECOND, 5 * SECOND, 10 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR];

export interface Tick {
  at: number;
  label: string;
}

function durationLabel(ms: number, step: number): string {
  if (ms === 0) return '0';
  if (step >= HOUR) return `${ms / HOUR}h`;
  if (step >= MINUTE) return `${ms / MINUTE}m`;
  return `${ms / SECOND}s`;
}

// A nice duration axis over [0, maxMs]: the smallest step from 1s to 2h (then
// a multiple of 2h) that covers maxMs in at most `count` steps, integer labels.
export function durationTicks(maxMs: number, count = 4): { top: number; ticks: Tick[] } {
  const max = Math.max(SECOND, maxMs);
  const step = DURATION_STEPS.find((s) => Math.ceil(max / s) <= count) ?? 2 * HOUR * Math.ceil(max / (2 * HOUR * count));
  const top = Math.ceil(max / step) * step;
  const ticks: Tick[] = [];
  for (let at = 0; at <= top; at += step) ticks.push({ at, label: durationLabel(at, step) });
  return { top, ticks };
}

export function shortDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
