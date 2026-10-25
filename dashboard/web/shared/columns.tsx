import type { Row } from '../api.ts';
import type { Column } from '../DataTable.tsx';
import { RelativeTime } from '../ui/RelativeTime.tsx';
import { Badge } from './Badge.tsx';

export const badge = (key: string) => (r: Row) => <Badge value={r[key]} />;
export const time = (key: string) => (r: Row) => <span className="text-fg-muted"><RelativeTime value={r[key]} /></span>;
export const exitBadge = (r: Row) =>
  r['exit_code'] === null || r['exit_code'] === undefined ? <Badge value="running" /> : <Badge value={r['exit_code'] === 0 ? 'pass' : 'fail'} />;

export const RUN_COLUMNS: Column[] = [
  { key: 'id', header: 'Run', hideBelow: 'sm' },
  { key: 'agent_type', header: 'Agent' },
  { key: 'task_id', header: 'Task', hideBelow: 'sm' },
  { key: 'task_title', header: 'Title', truncate: true, hideBelow: 'md' },
  { key: 'started_at', header: 'Started', cell: time('started_at') },
  { key: 'exit_reason', header: 'Exit', cell: (r) => <Badge value={r['completed_at'] ? r['exit_reason'] ?? 'completed' : 'running'} /> },
];
