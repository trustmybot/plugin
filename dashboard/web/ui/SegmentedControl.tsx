// Forked from Primer React SegmentedControl (github.com/primer/react, MIT), rebuilt as a radiogroup on Primer tokens without @primer/react.
import { useRef, type KeyboardEvent } from 'react';

export interface Segment<T extends string> {
  value: T;
  label: string;
}

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export function segmentKey(index: number, key: string, count: number): number | null {
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const step = STEP[key];
  return step === undefined ? null : (index + step + count) % count;
}

export function SegmentedControl<T extends string>({
  label,
  segments,
  value,
  onChange,
}: {
  label: string;
  segments: readonly Segment<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (index: number) => (e: KeyboardEvent) => {
    const next = segmentKey(index, e.key, segments.length);
    if (next === null) return;
    e.preventDefault();
    buttons.current[next]?.focus();
    onChange(segments[next]!.value);
  };
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-md border border-(--borderColor-default) bg-canvas-muted p-0.5">
      {segments.map((segment, i) => {
        const checked = segment.value === value;
        return (
          <button
            key={segment.value}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(segment.value)}
            onKeyDown={onKeyDown(i)}
            className={`min-h-7 cursor-pointer rounded-md border px-3 text-sm focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color) focus-visible:-outline-offset-2 ${
              checked
                ? 'border-(--borderColor-default) bg-canvas font-semibold text-fg shadow-(--shadow-resting-small)'
                : 'border-transparent text-fg-muted hover:bg-(--control-transparent-bgColor-hover) hover:text-fg'
            }`}
          >
            {segment.label}
          </button>
        );
      })}
    </div>
  );
}
