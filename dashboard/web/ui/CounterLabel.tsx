// Forked from Primer React CounterLabel (github.com/primer/react, MIT), rebuilt on Primer --counter-* tokens without @primer/react.
import type { ReactNode } from 'react';

const SCHEME = {
  primary: 'bg-(--counter-bgColor-emphasis) text-(--fgColor-onEmphasis)',
  secondary: 'bg-(--counter-bgColor-muted) text-fg',
} as const;

export function CounterLabel({ scheme = 'secondary', children }: { scheme?: keyof typeof SCHEME; children: ReactNode }) {
  return (
    <span
      className={`inline-block min-w-5 rounded-full border border-(--counter-borderColor) px-1.5 text-center text-xs font-medium leading-[18px] ${SCHEME[scheme]}`}
    >
      {children}
    </span>
  );
}
