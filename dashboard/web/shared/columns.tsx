import type { Row } from '../api.ts';
import type { Column } from '../DataTable.tsx';
import { RelativeTime } from '../ui/RelativeTime.tsx';
import { Avatar } from '../views/issues/Avatar.tsx';
import { Badge } from './Badge.tsx';

export const badge = (key: string) => (r: Row) => <Badge value={r[key]} />;
export const time = (key: string) => (r: Row) => <span className="text-fg-muted"><RelativeTime value={r[key]} /></span>;
export const exitBadge = (r: Row) =>
  r['exit_code'] === null || r['exit_code'] === undefined ? <Badge value="running" /> : <Badge value={r['exit_code'] === 0 ? 'pass' : 'fail'} />;

export const ENTITY_LINK =
  'rounded-sm text-inherit hover:text-accent hover:underline focus-visible:text-accent focus-visible:underline focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color) focus-visible:outline-offset-1';

export type EntityKind = 'task' | 'issue' | 'branch';

export function hrefFor(kind: EntityKind, id: unknown): string {
  const value = String(id);
  switch (kind) {
    case 'task': return `#/tasks/${encodeURIComponent(value)}`;
    case 'issue': return `#/issues/${encodeURIComponent(value)}`;
    case 'branch': return `#/tasks?branch=${encodeURIComponent(value)}`;
  }
}

export const agentCell = (key: string) => (r: Row) => {
  const name = String(r[key] ?? '');
  return name ? (
    <span className="inline-flex items-center gap-1.5">
      <Avatar author={name} size="small" />
      {name}
    </span>
  ) : (
    <span className="text-fg-muted">—</span>
  );
};

export const entityLink = (kind: EntityKind, idKey: string, labelKey: string = idKey) => (r: Row) =>
  r[idKey] === null || r[idKey] === undefined || r[idKey] === '' ? (
    <span className="text-fg-muted">—</span>
  ) : (
    <a href={hrefFor(kind, r[idKey])} className={ENTITY_LINK} onClick={(e) => e.stopPropagation()}>
      {String(r[labelKey] ?? '')}
    </a>
  );

export const TASK_ID_COLUMN: Column = { key: 'task_id', header: 'Task', cell: entityLink('task', 'task_id') };
export const TASK_TITLE_COLUMN: Column = { key: 'task_title', header: 'Title', cell: entityLink('task', 'task_id', 'task_title'), truncate: true, hideBelow: 'md' };

export const RUN_COLUMNS: Column[] = [
  { key: 'id', header: 'Run', hideBelow: 'sm' },
  { key: 'agent_type', header: 'Agent', cell: agentCell('agent_type') },
  { ...TASK_ID_COLUMN, hideBelow: 'sm' },
  TASK_TITLE_COLUMN,
  { key: 'started_at', header: 'Started', cell: time('started_at') },
  { key: 'exit_reason', header: 'Exit', cell: (r) => <Badge value={r['completed_at'] ? r['exit_reason'] ?? 'completed' : 'running'} /> },
];
