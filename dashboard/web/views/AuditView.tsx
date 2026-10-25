import { useApi, type Row } from '../api.ts';
import { DataTable, type Column } from '../DataTable.tsx';
import { time } from '../shared/columns.tsx';
import { Loading } from '../shared/Loading.tsx';
import { Label } from '../ui/Label.tsx';
import { Subhead } from './RunsView.tsx';

const AUDIT_COLUMNS: Column[] = [
  { key: 'created_at', header: 'At', cell: time('created_at') },
  { key: 'issue_id', header: 'Issue', hideBelow: 'sm' },
  { key: 'branch_id', header: 'Branch', cell: (r) => <span className="font-mono text-xs">{String(r['branch_id'] ?? '')}</span>, hideBelow: 'md' },
  { key: 'from_node', header: 'From', hideBelow: 'sm' },
  { key: 'event_type', header: 'Event', cell: (r) => <Label variant="secondary">{String(r['event_type'] ?? '—')}</Label> },
  { key: 'summary', header: 'Summary', truncate: true },
];

export function AuditView() {
  const q = useApi<Row[]>('audit?limit=300');
  return (
    <section>
      <Subhead>Audit feed</Subhead>
      <Loading q={q}>{(rows) => <DataTable rows={rows} columns={AUDIT_COLUMNS} />}</Loading>
    </section>
  );
}
