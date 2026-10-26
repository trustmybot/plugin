import type { ReactNode } from 'react';
import { useApi, type Gates, type Row } from '../api.ts';
import { DataTable, type Column } from '../DataTable.tsx';
import { agentCell, badge, exitBadge, RUN_COLUMNS, TASK_ID_COLUMN, TASK_TITLE_COLUMN, time } from '../shared/columns.tsx';
import { Loading } from '../shared/Loading.tsx';

const mono = (key: string, length?: number) => (r: Row) => <span className="font-mono text-xs">{String(r[key] ?? '').slice(0, length)}</span>;

const AGENT_RUN_COLUMNS: Column[] = [
  ...RUN_COLUMNS,
  { key: 'model', header: 'Model', hideBelow: 'md' },
  { key: 'tokens_out', header: 'Tokens out', hideBelow: 'md' },
  { key: 'duration_ms', header: 'Duration', cell: (r) => `${Math.round(Number(r['duration_ms'] ?? 0) / 1000)}s`, hideBelow: 'sm' },
];

const VALIDATION_COLUMNS: Column[] = [
  { key: 'id', header: 'ID', cell: mono('id') },
  { ...TASK_ID_COLUMN, hideBelow: 'sm' },
  TASK_TITLE_COLUMN,
  { key: 'attempt_n', header: 'Attempt', hideBelow: 'sm' },
  { key: 'agent', header: 'Agent', cell: agentCell('agent'), hideBelow: 'md' },
  { key: 'verdict', header: 'Verdict', cell: badge('verdict') },
  { key: 'created_at', header: 'At', cell: time('created_at') },
];

const VERIFICATION_COLUMNS: Column[] = [
  { key: 'id', header: 'Run', hideBelow: 'sm' },
  TASK_ID_COLUMN,
  TASK_TITLE_COLUMN,
  { key: 'commit_sha', header: 'Commit', cell: mono('commit_sha', 8), hideBelow: 'sm' },
  { key: 'source', header: 'Source', hideBelow: 'md' },
  { key: 'exit_code', header: 'Result', cell: exitBadge },
  { key: 'failed_commands', header: 'Failed', cell: (r) => `${r['failed_commands']}/${r['commands']}`, hideBelow: 'sm' },
  { key: 'started_at', header: 'Started', cell: time('started_at') },
];

export function Subhead({ children }: { children: ReactNode }) {
  return <h2 className="mb-4 border-b border-(--borderColor-muted) pb-2 text-base font-semibold text-fg">{children}</h2>;
}

export function RunsView() {
  const runs = useApi<Row[]>('agent-runs');
  const gates = useApi<Gates>('gates');
  return (
    <div className="space-y-8">
      <section>
        <Subhead>Agent runs</Subhead>
        <Loading q={runs}>{(rows) => <DataTable rows={rows} columns={AGENT_RUN_COLUMNS} />}</Loading>
      </section>
      <Loading q={gates}>
        {(g) => (
          <>
            <section>
              <Subhead>Review verdicts</Subhead>
              <DataTable rows={g.validations} columns={VALIDATION_COLUMNS} />
            </section>
            <section>
              <Subhead>Verification runs</Subhead>
              <DataTable rows={g.verifications} columns={VERIFICATION_COLUMNS} />
            </section>
          </>
        )}
      </Loading>
    </div>
  );
}
