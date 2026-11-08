import type { LabelTaxonomy } from '../../api.ts';
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

const CLASSIFICATION_VARIANTS: LabelVariant[] = ['danger', 'accent', 'success', 'attention', 'done', 'severe'];
const PRIORITY_VARIANTS: LabelVariant[] = ['severe', 'attention'];

export function issueLabelVariant(label: string, taxonomy: LabelTaxonomy): LabelVariant {
  const classification = taxonomy.classification.indexOf(label);
  if (classification >= 0) return CLASSIFICATION_VARIANTS[classification % CLASSIFICATION_VARIANTS.length];
  const priority = taxonomy.priority.indexOf(label);
  if (priority >= 0) return PRIORITY_VARIANTS[priority] ?? 'secondary';
  if (taxonomy.area.includes(label)) return 'done';
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

export function IssueLabel({ name, taxonomy }: { name: string; taxonomy: LabelTaxonomy }) {
  const variant = issueLabelVariant(name, taxonomy);
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
