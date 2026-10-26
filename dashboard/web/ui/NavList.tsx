// Forked from Primer React NavList (github.com/primer/react, MIT), rebuilt on Primer control and border tokens without @primer/react.
export interface NavListItem {
  key: string;
  label: string;
  href: string;
}

export function NavList({ label, items, current, className }: { label: string; items: NavListItem[]; current: string; className?: string }) {
  return (
    <nav aria-label={label} className={className}>
      <ul className="space-y-0.5">
        {items.map((item) => {
          const active = item.key === current;
          return (
            <li key={item.key} className="relative">
              {active && <span aria-hidden="true" className="absolute top-1/2 -left-2 h-6 w-1 -translate-y-1/2 rounded-md bg-(--borderColor-accent-emphasis)" />}
              <a
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`block rounded-md px-2 py-1.5 text-sm text-fg hover:bg-(--control-transparent-bgColor-hover) focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color) focus-visible:-outline-offset-2 ${active ? 'bg-(--control-transparent-bgColor-selected) font-semibold' : ''}`}
              >
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
