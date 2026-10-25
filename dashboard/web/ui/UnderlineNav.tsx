// Forked from Primer React UnderlineNav (github.com/primer/react, MIT), rebuilt on Primer tokens without @primer/react.
import type { Icon } from '@primer/octicons-react';

export type NavTab = readonly [key: string, label: string, icon: Icon];

export function UnderlineNav({ tabs, active }: { tabs: readonly NavTab[]; active: string }) {
  return (
    <nav aria-label="Dashboard" className="border-b border-border-muted bg-canvas">
      <ul className="mx-auto flex w-full max-w-[120rem] gap-2 overflow-x-auto px-4 sm:px-6 2xl:px-10 [scrollbar-width:none]">
        {tabs.map(([key, label, TabIcon]) => {
          const current = key === active;
          return (
            <li key={key} className="flex shrink-0">
              <a
                href={`#/${key}`}
                aria-current={current ? 'page' : undefined}
                className={`relative my-2 flex items-center gap-2 whitespace-nowrap rounded-md px-2 py-1 text-sm text-fg hover:bg-(--control-transparent-bgColor-hover) focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color) ${
                  current
                    ? 'font-semibold after:absolute after:inset-x-0 after:-bottom-2 after:h-0.5 after:rounded-md after:bg-(--underlineNav-borderColor-active)'
                    : 'hover:after:absolute hover:after:inset-x-0 hover:after:-bottom-2 hover:after:h-0.5 hover:after:rounded-md hover:after:bg-(--underlineNav-borderColor-hover)'
                }`}
              >
                <TabIcon size={16} className="text-(--underlineNav-iconColor-rest)" aria-hidden="true" />
                {label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
