// Forked from Primer CSS Popover (github.com/primer/css, MIT), rebuilt as a toggletip on Primer overlay tokens without Primer CSS.
import { QuestionIcon } from '@primer/octicons-react';
import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { HELP_USES_HEADING, type HelpEntry } from '../shared/help-copy.ts';

export const HOVER_OPEN_MS = 150;
export const HOVER_GRACE_MS = 200;

export interface HelpState {
  open: boolean;
  pinned: boolean;
  due: { action: 'open' | 'close'; at: number } | null;
  restoreFocus: boolean;
}

export type HelpEvent =
  | { type: 'pointerenter'; at: number }
  | { type: 'pointerleave'; at: number }
  | { type: 'tick'; at: number }
  | { type: 'focus' }
  | { type: 'blur' }
  | { type: 'click' }
  | { type: 'escape' }
  | { type: 'outside' };

export const HELP_CLOSED: HelpState = { open: false, pinned: false, due: null, restoreFocus: false };

export function helpTransition(state: HelpState, event: HelpEvent): HelpState {
  const s = { ...state, restoreFocus: false };
  switch (event.type) {
    case 'pointerenter':
      return { ...s, due: s.open ? null : { action: 'open', at: event.at + HOVER_OPEN_MS } };
    case 'pointerleave':
      return { ...s, due: s.open && !s.pinned ? { action: 'close', at: event.at + HOVER_GRACE_MS } : null };
    case 'tick':
      if (!s.due || event.at < s.due.at) return s;
      return { ...s, open: s.due.action === 'open', due: null };
    case 'focus':
      return { ...s, open: true, due: null };
    case 'blur':
      return s.pinned ? s : HELP_CLOSED;
    case 'click':
      return s.pinned ? HELP_CLOSED : { ...s, open: true, pinned: true, due: null };
    case 'escape':
      return { ...HELP_CLOSED, restoreFocus: true };
    case 'outside':
      return HELP_CLOSED;
  }
}

const TRIGGER =
  'flex size-8 cursor-pointer items-center justify-center rounded-md text-fg-muted hover:bg-(--button-invisible-bgColor-hover) active:bg-(--button-invisible-bgColor-active) aria-expanded:bg-(--button-invisible-bgColor-active) focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color) focus-visible:-outline-offset-2';

const PANEL =
  'z-20 space-y-2 rounded-xl border border-(--borderColor-default) bg-(--overlay-bgColor) p-4 text-left text-sm text-fg shadow-(--shadow-floating-small) transition-[opacity,visibility] duration-[120ms] motion-reduce:transition-none max-sm:fixed max-sm:inset-x-3 max-sm:max-h-[60vh] max-sm:overflow-y-auto sm:absolute sm:top-full sm:right-0 sm:mt-1 sm:w-max sm:max-w-[22rem]';

const now = () => performance.now();

export function HelpToggletip({ page, help, defaultOpen = false }: { page: string; help: HelpEntry; defaultOpen?: boolean }) {
  const id = useId();
  const panelId = `${id}-panel`;
  const headingId = `${id}-heading`;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoring = useRef(false);
  const [state, setState] = useState<HelpState>(() => (defaultOpen ? { ...HELP_CLOSED, open: true, pinned: true } : HELP_CLOSED));
  const current = useRef(state);
  const dispatch = (event: HelpEvent) => {
    const next = helpTransition(current.current, event);
    current.current = next;
    setState(next);
    if (next.restoreFocus) {
      restoring.current = true;
      trigger.current?.focus();
      restoring.current = false;
    }
  };

  useEffect(() => {
    const due = state.due;
    if (!due) return;
    const t = setTimeout(() => dispatch({ type: 'tick', at: due.at }), Math.max(0, due.at - now()));
    return () => clearTimeout(t);
  }, [state.due]);

  useEffect(() => {
    if (!state.open) return;
    const onDown = (e: Event) => {
      if (!root.current?.contains(e.target as Node)) dispatch({ type: 'outside' });
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [state.open]);

  const hover = (type: 'pointerenter' | 'pointerleave') => (e: PointerEvent) => {
    if (e.pointerType === 'mouse') dispatch({ type, at: now() });
  };
  const onBlur = (e: FocusEvent) => {
    if (!root.current?.contains(e.relatedTarget as Node | null)) dispatch({ type: 'blur' });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && state.open) {
      e.stopPropagation();
      dispatch({ type: 'escape' });
    }
  };

  return (
    <div ref={root} className="relative" onPointerEnter={hover('pointerenter')} onPointerLeave={hover('pointerleave')} onBlur={onBlur} onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        className={TRIGGER}
        aria-label={`About this page: ${page}`}
        aria-expanded={state.open}
        aria-controls={panelId}
        onFocus={() => {
          if (!restoring.current) dispatch({ type: 'focus' });
        }}
        onClick={() => dispatch({ type: 'click' })}
      >
        <QuestionIcon size={16} aria-hidden="true" />
      </button>
      <div id={panelId} role="region" aria-labelledby={headingId} className={`${PANEL} ${state.open ? 'visible opacity-100' : 'invisible opacity-0'}`}>
        <h2 id={headingId} className="text-sm font-semibold">{page}</h2>
        <p className="text-fg-muted">{help.intro}</p>
        {help.layers && (
          <dl className="space-y-1">
            {help.layers.map((layer) => (
              <div key={layer.name}>
                <dt className="inline font-semibold">{layer.name}:</dt> <dd className="inline text-fg-muted">{layer.text}</dd>
              </div>
            ))}
          </dl>
        )}
        <h3 className="text-sm font-semibold">{HELP_USES_HEADING}</h3>
        <ul className="list-disc space-y-0.5 pl-5">
          {help.uses.map((use) => <li key={use}>{use}</li>)}
        </ul>
      </div>
    </div>
  );
}
