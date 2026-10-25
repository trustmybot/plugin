import { useApi, type Row } from '../api.ts';
import { DataTable, type Column } from '../DataTable.tsx';
import { badge, time } from '../shared/columns.tsx';
import { Loading } from '../shared/Loading.tsx';
import { go } from '../shared/route.ts';

const TASK_COLUMNS: Column[] = [
  { key: 'id', header: 'Task' },
  { key: 'issue_id', header: 'Issue' },
  { key: 'title', header: 'Title', truncate: true },
  { key: 'branch_id', header: 'Branch' },
  { key: 'status', header: 'Status', cell: badge('status') },
  { key: 'effort', header: 'Effort' },
  { key: 'repo', header: 'Repo' },
  { key: 'updated_at', header: 'Updated', cell: time('updated_at') },
];

export function TasksView() {
  const q = useApi<Row[]>('tasks');
  return <Loading q={q}>{(rows) => <DataTable rows={rows} columns={TASK_COLUMNS} onRowClick={(r) => go(`issues/${r['issue_id']}`)} />}</Loading>;
}
