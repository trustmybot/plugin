import { useApi, type Row } from '../api.ts';
import { DataTable, type Column } from '../DataTable.tsx';
import { time } from '../shared/columns.tsx';
import { Loading } from '../shared/Loading.tsx';

const AUDIT_COLUMNS: Column[] = [
  { key: 'created_at', header: 'At', cell: time('created_at') },
  { key: 'issue_id', header: 'Issue' },
  { key: 'branch_id', header: 'Branch' },
  { key: 'from_node', header: 'From' },
  { key: 'event_type', header: 'Event' },
  { key: 'summary', header: 'Summary', truncate: true },
];

export function AuditView() {
  const q = useApi<Row[]>('audit?limit=300');
  return <Loading q={q}>{(rows) => <DataTable rows={rows} columns={AUDIT_COLUMNS} />}</Loading>;
}
