import type { ReactNode } from 'react';

export interface ListRowProps {
  icon: ReactNode;
  href: string;
  title: string;
  adornments?: ReactNode;
  meta?: ReactNode;
  aside?: ReactNode;
}

export function ListRow({ icon, href, title, adornments, meta, aside }: ListRowProps) {
  return (
    <li className="flex gap-2.5 border-t border-(--borderColor-muted) px-4 py-2 first:border-t-0 hover:bg-canvas-muted">
      <span className="mt-1 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1 break-words">
        <a href={href} className="mr-1 align-middle text-base font-semibold text-fg hover:text-(--fgColor-accent)">
          {title}
        </a>
        {adornments}
        {meta && <div className="mt-0.5 flex flex-wrap items-center gap-x-1 text-xs text-fg-muted">{meta}</div>}
      </div>
      {aside && <div className="flex shrink-0 items-start gap-4 pt-1 text-xs whitespace-nowrap text-fg-muted">{aside}</div>}
    </li>
  );
}
