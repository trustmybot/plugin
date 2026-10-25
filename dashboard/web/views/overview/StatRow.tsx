import { IssueClosedIcon, IssueOpenedIcon, PlayIcon, TasklistIcon, type Icon } from '@primer/octicons-react';
import type { Summary } from '../../api.ts';

type Stat = { label: string; value: number; href: string; icon: Icon; iconClass: string };

export const stats = (s: Summary): Stat[] => [
  { label: 'Open issues', value: s.issues.open ?? 0, href: '#/issues', icon: IssueOpenedIcon, iconClass: 'text-(--fgColor-open)' },
  { label: 'Closed issues', value: s.issues.closed ?? 0, href: '#/issues', icon: IssueClosedIcon, iconClass: 'text-(--fgColor-done)' },
  { label: 'Agents running', value: s.open_runs, href: '#/runs', icon: PlayIcon, iconClass: 'text-(--fgColor-attention)' },
  { label: 'Tasks', value: s.tasks_by_status.reduce((n, t) => n + t.count, 0), href: '#/tasks', icon: TasklistIcon, iconClass: 'text-fg-muted' },
];

export function StatRow({ summary }: { summary: Summary }) {
  return (
    <nav aria-label="Totals" className="grid grid-cols-2 overflow-hidden rounded-md border border-(--borderColor-default) bg-canvas md:grid-cols-4">
      {stats(summary).map(({ label, value, href, icon: StatIcon, iconClass }, i) => (
        <a
          key={label}
          href={href}
          className={`group flex min-w-0 items-center gap-3 border-(--borderColor-muted) p-4 hover:bg-canvas-muted focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color) focus-visible:-outline-offset-2 ${
            i % 2 === 1 ? 'border-l' : ''
          } ${i >= 2 ? 'border-t md:border-t-0' : ''} ${i === 2 ? 'md:border-l' : ''}`}
        >
          <StatIcon size={24} className={`shrink-0 ${iconClass}`} aria-hidden="true" />
          <span className="min-w-0">
            <span className="block text-2xl font-semibold leading-tight text-fg">{value}</span>
            <span className="block truncate text-sm text-fg-muted group-hover:text-accent">{label}</span>
          </span>
        </a>
      ))}
    </nav>
  );
}
