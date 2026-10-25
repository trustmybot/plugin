// Forked from Primer React Flash (github.com/primer/react, MIT), rebuilt on Primer bgColor/borderColor-*-muted tokens without @primer/react.
import { AlertIcon, CheckCircleIcon, InfoIcon, StopIcon, type Icon } from '@primer/octicons-react';
import type { ReactNode } from 'react';

export type FlashVariant = 'default' | 'success' | 'warning' | 'danger';

const VARIANT: Record<FlashVariant, { icon: Icon; box: string; fg: string }> = {
  default: { icon: InfoIcon, box: 'border-(--borderColor-accent-muted) bg-(--bgColor-accent-muted)', fg: 'text-(--fgColor-accent)' },
  success: { icon: CheckCircleIcon, box: 'border-(--borderColor-success-muted) bg-(--bgColor-success-muted)', fg: 'text-(--fgColor-success)' },
  warning: { icon: AlertIcon, box: 'border-(--borderColor-attention-muted) bg-(--bgColor-attention-muted)', fg: 'text-(--fgColor-attention)' },
  danger: { icon: StopIcon, box: 'border-(--borderColor-danger-muted) bg-(--bgColor-danger-muted)', fg: 'text-(--fgColor-danger)' },
};

export function Flash({ variant = 'default', children }: { variant?: FlashVariant; children: ReactNode }) {
  const { icon: FlashIcon, box, fg } = VARIANT[variant];
  return (
    <div role={variant === 'danger' ? 'alert' : undefined} className={`flex items-start gap-2 rounded-md border px-4 py-3 text-sm text-fg ${box}`}>
      <FlashIcon size={16} className={`mt-0.5 shrink-0 ${fg}`} aria-hidden="true" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
