import {
  CheckCircleFillIcon,
  CheckCircleIcon,
  CircleIcon,
  DotFillIcon,
  SkipIcon,
  VersionsIcon,
  XCircleIcon,
  type Icon,
} from '@primer/octicons-react';
import { LABEL_COLORS } from '../ui/Label.tsx';
import { statusVariant } from './Badge.tsx';

// The server's tasks.status set, in its order; list.test.mjs fails when the two drift.
export const TASK_STATUSES = ['pending', 'running', 'submitted', 'failed', 'closed', 'superseded', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATE_ICON: Record<TaskStatus, Icon> = {
  pending: CircleIcon,
  running: DotFillIcon,
  submitted: CheckCircleIcon,
  failed: XCircleIcon,
  closed: CheckCircleFillIcon,
  superseded: VersionsIcon,
  cancelled: SkipIcon,
};

const textClass = (classes: string) => classes.split(' ').find((c) => c.startsWith('text-')) ?? 'text-fg';

export function taskState(status: unknown): { icon: Icon; className: string } {
  const s = String(status ?? '');
  return {
    icon: TASK_STATE_ICON[s as TaskStatus] ?? CircleIcon,
    className: textClass(LABEL_COLORS[statusVariant(s)]),
  };
}
