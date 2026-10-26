import type { LabelVariant } from '../ui/Label.tsx';

export const VERDICT_VARIANT: Record<string, LabelVariant> = {
  pass: 'success',
  fail: 'danger',
  escalate: 'severe',
};

export const CRITERION_VARIANT: Record<string, LabelVariant> = {
  met: 'success',
  not_met: 'danger',
  not_applicable: 'secondary',
};

export const FINDING_VARIANT: Record<string, LabelVariant> = {
  open: 'attention',
  fixed: 'success',
  wontfix: 'secondary',
};

export const verdictVariant = (v: unknown): LabelVariant => VERDICT_VARIANT[String(v)] ?? 'default';
export const criterionVariant = (v: unknown): LabelVariant => CRITERION_VARIANT[String(v)] ?? 'default';
export const findingVariant = (v: unknown): LabelVariant => FINDING_VARIANT[String(v)] ?? 'default';

export const statusText = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v).replace(/_/g, ' '));
