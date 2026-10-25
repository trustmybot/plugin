import { labelClass, type LabelVariant } from '../../ui/Label.tsx';

export function parseLabels(raw: unknown): string[] {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((l): l is string => typeof l === 'string') : [];
}

export function issueLabelVariant(label: string): LabelVariant {
  if (label === 'Bug') return 'danger';
  if (label === 'Feature') return 'accent';
  if (label === 'Improvement') return 'success';
  if (label === 'Docs') return 'attention';
  if (label.startsWith('Area:')) return 'done';
  if (label === 'Priority: Urgent') return 'severe';
  if (label === 'Priority: High') return 'attention';
  return 'secondary';
}

const FILL: Record<LabelVariant, string> = {
  default: 'bg-(--bgColor-neutral-muted)',
  primary: 'bg-(--bgColor-neutral-muted)',
  secondary: 'bg-(--bgColor-neutral-muted)',
  accent: 'bg-(--bgColor-accent-muted)',
  success: 'bg-(--bgColor-success-muted)',
  attention: 'bg-(--bgColor-attention-muted)',
  severe: 'bg-(--bgColor-severe-muted)',
  danger: 'bg-(--bgColor-danger-muted)',
  done: 'bg-(--bgColor-done-muted)',
};

export function IssueLabel({ name, variant = issueLabelVariant(name) }: { name: string; variant?: LabelVariant }) {
  return <span className={`${labelClass(variant)} ${FILL[variant]}`}>{name}</span>;
}

const KIND_VARIANT: Record<string, LabelVariant> = {
  intent: 'accent',
  decision: 'done',
  question: 'attention',
  answer: 'success',
  analysis: 'severe',
};

export const kindVariant = (kind: string): LabelVariant => KIND_VARIANT[kind] ?? 'secondary';
