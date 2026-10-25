import type { Row, Summary } from '../../api.ts';
import { DataTable } from '../../DataTable.tsx';
import { RUN_COLUMNS } from '../../shared/columns.tsx';
import { OpenIssues } from './OpenIssues.tsx';
import { StatRow } from './StatRow.tsx';
import { TasksByStatus } from './TasksByStatus.tsx';

export function Overview({ summary, issues }: { summary: Summary; issues: { data?: Row[]; error: Error | null } }) {
  return (
    <div className="min-w-0 space-y-6">
      <StatRow summary={summary} />
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <OpenIssues q={issues} />
        <TasksByStatus rows={summary.tasks_by_status} />
      </div>
      <section className="min-w-0 space-y-3">
        <div className="flex items-center justify-between gap-2 border-b border-(--borderColor-muted) pb-2">
          <h2 className="text-xl font-normal text-fg">Recent agent runs</h2>
          <a href="#/runs" className="text-sm text-accent hover:underline">
            View all runs
          </a>
        </div>
        <DataTable rows={summary.recent_runs} columns={RUN_COLUMNS} filter={false} />
      </section>
    </div>
  );
}
