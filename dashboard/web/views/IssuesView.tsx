import { useApi, type Row } from '../api.ts';
import { DataTable, type Column } from '../DataTable.tsx';
import { badge, time } from '../shared/columns.tsx';
import { Loading } from '../shared/Loading.tsx';
import { go } from '../shared/route.ts';

const ISSUE_COLUMNS: Column[] = [
  { key: 'id', header: '#' },
  { key: 'objective', header: 'Objective', truncate: true },
  { key: 'status', header: 'Status', cell: badge('status') },
  { key: 'repo', header: 'Repo' },
  { key: 'gh_iid', header: 'GH' },
  { key: 'tasks_done', header: 'Tasks', cell: (r) => `${r['tasks_done']}/${r['task_count']}` },
  { key: 'updated_at', header: 'Updated', cell: time('updated_at') },
];

export function IssuesView() {
  const q = useApi<Row[]>('issues');
  return <Loading q={q}>{(rows) => <DataTable rows={rows} columns={ISSUE_COLUMNS} onRowClick={(r) => go(`issues/${r['id']}`)} />}</Loading>;
}
