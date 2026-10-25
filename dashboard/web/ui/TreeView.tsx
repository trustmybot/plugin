// Forked from Primer React TreeView (github.com/primer/react, MIT), rebuilt on Primer --control-* and border tokens without @primer/react.
import { ChevronDownIcon, ChevronRightIcon } from '@primer/octicons-react';
import { useId, type KeyboardEvent, type ReactNode } from 'react';

export function TreeView({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul role="tree" aria-label={label} className="m-0 list-none p-0 text-sm">
      {children}
    </ul>
  );
}

type ItemProps = {
  level: number;
  label: ReactNode;
  current?: boolean;
  tabStop?: boolean;
  expanded?: boolean;
  leadingVisual?: ReactNode;
  trailingVisual?: ReactNode;
  onSelect?: () => void;
  onToggle?: () => void;
  children?: ReactNode;
};

const items = (el: HTMLElement) => [...(el.closest('[role="tree"]')?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];

export function TreeViewItem({ level, label, current = false, tabStop = false, expanded, leadingVisual, trailingVisual, onSelect, onToggle, children }: ItemProps) {
  const id = useId();
  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.target !== e.currentTarget) return;
    const self = e.currentTarget;
    const all = items(self);
    const i = all.indexOf(self);
    switch (e.key) {
      case 'ArrowDown':
        all[i + 1]?.focus();
        break;
      case 'ArrowUp':
        all[i - 1]?.focus();
        break;
      case 'Home':
        all[0]?.focus();
        break;
      case 'End':
        all.at(-1)?.focus();
        break;
      case 'ArrowRight':
        if (expanded === false) onToggle?.();
        else if (expanded) self.querySelector<HTMLElement>('[role="treeitem"]')?.focus();
        break;
      case 'ArrowLeft':
        if (expanded) onToggle?.();
        else self.parentElement?.closest<HTMLElement>('[role="treeitem"]')?.focus();
        break;
      case 'Enter':
      case ' ':
        onSelect?.();
        break;
      default:
        return;
    }
    e.preventDefault();
  };
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <li
      role="treeitem"
      aria-labelledby={`${id}-label`}
      aria-level={level}
      aria-expanded={expanded}
      aria-current={current || undefined}
      tabIndex={current || tabStop ? 0 : -1}
      onKeyDown={onKeyDown}
      className="outline-none [&:focus-visible>div]:outline-(length:--focus-outline-width) [&:focus-visible>div]:outline-(--focus-outline-color) [&:focus-visible>div]:-outline-offset-2"
    >
      <div
        onClick={onSelect}
        className={`relative flex min-h-(--control-medium-size) cursor-pointer items-stretch rounded-md text-fg hover:bg-(--control-transparent-bgColor-hover) ${
          current
            ? "bg-(--control-transparent-bgColor-selected) after:absolute after:top-1/2 after:-left-2 after:h-6 after:w-1 after:-translate-y-1/2 after:rounded-md after:bg-(--borderColor-accent-emphasis) after:content-['']"
            : ''
        }`}
      >
        {Array.from({ length: level - 1 }, (_, i) => (
          <span key={i} aria-hidden="true" className="w-4 shrink-0 border-r border-(--borderColor-muted)" />
        ))}
        <span className="flex min-w-0 flex-1 items-center gap-1 px-1">
          {expanded === undefined ? (
            <span className="w-4 shrink-0" />
          ) : (
            <span
              aria-hidden="true"
              className="flex size-4 shrink-0 items-center justify-center text-fg-muted"
              onClick={(e) => {
                e.stopPropagation();
                onToggle?.();
              }}
            >
              <Chevron size={12} />
            </span>
          )}
          {leadingVisual && <span className="flex shrink-0 items-center">{leadingVisual}</span>}
          <span id={`${id}-label`} className="min-w-0 flex-1 truncate">
            {label}
          </span>
          {trailingVisual && <span className="flex shrink-0 items-center text-xs text-fg-muted">{trailingVisual}</span>}
        </span>
      </div>
      {expanded && children && (
        <ul role="group" className="m-0 list-none p-0">
          {children}
        </ul>
      )}
    </li>
  );
}
