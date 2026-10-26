// Forked from Primer React DescriptionList (github.com/primer/react, MIT), rebuilt as a native <dl> on Primer fgColor tokens without @primer/react.
import type { ReactNode } from 'react';

export interface DescriptionItem {
  term: ReactNode;
  detail: ReactNode;
}

export function DescriptionList({ items }: { items: DescriptionItem[] }) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
      {items.map((item, i) => (
        <div key={i} className="contents">
          <dt className="font-semibold text-fg-muted">{item.term}</dt>
          <dd className="min-w-0 break-words text-fg">{item.detail}</dd>
        </div>
      ))}
    </dl>
  );
}
