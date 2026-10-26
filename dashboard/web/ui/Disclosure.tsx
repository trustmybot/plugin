// Forked from Primer CSS Details (github.com/primer/css, MIT), rebuilt on native <details>/<summary> and Primer tokens without Primer CSS.
import { ChevronRightIcon } from '@primer/octicons-react';
import type { ReactNode } from 'react';

export function Disclosure({ summary, defaultOpen = false, children }: { summary: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details open={defaultOpen} className="group rounded-md border border-(--borderColor-default) bg-canvas">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-4 py-2 text-sm hover:bg-canvas-muted focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color) focus-visible:-outline-offset-2 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon size={16} aria-hidden="true" className="shrink-0 text-fg-muted transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        <span className="flex min-w-0 flex-wrap items-center gap-2">{summary}</span>
      </summary>
      <div className="border-t border-(--borderColor-muted) px-4 py-3">{children}</div>
    </details>
  );
}
