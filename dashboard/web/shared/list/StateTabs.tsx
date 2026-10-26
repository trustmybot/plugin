import type { Icon } from '@primer/octicons-react';

export interface StateTab {
  key: string;
  label: string;
  icon: Icon;
  count: number;
  href: string;
  selected: boolean;
}

export function StateTabs({ tabs }: { tabs: StateTab[] }) {
  return (
    <nav aria-label="State" className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {tabs.map(({ key, label, icon: TabIcon, count, href, selected }) => (
        <a
          key={key}
          href={href}
          aria-current={selected ? 'page' : undefined}
          className={`flex items-center gap-1.5 text-sm hover:text-fg ${selected ? 'font-semibold text-fg' : 'text-fg-muted'}`}
        >
          <TabIcon size={16} aria-hidden="true" />
          {count} {label}
        </a>
      ))}
    </nav>
  );
}
