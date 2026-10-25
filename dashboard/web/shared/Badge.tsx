import { Label, LABEL_COLORS, type LabelVariant } from '../ui/Label.tsx';

export const STATUS_VARIANT: Record<string, LabelVariant> = {
  open: 'accent',
  running: 'attention',
  suspect: 'attention',
  needs_validation: 'done',
  completed: 'success',
  pass: 'success',
  verified: 'success',
  closed: 'secondary',
  failed: 'danger',
  fail: 'danger',
  broken: 'danger',
  escalated: 'severe',
  escalate: 'severe',
};

export const statusVariant = (status: string): LabelVariant => STATUS_VARIANT[status] ?? 'default';

export const STATUS_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(STATUS_VARIANT).map(([status, variant]) => [status, `border ${LABEL_COLORS[variant]}`]),
);

export function Badge({ value }: { value: unknown }) {
  const s = String(value ?? '—');
  return <Label variant={statusVariant(s)}>{s}</Label>;
}
