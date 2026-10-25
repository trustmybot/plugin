// Forked from Primer CSS Box (github.com/primer/css, MIT), rebuilt on Primer border and canvas tokens without Primer CSS.
import type { HTMLAttributes } from 'react';

type Props = HTMLAttributes<HTMLElement>;
const join = (base: string, extra?: string) => (extra ? `${base} ${extra}` : base);

export function Box({ className, ...rest }: Props) {
  return <div {...rest} className={join('rounded-md border border-(--borderColor-default) bg-canvas', className)} />;
}

export function BoxHeader({ className, ...rest }: Props) {
  return <header {...rest} className={join('rounded-t-md border-b border-(--borderColor-default) bg-canvas-muted px-4 py-3', className)} />;
}

export function BoxRow({ className, ...rest }: Props) {
  return <div {...rest} className={join('border-t border-(--borderColor-muted) px-4 py-3 first:border-t-0 [header+&]:border-t-0', className)} />;
}
