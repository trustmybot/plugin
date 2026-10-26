import { AlertIcon, CheckIcon, GitBranchIcon, IssueOpenedIcon, ReportIcon, TasklistIcon, XIcon } from '@primer/octicons-react';
import { useApi, type Row } from '../api.ts';
import { FIELD } from '../shared/classes.ts';
import { ENTITY_LINK, hrefFor } from '../shared/columns.tsx';
import { EntityList, type ListChip, type ListSort, type ListTab } from '../shared/list/EntityList.tsx';
import { ListRow } from '../shared/list/ListRow.tsx';
import { useListParams } from '../shared/list/useListParams.ts';
import { Loading } from '../shared/Loading.tsx';
import { hrefWith } from '../shared/route.ts';
import { TASK_STATUSES, taskState } from '../shared/taskState.ts';
import { statusText } from '../shared/verdict.ts';
import { CounterLabel } from '../ui/CounterLabel.tsx';
import { RelativeTime } from '../ui/RelativeTime.tsx';

const SORTS: Record<string, ListSort> = {
  updated: { label: 'Recently updated', key: 'updated_at', dir: -1 },
  newest: { label: 'Newest', key: 'id', dir: -1 },
  oldest: { label: 'Oldest', key: 'id', dir: 1 },
};

const TABS: ListTab[] = [
  { key: 'open', label: 'Open', icon: TasklistIcon, filter: (r) => r['status'] !== 'closed' },
  { key: 'closed', label: 'Closed', icon: CheckIcon, filter: (r) => r['status'] === 'closed' },
];

const matches = (task: Row, needle: string) =>
  !needle ||
  `#${String(task['id'])} ${String(task['title'] ?? '')} ${String(task['branch_id'] ?? '')} #${String(task['issue_id'] ?? '')} ${String(task['issue_objective'] ?? '')}`
    .toLowerCase()
    .includes(needle);

const VERDICT_ICON = {
  pass: { icon: CheckIcon, className: 'text-(--fgColor-success)' },
  fail: { icon: XIcon, className: 'text-(--fgColor-danger)' },
  escalate: { icon: AlertIcon, className: 'text-(--fgColor-severe)' },
} as const;

function Verdict({ value }: { value: unknown }) {
  const v = VERDICT_ICON[String(value) as keyof typeof VERDICT_ICON];
  if (!v) return null;
  const VerdictIcon = v.icon;
  return (
    <span className={`flex items-center ${v.className}`} title={`Last review: ${String(value)}`}>
      <VerdictIcon size={16} aria-label={`Last review: ${String(value)}`} />
    </span>
  );
}

const Sep = () => <span aria-hidden="true">·</span>;

export function TaskRow({ task }: { task: Row }) {
  const { icon: StateIcon, className } = taskState(task['status']);
  const id = String(task['id']);
  const branch = task['branch_id'] ? String(task['branch_id']) : '';
  const issueId = task['issue_id'];
  const findings = Number(task['open_findings'] ?? 0);
  return (
    <ListRow
      icon={<StateIcon size={16} className={className} aria-hidden="true" />}
      href={hrefFor('task', id)}
      title={String(task['title'] || branch || `Task ${id}`)}
      meta={
        <>
          <span>
            #{id} {statusText(task['status'])}
          </span>
          {branch && (
            <>
              <Sep />
              <a href={hrefFor('branch', branch)} title={branch} className={`${ENTITY_LINK} inline-flex min-w-0 max-w-full items-center gap-1`}>
                <GitBranchIcon size={12} aria-hidden="true" />
                <span className="max-w-60 truncate font-mono">{branch}</span>
              </a>
            </>
          )}
          {issueId !== null && issueId !== undefined && (
            <>
              <Sep />
              <a href={hrefFor('issue', issueId)} className={`${ENTITY_LINK} inline-flex min-w-0 max-w-full items-center gap-1`}>
                <IssueOpenedIcon size={12} aria-hidden="true" />
                <span>#{String(issueId)}</span>
                {task['issue_objective'] ? <span className="hidden truncate sm:inline">{String(task['issue_objective'])}</span> : null}
              </a>
            </>
          )}
          <Sep />
          <span>
            updated <RelativeTime value={task['updated_at']} />
          </span>
        </>
      }
      aside={
        <>
          {task['effort'] ? (
            <span className="hidden sm:inline">
              <CounterLabel>{String(task['effort'])}</CounterLabel>
            </span>
          ) : null}
          {task['repo'] ? <span className="hidden sm:inline">{String(task['repo'])}</span> : null}
          {findings > 0 && (
            <span className="hidden items-center gap-1 sm:flex" title="Open review findings">
              <ReportIcon size={16} aria-hidden="true" />
              {findings}
              <span className="sr-only">open findings</span>
            </span>
          )}
          <Verdict value={task['last_verdict']} />
        </>
      }
    />
  );
}

function StatusSelect({ value }: { value: string }) {
  return (
    <label className="flex shrink-0 items-center gap-2 text-sm text-fg-muted">
      Status
      <select
        className={`${FIELD} w-auto py-1.5`}
        value={value}
        onChange={(e) => {
          window.location.hash = hrefWith({ status: e.target.value || null }, 'tasks');
        }}
      >
        <option value="">All</option>
        {TASK_STATUSES.map((s) => (
          <option key={s} value={s}>{statusText(s)}</option>
        ))}
      </select>
    </label>
  );
}

export function TaskList({ rows, params }: { rows: Row[]; params: URLSearchParams }) {
  const status = params.get('status') ?? '';
  const branch = params.get('branch') ?? '';
  const issue = params.get('issue') ?? '';
  const filtered = rows.filter(
    (r) =>
      (!status || r['status'] === status) &&
      (!branch || String(r['branch_id'] ?? '') === branch) &&
      (!issue || String(r['issue_id'] ?? '') === issue),
  );
  const chips: ListChip[] = [];
  if (branch) chips.push({ key: 'branch', label: `Branch: ${branch}`, clearLabel: 'Remove branch filter' });
  if (issue) chips.push({ key: 'issue', label: `Issue: #${issue}`, clearLabel: 'Remove issue filter' });
  return (
    <EntityList
      rows={filtered}
      tabs={TABS}
      sorts={SORTS}
      matches={matches}
      renderRow={(r) => <TaskRow task={r} />}
      chips={chips}
      tab={params.get('state') === 'closed' ? 'closed' : 'open'}
      path="tasks"
      noun={['task', 'tasks']}
      emptyIcon={TasklistIcon}
      searchPlaceholder="Search by title, branch, issue or #id"
      controls={<StatusSelect value={status} />}
    />
  );
}

export function TasksView() {
  const q = useApi<Row[]>('tasks');
  const params = useListParams();
  return <Loading q={q}>{(rows) => <TaskList rows={rows} params={params} />}</Loading>;
}
