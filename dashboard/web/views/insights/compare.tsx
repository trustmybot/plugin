import { AlertIcon, ArrowDownIcon, ArrowSwitchIcon, ArrowUpIcon, DashIcon, GitCompareIcon } from '@primer/octicons-react';
import { useId, useState, type KeyboardEvent } from 'react';
import { FIELD } from '../../shared/classes.ts';
import { Button } from '../../ui/Button.tsx';
import { labelClass } from '../../ui/Label.tsx';
import { SegmentedControl } from '../../ui/SegmentedControl.tsx';
import {
  dateDraft,
  defaultCompare,
  delta,
  sameSlice,
  sliceKey,
  sliceLabel,
  taskDraft,
  type Compare,
  type DeltaMeasure,
  type DraftResult,
  type PeriodN,
  type Slice,
} from './compare.ts';
import { compact, pct, usd } from './format.ts';
import {
  COMPARE_OFF,
  COMPARE_ON,
  COMPARE_TOGGLE,
  COMPARE_TOGGLE_TITLE,
  DATES_LABEL,
  DATE_PRESETS,
  FIRST_TASK,
  FROM_LABEL,
  LATEST_TASK,
  PERIOD_KINDS,
  PER_TASK_HEADING,
  PER_TASK_TILES,
  SAME_PERIODS,
  SWAP_PERIODS,
  TASKS_HINT,
  TO_LABEL,
  compareSummary,
  period1Value,
  periodName,
  periodType,
  perTaskSubject,
  sharedRunsCaption,
  writeInsightParams,
  type InsightParams,
} from './params.ts';
import type { Comparison, PeriodInsights } from './types.ts';

const INPUT = `${FIELD} min-h-7`;
const SELECT = `${FIELD} min-h-7 w-auto py-1.5`;
const ERROR = 'flex items-center gap-1 text-xs text-(--fgColor-danger)';

export function DeltaLabel({ measure, subject, p1, p2 }: { measure: DeltaMeasure; subject: string; p1: number | null; p2: number | null }) {
  const d = delta(measure, subject, p1, p2);
  const Icon = d.direction === 'up' ? ArrowUpIcon : d.direction === 'down' ? ArrowDownIcon : d.text.startsWith('—') ? null : DashIcon;
  return (
    <span role="img" className={labelClass(d.variant)} aria-label={d.aria} title={d.title} data-delta={d.variant}>
      {Icon && <Icon size={12} aria-hidden="true" />}
      {d.text}
    </span>
  );
}

export function CompareToggle({ params, maxTask }: { params: InsightParams; maxTask: number | null | undefined }) {
  const [announce, setAnnounce] = useState('');
  const on = !!params.compare;
  const toggle = () => {
    setAnnounce(on ? COMPARE_OFF : COMPARE_ON);
    writeInsightParams({ ...params, compare: on ? null : defaultCompare(maxTask) });
  };
  return (
    <>
      <Button
        size="small"
        leadingVisual={GitCompareIcon}
        aria-pressed={on}
        title={COMPARE_TOGGLE_TITLE}
        onClick={toggle}
        className="aria-pressed:border-(--borderColor-accent-emphasis) aria-pressed:bg-(--button-default-bgColor-active)"
        data-compare-toggle=""
      >
        {COMPARE_TOGGLE}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </>
  );
}

function FieldError({ id, draft }: { id: string; draft: DraftResult<Slice> | null }) {
  if (!draft?.error) return null;
  return (
    <p id={id} className={ERROR}>
      <AlertIcon size={12} aria-hidden="true" />
      {draft.error}
    </p>
  );
}

const onEnter = (commit: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter') commit();
};

// A draft is local until blur or Enter; an invalid one never reaches the hash.
function useDraft(slice: Slice, initial: () => [string, string]) {
  const key = sliceKey(slice);
  const [seen, setSeen] = useState(key);
  const [values, setValues] = useState(initial);
  const [draft, setDraft] = useState<DraftResult<Slice> | null>(null);
  if (seen !== key) {
    setSeen(key);
    setValues(initial());
    setDraft(null);
  }
  return { key, values, setValues, draft, setDraft };
}

