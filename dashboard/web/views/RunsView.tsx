import { useApi, type Gates, type Row } from '../api.ts';
import { DataTable, type Column } from '../DataTable.tsx';
import { badge, exitBadge, RUN_COLUMNS, time } from '../shared/columns.tsx';
import { Loading } from '../shared/Loading.tsx';

const AGENT_RUN_COLUMNS: Column[] = [
  ...RUN_COLUMNS,
  { key: 'model', header: 'Model' },
  { key: 'tokens_out', header: 'Tokens out' },
  { key: 'duration_ms', header: 'Duration', cell: (r) => `${Math.round(Number(r['duration_ms'] ?? 0) / 1000)}s` },
];

const VALIDATION_COLUMNS: Column[] = [
  { key: 'id', header: 'ID' },
  { key: 'task_id', header: 'Task' },
  { key: 'task_title', header: 'Title', truncate: true },
  { key: 'attempt_n', header: 'Attempt' },
  { key: 'agent', header: 'Agent' },
  { key: 'verdict', header: 'Verdict', cell: badge('verdict') },
  { key: 'created_at', header: 'At', cell: time('created_at') },
];

const VERIFICATION_COLUMNS: Column[] = [
  { key: 'id', header: 'Run' },
  { key: 'task_id', header: 'Task' },
  { key: 'task_title', header: 'Title', truncate: true },
  { key: 'commit_sha', header: 'Commit', cell: (r) => String(r['commit_sha'] ?? '').slice(0, 8) },
  { key: 'source', header: 'Source' },
  { key: 'exit_code', header: 'Result', cell: exitBadge },
  { key: 'failed_commands', header: 'Failed', cell: (r) => `${r['failed_commands']}/${r['commands']}` },
  { key: 'started_at', header: 'Started', cell: time('started_at') },
];

export function RunsView() {
  const runs = useApi<Row[]>('agent-runs');
  const gates = useApi<Gates>('gates');
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="font-medium">Agent runs</h2>
        <Loading q={runs}>{(rows) => <DataTable rows={rows} columns={AGENT_RUN_COLUMNS} />}</Loading>
      </section>
      <Loading q={gates}>
        {(g) => (
          <>
            <section className="space-y-2">
              <h2 className="font-medium">Review verdicts</h2>
              <DataTable rows={g.validations} columns={VALIDATION_COLUMNS} />
            </section>
            <section className="space-y-2">
              <h2 className="font-medium">Verification runs</h2>
              <DataTable rows={g.verifications} columns={VERIFICATION_COLUMNS} />
            </section>
          </>
        )}
      </Loading>
    </div>
  );
}
