import type { Trust } from '../../api.ts';
import { STATUS_COLORS } from '../../shared/Badge.tsx';
import { CONCEPT_COPY, TRUST_LABEL } from './copy.ts';

export function TrustBadge({ trust, count }: { trust: Trust; count?: number }) {
  const { icon, label } = TRUST_LABEL[trust];
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${STATUS_COLORS[trust]}`}>
      <span aria-hidden="true">{icon}</span>
      {count === undefined ? label : `${count} ${label}`}
    </span>
  );
}

export function DerivedBadge() {
  return (
    <span className="rounded border border-dashed border-zinc-500 px-1.5 py-0.5 text-xs text-zinc-800 dark:border-zinc-400 dark:text-zinc-200">
      {CONCEPT_COPY.derived}
    </span>
  );
}
