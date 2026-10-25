// Forked from Primer React Blankslate (github.com/primer/react, MIT), rebuilt on Primer tokens without @primer/react.
import type { Icon } from '@primer/octicons-react';
import type { ReactNode } from 'react';

export function Blankslate({ icon: BlankIcon, heading, description, action }: { icon: Icon; heading: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
      <BlankIcon size={24} className="mb-2 text-fg-muted" aria-hidden="true" />
      <h2 className="text-xl font-semibold text-fg">{heading}</h2>
      {description && <p className="max-w-prose text-sm text-fg-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
