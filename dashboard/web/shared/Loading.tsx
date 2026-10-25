import type { ReactNode } from 'react';

export function Loading<T>({ q, children }: { q: { data?: T; error: Error | null }; children: (data: T) => ReactNode }) {
  if (q.error) return <p className="text-red-600">{q.error.message}</p>;
  if (q.data === undefined) return <p className="text-zinc-500">Loading…</p>;
  return <>{children(q.data)}</>;
}