function TaskFields({ slice, onCommit }: { slice: Slice; onCommit: (s: Slice) => void }) {
  const ids = { hint: useId(), error: useId() };
  const { key, values, setValues, draft, setDraft } = useDraft(slice, () =>
    slice.kind === 'tasks' ? [slice.from === null ? '' : String(slice.from), slice.to === null ? '' : String(slice.to)] : ['', ''],
  );
  const commit = () => {
    const next = taskDraft(values[0], values[1]);
    setDraft(next);
    if (next.slice && sliceKey(next.slice) !== key) onCommit(next.slice);
  };
  const field = (i: 0 | 1, label: string, placeholder: string) => {
    const invalid = !!draft?.error && draft.field === (i === 0 ? 'from' : 'to');
    return (
      <label className="flex items-center gap-2 text-sm text-fg-muted">
        {label}
        <input
          type="number"
          inputMode="numeric"
          min={1}
          className={`${INPUT} w-24`}
          placeholder={placeholder}
          value={values[i]}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${ids.error} ${ids.hint}` : ids.hint}
          onChange={(e) => setValues(i === 0 ? [e.target.value, values[1]] : [values[0], e.target.value])}
          onBlur={commit}
          onKeyDown={onEnter(commit)}
        />
      </label>
    );
  };
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        {field(0, FROM_LABEL, FIRST_TASK)}
        {field(1, TO_LABEL, LATEST_TASK)}
      </div>
      <FieldError id={ids.error} draft={draft} />
      <p id={ids.hint} className="text-xs text-fg-muted">
        {TASKS_HINT}
      </p>
    </div>
  );
}

const presetOf = (s: Slice) => (s.kind === 'range' || s.kind === 'prev' ? s.range : 'custom');

function DateFields({ slice, onCommit }: { slice: Slice; onCommit: (s: Slice) => void }) {
  const errorId = useId();
  const { key, values, setValues, draft, setDraft } = useDraft(slice, () => (slice.kind === 'dates' ? [slice.from ?? '', slice.to ?? ''] : ['', '']));
  const [custom, setCustom] = useState(slice.kind === 'dates');
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    setCustom(slice.kind === 'dates');
  }
  const choose = (v: string) => {
    if (v === 'custom') return setCustom(true);
    setCustom(false);
    onCommit(v.startsWith('prev') ? { kind: 'prev', range: v as 'prev7d' } : { kind: 'range', range: v as '7d' });
  };
  const commit = () => {
    const next = dateDraft(values[0], values[1]);
    setDraft(next);
    if (next.slice && sliceKey(next.slice) !== key) onCommit(next.slice);
  };
  const field = (i: 0 | 1, label: string) => {
    const invalid = !!draft?.error && draft.field === (i === 0 ? 'from' : 'to');
    return (
      <label className="flex items-center gap-2 text-sm text-fg-muted">
        {label}
        <input
          type="date"
          className={`${INPUT} w-auto`}
          value={values[i]}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          onChange={(e) => setValues(i === 0 ? [e.target.value, values[1]] : [values[0], e.target.value])}
          onBlur={commit}
          onKeyDown={onEnter(commit)}
        />
      </label>
    );
  };
  return (
    <div className="space-y-1">
      <select className={SELECT} aria-label={DATES_LABEL} value={custom ? 'custom' : presetOf(slice)} onChange={(e) => choose(e.target.value)}>
        {DATE_PRESETS.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
      {custom && (
        <div className="flex flex-wrap gap-2">
          {field(0, FROM_LABEL)}
          {field(1, TO_LABEL)}
        </div>
      )}
      <FieldError id={errorId} draft={draft} />
    </div>
  );
}

function PeriodPicker({ n, slice, maxTask, onCommit }: { n: PeriodN; slice: Slice; maxTask: number | null | undefined; onCommit: (s: Slice) => void }) {
  const kind = slice.kind === 'tasks' ? 'tasks' : 'dates';
  const switchKind = (k: 'dates' | 'tasks') => {
    if (k === kind) return;
    const fallback = defaultCompare(maxTask)[n === 1 ? 'p1' : 'p2'];
    if (k === 'tasks') onCommit(fallback.kind === 'tasks' ? fallback : { kind: 'tasks', from: null, to: null });
    else onCommit(n === 1 ? { kind: 'prev', range: 'prev30d' } : { kind: 'range', range: '30d' });
  };
  return (
    <fieldset className="w-full min-w-0 rounded-md border border-(--borderColor-muted) px-3 py-2 lg:w-auto" data-period={n}>
      <legend className="float-left mr-2 text-sm leading-8 font-semibold text-fg">{periodName(n)}</legend>
      <SegmentedControl label={periodType(n)} segments={PERIOD_KINDS.map(([value, label]) => ({ value, label }))} value={kind} onChange={switchKind} />
      <div className="clear-both pt-2">
        {kind === 'tasks' ? <TaskFields slice={slice} onCommit={onCommit} /> : <DateFields slice={slice} onCommit={onCommit} />}
      </div>
    </fieldset>
  );
}

export function PeriodPickers({ params, compare, maxTask }: { params: InsightParams; compare: Compare; maxTask: number | null | undefined }) {
  const set = (next: Compare) => writeInsightParams({ ...params, compare: next });
  return (
    <div className="flex w-full flex-col items-start gap-2 lg:w-auto lg:flex-row" data-compare-bar="">
      <PeriodPicker n={1} slice={compare.p1} maxTask={maxTask} onCommit={(p1) => set({ ...compare, p1 })} />
      <Button size="small" variant="invisible" aria-label={SWAP_PERIODS} title={SWAP_PERIODS} onClick={() => set({ p1: compare.p2, p2: compare.p1 })} className="lg:self-center">
        <ArrowSwitchIcon size={16} aria-hidden="true" />
      </Button>
      <PeriodPicker n={2} slice={compare.p2} maxTask={maxTask} onCommit={(p2) => set({ ...compare, p2 })} />
    </div>
  );
}

export const totalRuns = (p: PeriodInsights) => p.agents.reduce((s, a) => s + a.total, 0);

export function CompareSummary({ cmp, compare }: { cmp: Comparison; compare: Compare }) {
  return (
    <div className="space-y-1 text-xs text-fg-muted tabular-nums" data-compare-summary="">
      <p>
        {compareSummary([
          { label: sliceLabel(compare.p1), runs: totalRuns(cmp.p1) },
          { label: sliceLabel(compare.p2), runs: totalRuns(cmp.p2) },
        ])}
      </p>
      {sameSlice(compare.p1, compare.p2) ? <p>{SAME_PERIODS}</p> : cmp.shared_runs > 0 && <p>{sharedRunsCaption(cmp.shared_runs)}</p>}
    </div>
  );
}

const money = (v: number | null) => (v === null ? '—' : usd(v));

export function CompareTile({ title, measure, subject, p1, p2, format }: { title: string; measure: DeltaMeasure; subject: string; p1: number | null; p2: number | null; format: (v: number | null) => string }) {
  return (
    <div className="space-y-1 rounded-md border border-(--borderColor-muted) px-3 py-2" data-compare-tile={measure}>
      <p className="text-xs font-semibold text-fg">{title}</p>
      <p className="text-2xl font-semibold text-fg tabular-nums">{format(p2)}</p>
      <p className="text-xs text-fg-muted tabular-nums">{period1Value(format(p1))}</p>
      <DeltaLabel measure={measure} subject={subject} p1={p1} p2={p2} />
    </div>
  );
}

export function PerTaskStrip({ cmp }: { cmp: Comparison }) {
  const a = cmp.p1.per_task;
  const b = cmp.p2.per_task;
  const priced = cmp.p1.cost.priced || cmp.p2.cost.priced;
  const tiles: Array<{ measure: DeltaMeasure; title: string; subject: string; p1: number | null; p2: number | null; format: (v: number | null) => string }> = [
    { measure: 'tokens_out', title: PER_TASK_TILES.tokens_out, subject: perTaskSubject.tokens_out, p1: a.tokens_out, p2: b.tokens_out, format: compact },
    { measure: 'context', title: PER_TASK_TILES.context, subject: perTaskSubject.context, p1: a.context, p2: b.context, format: compact },
    { measure: 'cache_hit', title: PER_TASK_TILES.cache_hit, subject: perTaskSubject.cache_hit, p1: a.cache_hit, p2: b.cache_hit, format: pct },
    ...(priced ? [{ measure: 'cost' as const, title: PER_TASK_TILES.cost, subject: perTaskSubject.cost, p1: a.cost_usd, p2: b.cost_usd, format: money }] : []),
  ];
  return (
    <section className="space-y-2" aria-label={PER_TASK_HEADING} data-per-task="">
      <h3 className="text-sm font-semibold text-fg">{PER_TASK_HEADING}</h3>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <CompareTile key={t.measure} {...t} />
        ))}
      </div>
    </section>
  );
}
