import {
  ALL_DATES,
  ALL_TASKS,
  DATE_ORDER_ERROR,
  NO_CHANGE,
  NO_BASELINE_TITLE,
  RANGES,
  PREV_RANGES,
  TASK_NUMBER_ERROR,
  TASK_ORDER_ERROR,
  datesFrom,
  datesThrough,
  deltaAria,
  noBaselineAria,
  noChangeAria,
  tasksFrom,
  tasksOne,
  tasksRange,
  tasksUpTo,
  vsPeriod1,
  type Range,
} from './params.ts';

export type PrevRange = 'prev7d' | 'prev30d' | 'prev90d';

export type Slice =
  | { kind: 'range'; range: Range }
  | { kind: 'prev'; range: PrevRange }
  | { kind: 'dates'; from: string | null; to: string | null }
  | { kind: 'tasks'; from: number | null; to: number | null };

export interface Compare {
  p1: Slice;
  p2: Slice;
}

export type PeriodN = 1 | 2;

const RANGE_KEYS: readonly string[] = ['7d', '30d', '90d', 'all'];
const PREV_KEYS: readonly string[] = ['prev7d', 'prev30d', 'prev90d'];

function utcDay(s: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

function taskBound(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

// The server's period grammar: 7d|30d|90d|all, prev7d|prev30d|prev90d,
// dates:YYYY-MM-DD..YYYY-MM-DD and tasks:N-M, either end of the last two empty.
export function parseSlice(raw: string | null): Slice | null {
  if (raw === null) return null;
  if (RANGE_KEYS.includes(raw)) return { kind: 'range', range: raw as Range };
  if (PREV_KEYS.includes(raw)) return { kind: 'prev', range: raw as PrevRange };
  const dates = /^dates:([^.]*)\.\.([^.]*)$/.exec(raw);
  if (dates) {
    const [, a = '', b = ''] = dates;
    const from = a === '' ? null : utcDay(a);
    const to = b === '' ? null : utcDay(b);
    if ((a !== '' && from === null) || (b !== '' && to === null)) return null;
    if (from && to && from > to) return null;
    return { kind: 'dates', from, to };
  }
  const tasks = /^tasks:([^-]*)-([^-]*)$/.exec(raw);
  if (tasks) {
    const [, a = '', b = ''] = tasks;
    const from = a === '' ? null : taskBound(a);
    const to = b === '' ? null : taskBound(b);
    if ((a !== '' && from === null) || (b !== '' && to === null)) return null;
    if (from !== null && to !== null && from > to) return null;
    return { kind: 'tasks', from, to };
  }
  return null;
}

export function sliceKey(s: Slice): string {
  switch (s.kind) {
    case 'range':
    case 'prev':
      return s.range;
    case 'dates':
      return `dates:${s.from ?? ''}..${s.to ?? ''}`;
    case 'tasks':
      return `tasks:${s.from ?? ''}-${s.to ?? ''}`;
  }
}

export const sameSlice = (a: Slice, b: Slice) => sliceKey(a) === sliceKey(b);

export const compareSlug = (c: Compare) => `${sliceKey(c.p1)}-vs-${sliceKey(c.p2)}`.replace(/[^a-z0-9.-]+/gi, '_');

const DAY_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

export function sliceLabel(s: Slice): string {
  switch (s.kind) {
    case 'range':
      return RANGES.find(([k]) => k === s.range)![1];
    case 'prev':
      return PREV_RANGES.find(([k]) => k === s.range)![1];
    case 'dates':
      if (s.from && s.to) return DAY_FORMAT.formatRange(day(s.from), day(s.to));
      if (s.from) return datesFrom(DAY_FORMAT.format(day(s.from)));
      if (s.to) return datesThrough(DAY_FORMAT.format(day(s.to)));
      return ALL_DATES;
    case 'tasks': {
      const from = s.from ?? 1;
      if (s.to === null) return s.from === null || s.from === 1 ? ALL_TASKS : tasksFrom(from);
      if (s.from === null) return s.to === 1 ? tasksOne(1) : tasksUpTo(s.to);
      return from === s.to ? tasksOne(from) : tasksRange(from, s.to);
    }
  }
}

// Period 2 is the last 50 tasks and Period 1 the 50 before them; under 100
// tasks the two halves. With fewer than 2 tasks there is nothing to split, so
// the periods are the last 30 days and the 30 before.
export function defaultCompare(maxTask: number | null | undefined): Compare {
  if (!maxTask || maxTask < 2) return { p1: { kind: 'prev', range: 'prev30d' }, p2: { kind: 'range', range: '30d' } };
  if (maxTask < 100) {
    const half = Math.floor(maxTask / 2);
    return { p1: { kind: 'tasks', from: 1, to: half }, p2: { kind: 'tasks', from: half + 1, to: null } };
  }
  return { p1: { kind: 'tasks', from: maxTask - 99, to: maxTask - 50 }, p2: { kind: 'tasks', from: maxTask - 49, to: null } };
}

export interface DraftResult<T> {
  slice: T | null;
  error: string | null;
  field: 'from' | 'to' | null;
}

export function taskDraft(from: string, to: string): DraftResult<Slice> {
  const a = from.trim();
  const b = to.trim();
  const lo = a === '' ? null : taskBound(a);
  const hi = b === '' ? null : taskBound(b);
  if (a !== '' && lo === null) return { slice: null, error: TASK_NUMBER_ERROR, field: 'from' };
  if (b !== '' && hi === null) return { slice: null, error: TASK_NUMBER_ERROR, field: 'to' };
  if (lo !== null && hi !== null && lo > hi) return { slice: null, error: TASK_ORDER_ERROR, field: 'to' };
  return { slice: { kind: 'tasks', from: lo, to: hi }, error: null, field: null };
}

export function dateDraft(from: string, to: string): DraftResult<Slice> {
  const a = from === '' ? null : utcDay(from);
  const b = to === '' ? null : utcDay(to);
  if (from !== '' && a === null) return { slice: null, error: DATE_ORDER_ERROR, field: 'from' };
  if (to !== '' && b === null) return { slice: null, error: DATE_ORDER_ERROR, field: 'to' };
  if (a && b && a > b) return { slice: null, error: DATE_ORDER_ERROR, field: 'to' };
  return { slice: { kind: 'dates', from: a, to: b }, error: null, field: null };
}

export type DeltaMeasure = 'tokens_out' | 'context' | 'cache_hit' | 'cost' | 'duration_ms' | 'tool_uses' | 'count';
export type Polarity = 'lower' | 'higher' | 'neutral';

export const POLARITY: Record<DeltaMeasure, Polarity> = {
  tokens_out: 'lower',
  context: 'lower',
  cost: 'lower',
  duration_ms: 'lower',
  cache_hit: 'higher',
  tool_uses: 'neutral',
  count: 'neutral',
};

const REL_BAND = 0.05;
const PTS_BAND = 1;
const MINUS = '−';

export interface Delta {
  text: string;
  variant: 'success' | 'danger' | 'secondary';
  direction: 'up' | 'down' | 'none';
  aria: string;
  title?: string;
}

function magnitude(abs: number, unit: '%' | ' pts'): string {
  if (abs < 0.05) return `<0.1${unit}`;
  if (unit === '%' && abs >= 10) return `${Math.round(abs)}%`;
  const one = abs.toFixed(1);
  return unit === '%' && one === '10.0' ? '10%' : `${one}${unit}`;
}

// Period 1 is the baseline: relative change (p2 − p1) / p1, or for cache-hit
// the difference in percentage points.
export function delta(measure: DeltaMeasure, subject: string, p1: number | null, p2: number | null): Delta {
  const points = measure === 'cache_hit';
  if (p1 === null || (p1 === 0 && !points)) return { text: vsPeriod1('—'), variant: 'secondary', direction: 'none', aria: noBaselineAria(subject), title: NO_BASELINE_TITLE };
  if (p2 === null) return { text: vsPeriod1('—'), variant: 'secondary', direction: 'none', aria: vsPeriod1(`${subject} —`) };
  const change = points ? (p2 - p1) * 100 : (p2 - p1) / p1;
  if (change === 0) return { text: NO_CHANGE, variant: 'secondary', direction: 'none', aria: noChangeAria(subject) };
  const direction = change > 0 ? 'up' : 'down';
  const abs = Math.abs(change) * (points ? 1 : 100);
  const mag = magnitude(abs, points ? ' pts' : '%');
  const polarity = POLARITY[measure];
  const outside = points ? Math.abs(change) >= PTS_BAND : Math.abs(change) >= REL_BAND;
  const better = polarity === 'neutral' || !outside ? null : (polarity === 'lower') === (direction === 'down');
  return {
    text: vsPeriod1(`${direction === 'up' ? '+' : MINUS}${mag}`),
    variant: better === null ? 'secondary' : better ? 'success' : 'danger',
    direction,
    aria: deltaAria(subject, direction, mag, better),
  };
}
