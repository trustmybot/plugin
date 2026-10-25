import type { ReactNode } from 'react';
import { useApi, type Summary } from '../api.ts';
import { DataTable } from '../DataTable.tsx';
import { Badge } from '../shared/Badge.tsx';
import { RUN_COLUMNS } from '../shared/columns.tsx';
import { Loading } from '../shared/Loading.tsx';

function Card({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
}

export function OverviewView() {
  const q = useApi<Summary>('summary');
  return (
    <Loading q={q}>
      {(s) => (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card label="Open issues" value={s.issues.open ?? 0} />
            <Card label="Closed issues" value={s.issues.closed ?? 0} />
            <Card label="Agents running" value={s.open_runs} />
            <Card label="Tasks" value={s.tasks_by_status.reduce((n, t) => n + t.count, 0)} />
          </div>
          <section className="space-y-2">
            <h2 className="font-medium">Tasks by status</h2>
            <div className="flex flex-wrap gap-2">
              {s.tasks_by_status.map((t) => (
                <span key={t.status} className="flex items-center gap-1 text-sm">
                  <Badge value={t.status} /> {t.count}
                </span>
              ))}
            </div>
          </section>
          <section className="space-y-2">
            <h2 className="font-medium">Recent agent runs</h2>
            <DataTable rows={s.recent_runs} columns={RUN_COLUMNS} filter={false} />
          </section>
        </div>
      )}
    </Loading>
  );
}
