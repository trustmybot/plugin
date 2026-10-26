import {
  AlertIcon,
  CheckCircleFillIcon,
  CheckCircleIcon,
  CircleIcon,
  DotFillIcon,
  EyeIcon,
  XCircleIcon,
  type Icon,
} from '@primer/octicons-react';
import { LABEL_COLORS } from '../ui/Label.tsx';
import { statusVariant } from './Badge.tsx';

export const TASK_STATUSES = ['pending', 'running', 'needs_validation', 'completed', 'closed', 'failed', 'escalated'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATE_ICON: Record<TaskStatus, Icon> = {
  pending: CircleIcon,
  running: DotFillIcon,
  needs_validation: EyeIcon,
  completed: CheckCircleIcon,
  closed: CheckCircleFillIcon,
  failed: XCircleIcon,
  escalated: AlertIcon,
};

const textClass = (classes: string) => classes.split(' ').find((c) => c.startsWith('text-')) ?? 'text-fg';

export function taskState(status: unknown): { icon: Icon; className: string } {
  const s = String(status ?? '');
  return {
    icon: TASK_STATE_ICON[s as TaskStatus] ?? CircleIcon,
    className: textClass(LABEL_COLORS[statusVariant(s)]),
  };
}
