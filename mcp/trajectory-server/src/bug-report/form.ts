// The TMB bug-report form as data: field order, labels, types and options shared by the draft tool and bug.yml.

export type FieldType = 'input' | 'textarea' | 'dropdown' | 'checkboxes';

export interface CheckOption {
  readonly label: string;
  readonly required: boolean;
}

export interface FormField {
  readonly id: string;
  readonly label: string;
  readonly type: FieldType;
  readonly required: boolean;
  readonly render?: 'shell' | 'text';
  readonly options?: readonly string[] | readonly CheckOption[];
}

export const FREQUENCY_OPTIONS = ['Every time', 'Sometimes', 'Once'] as const;

export const AREA_OPTIONS = [
  'Hooks',
  'Trajectory Server',
  'World Model',
  'Dashboard',
  'Install',
  'Agents',
  'Cheatcode',
  'Adapters',
  'Release',
] as const;

export const IMPACT_OPTIONS = [
  'Blocks all TMB work',
  'Blocks one task, has a workaround',
  'Annoying or cosmetic',
] as const;

export const CHECK_OPTIONS: readonly CheckOption[] = [
  { label: 'I searched existing issues for this error.', required: true },
  { label: 'I read this report and it contains no secrets, private code or personal paths.', required: true },
  { label: 'It still happens on the latest version.', required: false },
];

export const FORM_FIELDS = [
  { id: 'summary', label: 'What broke', type: 'input', required: true },
  { id: 'what-happened', label: 'Expected vs actual', type: 'textarea', required: true },
  { id: 'reproduce', label: 'Steps to reproduce', type: 'textarea', required: true },
  { id: 'repro-script', label: 'Minimal repro script', type: 'textarea', required: false, render: 'shell' },
  { id: 'frequency', label: 'How often', type: 'dropdown', required: true, options: FREQUENCY_OPTIONS },
  { id: 'error', label: 'Error message', type: 'textarea', required: true, render: 'text' },
  { id: 'area', label: 'Area', type: 'dropdown', required: true, options: AREA_OPTIONS },
  { id: 'impact', label: 'Impact', type: 'dropdown', required: true, options: IMPACT_OPTIONS },
  { id: 'environment', label: 'Environment', type: 'textarea', required: true, render: 'text' },
  { id: 'doctor', label: 'Doctor output', type: 'textarea', required: false, render: 'text' },
  { id: 'workaround', label: 'Workaround', type: 'textarea', required: false },
  { id: 'checks', label: 'Checks', type: 'checkboxes', required: true, options: CHECK_OPTIONS },
] as const satisfies readonly FormField[];

export type FieldId = (typeof FORM_FIELDS)[number]['id'];

export const IMPACT_PRIORITY: Readonly<Record<(typeof IMPACT_OPTIONS)[number], string>> = {
  'Blocks all TMB work': 'Priority: High',
  'Blocks one task, has a workaround': 'Priority: Medium',
  'Annoying or cosmetic': 'Priority: Low',
};

export const REPORT_MARKER_RE = /<!-- tmb-report v1 sig=([0-9a-f]{12}) -->/;
