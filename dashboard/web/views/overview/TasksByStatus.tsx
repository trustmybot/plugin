import { TasklistIcon } from '@primer/octicons-react';
import type { Summary } from '../../api.ts';
import { Badge, statusVariant } from '../../shared/Badge.tsx';
import { Blankslate } from '../../ui/Blankslate.tsx';
import { Box, BoxHeader, BoxRow } from '../../ui/Box.tsx';
import { CounterLabel } from '../../ui/CounterLabel.tsx';
import type { LabelVariant } from '../../ui/Label.tsx';
import { ProgressBar } from '../../ui/ProgressBar.tsx';

const FILL: Record<LabelVariant, string> = {
  default: 'bg-(--bgColor-neutral-emphasis)',
  primary: 'bg-(--bgColor-neutral-emphasis)',
  secondary: 'bg-(--bgColor-neutral-emphasis)',
  accent: 'bg-(--bgColor-accent-emphasis)',
  success: 'bg-(--bgColor-success-emphasis)',
  attention: 'bg-(--bgColor-attention-emphasis)',
  severe: 'bg-(--bgColor-severe-emphasis)',
  danger: 'bg-(--bgColor-danger-emphasis)',
  done: 'bg-(--bgColor-done-emphasis)',
};

export const byCount = (rows: Summary['tasks_by_status']) =>
  [...rows].sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));

export function TasksByStatus({ rows }: { rows: Summary['tasks_by_status'] }) {
  const total = rows.reduce((n, t) => n + t.count, 0);
  return (
    <Box className="min-w-0">
      <BoxHeader className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-fg">Tasks by status</h2>
        <a href="#/tasks" className="text-xs text-accent hover:underline">
          View all tasks
        </a>
      </BoxHeader>
      {rows.length === 0 ? (
        <Blankslate icon={TasklistIcon} heading="No tasks yet" />
      ) : (
        byCount(rows).map((t) => (
          <BoxRow key={t.status} data-status={t.status} className="grid grid-cols-[minmax(0,9rem)_auto_minmax(0,1fr)] items-center gap-3">
            <span className="min-w-0 truncate">
              <Badge value={t.status} />
            </span>
            <CounterLabel>{t.count}</CounterLabel>
            <ProgressBar value={t.count} max={total} label={`${t.count} of ${total} tasks`} fill={FILL[statusVariant(t.status)]} />
          </BoxRow>
        ))
      )}
    </Box>
  );
}
