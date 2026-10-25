// Forked from Primer React Label (github.com/primer/react, MIT), rebuilt on Primer fgColor/borderColor tokens without @primer/react.
import type { ReactNode } from 'react';

export type LabelVariant = 'default' | 'primary' | 'secondary' | 'accent' | 'success' | 'attention' | 'severe' | 'danger' | 'done';

export const LABEL_COLORS: Record<LabelVariant, string> = {
  default: 'border-(--borderColor-default) text-fg',
  primary: 'border-(--borderColor-neutral-emphasis) text-fg',
  secondary: 'border-(--borderColor-muted) text-fg-muted',
  accent: 'border-(--borderColor-accent-emphasis) text-(--fgColor-accent)',
  success: 'border-(--borderColor-success-emphasis) text-(--fgColor-success)',
  attention: 'border-(--borderColor-attention-emphasis) text-(--fgColor-attention)',
  severe: 'border-(--borderColor-severe-emphasis) text-(--fgColor-severe)',
  danger: 'border-(--borderColor-danger-emphasis) text-(--fgColor-danger)',
  done: 'border-(--borderColor-done-emphasis) text-(--fgColor-done)',
};

export const labelClass = (variant: LabelVariant = 'default') =>
  `inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full border px-[7px] text-xs font-medium leading-none ${LABEL_COLORS[variant]}`;

export function Label({ variant = 'default', children }: { variant?: LabelVariant; children: ReactNode }) {
  return <span className={labelClass(variant)}>{children}</span>;
}
