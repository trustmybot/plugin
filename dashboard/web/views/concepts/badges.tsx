import type { Trust } from '../../api.ts';
import { Label, labelClass, type LabelVariant } from '../../ui/Label.tsx';
import { CONCEPT_COPY, TRUST_LABEL } from './copy.ts';

export const TRUST_VARIANT: Record<Trust, LabelVariant> = {
  verified: 'success',
  suspect: 'attention',
  broken: 'danger',
};

export function TrustBadge({ trust, count }: { trust: Trust; count?: number }) {
  const { icon: TrustIcon, label } = TRUST_LABEL[trust];
  return (
    <Label variant={TRUST_VARIANT[trust]}>
      <TrustIcon size={12} aria-hidden="true" />
      {count === undefined ? label : `${count} ${label}`}
    </Label>
  );
}

export function DerivedBadge() {
  return <span className={`${labelClass('secondary')} border-dashed`}>{CONCEPT_COPY.derived}</span>;
}
