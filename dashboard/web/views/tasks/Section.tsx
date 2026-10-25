import type { ReactNode } from 'react';

export const Muted = ({ children }: { children: ReactNode }) => <p className="text-sm text-fg-muted">{children}</p>;

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="border-b border-(--borderColor-muted) pb-2 text-base font-semibold text-fg">{title}</h3>
      {children}
    </section>
  );
}
