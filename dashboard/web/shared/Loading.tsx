import type { ReactNode } from 'react';
import { Flash } from '../ui/Flash.tsx';

export function Loading<T>({ q, children }: { q: { data?: T; error: Error | null }; children: (data: T) => ReactNode }) {
  if (q.error) return <Flash variant="danger">{q.error.message}</Flash>;
  if (q.data === undefined) return <p className="text-fg-muted">Loading…</p>;
  return <>{children(q.data)}</>;
}
