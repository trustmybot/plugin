import { GitBranchIcon } from '@primer/octicons-react';
import { useApi, type Row } from '../api.ts';
import { DataTable, type Column } from '../DataTable.tsx';
import { badge, time } from '../shared/columns.tsx';
import { Loading } from '../shared/Loading.tsx';
import { go } from '../shared/route.ts';
import { CounterLabel } from '../ui/CounterLabel.tsx';

const DASH = <span className="text-fg-muted">—</span>;

const taskCell = (r: Row) => (
  <div className="min-w-48 whitespace-normal">
    <a href={`#/tasks/${r['id']}`} className="font-semibold text-fg hover:text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
      {String(r['title'] ?? '')}
    </a>
    <div className="text-xs text-fg-muted">
      #{String(r['id'])} ·{' '}
      <a href={`#/issues/${r['issue_id']}`} className="hover:text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
        issue #{String(r['issue_id'])}
      </a>
    </div>
  </div>
);

const branchCell = (r: Row) =>
  r['branch_id'] ? (
    <span className="inline-flex items-center gap-1 font-mono text-xs text-fg-muted">
      <GitBranchIcon size={16} aria-hidden="true" />
      {String(r['branch_id'])}
    </span>
  ) : (
    DASH
  );

const effortCell = (r: Row) => (r['effort'] ? <CounterLabel>{String(r['effort'])}</CounterLabel> : DASH);

const TASK_COLUMNS: Column[] = [
  { key: 'title', header: 'Task', cell: taskCell },
  { key: 'status', header: 'Status', cell: badge('status') },
  { key: 'branch_id', header: 'Branch', cell: branchCell, hideBelow: 'sm' },
  { key: 'effort', header: 'Effort', cell: effortCell, hideBelow: 'sm' },
  { key: 'repo', header: 'Repo', hideBelow: 'md' },
  { key: 'updated_at', header: 'Updated', cell: time('updated_at') },
];

export function TasksView() {
  const q = useApi<Row[]>('tasks');
  return <Loading q={q}>{(rows) => <DataTable rows={rows} columns={TASK_COLUMNS} onRowClick={(r) => go(`tasks/${r['id']}`)} />}</Loading>;
}
