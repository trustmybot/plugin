import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { CheckIcon, TriangleDownIcon, type Icon } from '@primer/octicons-react';
import { hrefWith } from '../../shared/route.ts';
import { buttonClass } from '../../ui/Button.tsx';

const MENU_ITEM =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-(--control-transparent-bgColor-hover) focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color) focus-visible:-outline-offset-2';

export interface FilterOption {
  value: string;
  name: string;
  count: number;
}

export interface FilterMenuProps {
  param: string;
  icon: Icon;
  title: string;
  allLabel: string;
  options: FilterOption[];
  value: string | null;
  valueLabel: string | null;
}

export function FilterMenu({ param, icon: TriggerIcon, title, allLabel, options, value, valueLabel }: FilterMenuProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = () => [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
  useEffect(() => {
    if (!open) return;
    (items().find((el) => el.getAttribute('aria-checked') === 'true') ?? items()[0])?.focus();
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const onKey = (e: KeyboardEvent) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 }[e.key];
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    } else if (move !== undefined && all.length > 0) {
      e.preventDefault();
      all[(move + all.length) % all.length]?.focus();
    }
  };
  const choose = (next: string | null) => () => {
    setOpen(false);
    trigger.current?.focus();
    window.location.hash = hrefWith({ [param]: next }, 'issues');
  };
  const all: Array<{ key: string; name: string; value: string | null; count?: number }> = [
    { key: '', name: allLabel, value: null },
    ...options.map((o) => ({ key: o.value, name: o.name, value: o.value, count: o.count })),
  ];
  return (
    <div ref={root} className="relative shrink-0" onKeyDown={onKey}>
      <button
        ref={trigger}
        type="button"
        className={buttonClass('default', 'medium')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <TriggerIcon size={16} aria-hidden="true" />
        <span className="max-w-48 truncate">{valueLabel ?? title}</span>
        <TriangleDownIcon size={16} aria-hidden="true" />
      </button>
      <div
        id={id}
        role="menu"
        aria-label={`Filter by ${title.toLowerCase()}`}
        hidden={!open}
        className="absolute right-0 z-10 mt-1 max-h-80 w-64 overflow-y-auto rounded-md border border-(--borderColor-default) bg-(--overlay-bgColor) p-1 shadow-(--shadow-floating-small)"
      >
        {all.map((o) => {
          const checked = o.value === value || (o.value === null && !value);
          return (
            <button key={o.key} type="button" role="menuitemradio" aria-checked={checked} tabIndex={-1} className={MENU_ITEM} onClick={choose(o.value)}>
              <CheckIcon size={16} aria-hidden="true" className={checked ? '' : 'invisible'} />
              <span className="min-w-0 flex-1 truncate">{o.name}</span>
              {o.count !== undefined && <span className="text-xs text-fg-muted tabular-nums">{o.count}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
