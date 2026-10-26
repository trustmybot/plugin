import type { Row } from '../api.ts';
import type { Column } from '../DataTable.tsx';
import { RelativeTime } from '../ui/RelativeTime.tsx';
import { Badge } from './Badge.tsx';

export const badge = (key: string) => (r: Row) => <Badge value={r[key]} />;
export const time = (key: string) => (r: Row) => <span className="text-fg-muted"><RelativeTime value={r[key]} /></span>;
export const exitBadge = (r: Row) =>
  r['exit_code'] === null || r['exit_code'] === undefined ? <Badge value="running" /> : <Badge value={r['exit_code'] === 0 ? 'pass' : 'fail'} />;

const TASK_LINK = 'text-fg hover:text-accent hover:underline';

export const taskLink = (key: 'task_id' | 'task_title') => (r: Row) =>
  r['task_id'] === null || r['task_id'] === undefined ? (
    <span className="text-fg-muted">—</span>
  ) : (
    <a href={`#/tasks/${String(r['task_id'])}`} className={TASK_LINK} onClick={(e) => e.stopPropagation()}>
      {String(r[key] ?? '')}
    </a>
  );

export const TASK_ID_COLUMN: Column = { key: 'task_id', header: 'Task', cell: taskLink('task_id') };
export const TASK_TITLE_COLUMN: Column = { key: 'task_title', header: 'Title', cell: taskLink('task_title'), truncate: true, hideBelow: 'md' };

export const RUN_COLUMNS: Column[] = [
  { key: 'id', header: 'Run', hideBelow: 'sm' },
  { key: 'agent_type', header: 'Agent' },
  { ...TASK_ID_COLUMN, hideBelow: 'sm' },
  TASK_TITLE_COLUMN,
  { key: 'started_at', header: 'Started', cell: time('started_at') },
  { key: 'exit_reason', header: 'Exit', cell: (r) => <Badge value={r['completed_at'] ? r['exit_reason'] ?? 'completed' : 'running'} /> },
];
