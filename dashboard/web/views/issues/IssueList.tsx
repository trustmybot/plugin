import { CheckIcon, CommentIcon, IssueClosedIcon, IssueOpenedIcon, TasklistIcon } from '@primer/octicons-react';
import { lazy, Suspense } from 'react';
import type { Row } from '../../api.ts';
import { EntityList, type ListChip, type ListSort, type ListTab } from '../../shared/list/EntityList.tsx';
import { ListRow } from '../../shared/list/ListRow.tsx';
import { RemoteIssueLink, remoteIssue } from '../../shared/remote.tsx';
import { RelativeTime } from '../../ui/RelativeTime.tsx';
import { hasLabel, labelsByCount } from './label-stats.ts';
import { LabelMenu } from './LabelMenu.tsx';
import { IssueLabel, parseLabels } from './labels.tsx';
import { MilestoneMenu } from './MilestoneMenu.tsx';
import { hasMilestone, milestoneLabel } from './milestones.ts';

const LabelStats = lazy(() => import('./LabelStats.tsx').then((m) => ({ default: m.LabelStats })));

export type IssueState = 'open' | 'closed';

const SORTS: Record<string, ListSort> = {
  updated: { label: 'Recently Updated', key: 'updated_at', dir: -1 },
  newest: { label: 'Newest', key: 'created_at', dir: -1 },
  oldest: { label: 'Oldest', key: 'created_at', dir: 1 },
};

const TABS: ListTab[] = [
  { key: 'open', label: 'Open', icon: IssueOpenedIcon, filter: (r) => r['status'] === 'open' },
  { key: 'closed', label: 'Closed', icon: CheckIcon, filter: (r) => r['status'] !== 'open' },
];

const matches = (issue: Row, needle: string) =>
  !needle || `#${String(issue['id'])} ${String(issue['objective'] ?? '')} ${parseLabels(issue['labels']).join(' ')}`.toLowerCase().includes(needle);

function IssueRow({ issue }: { issue: Row }) {
  const open = issue['status'] === 'open';
  const StateIcon = open ? IssueOpenedIcon : IssueClosedIcon;
  const remote = remoteIssue(issue);
  const taskCount = Number(issue['task_count'] ?? 0);
  return (
    <ListRow
      icon={<StateIcon size={16} className={open ? 'text-(--fgColor-open)' : 'text-(--fgColor-done)'} aria-label={open ? 'Open issue' : 'Closed issue'} />}
      href={`#/issues/${String(issue['id'])}`}
      title={String(issue['objective'] ?? '')}
      adornments={parseLabels(issue['labels']).map((l) => (
        <span key={l} className="mr-1 inline-block align-middle">
          <IssueLabel name={l} />
        </span>
      ))}
      meta={
        <span>
          #{String(issue['id'])}
          {remote && (
            <>
              {' · '}
              <RemoteIssueLink issue={issue} />
            </>
          )}{' '}
          {open ? 'opened' : 'closed'} <RelativeTime value={open ? issue['created_at'] : (issue['closed_at'] ?? issue['updated_at'])} />
        </span>
      }
      aside={
        <>
          {taskCount > 0 && (
            <span className="hidden items-center gap-1 sm:flex" title="Tasks done">
              <TasklistIcon size={16} aria-hidden="true" />
              {String(issue['tasks_done'] ?? 0)}/{taskCount}
            </span>
          )}
          <span className="flex items-center gap-1" title="Discussion entries">
            <CommentIcon size={16} aria-hidden="true" />
            {String(issue['discussion_count'] ?? 0)}
          </span>
        </>
      }
    />
  );
}

export function IssueList({
  rows,
  state,
  label = null,
  milestone = null,
}: {
  rows: Row[];
  state: IssueState;
  label?: string | null;
  milestone?: string | null;
}) {
  const shown = rows.filter((r) => (!label || hasLabel(r, label)) && (!milestone || hasMilestone(r, milestone)));
  const chips: ListChip[] = [
    ...(label ? [{ key: 'label', label: `Label: ${label}`, clearLabel: 'Remove label filter' }] : []),
    ...(milestone ? [{ key: 'milestone', label: milestoneLabel(milestone), clearLabel: 'Remove milestone filter' }] : []),
  ];
  return (
    <div className="space-y-4">
      {label && (
        <Suspense fallback={<p className="text-sm text-fg-muted">Loading label stats…</p>}>
          <LabelStats rows={shown} label={label} />
        </Suspense>
      )}
      <EntityList
        rows={shown}
        tabs={TABS}
        sorts={SORTS}
        matches={matches}
        renderRow={(r) => <IssueRow issue={r} />}
        chips={chips}
        tab={state}
        path="issues"
        noun={['issue', 'issues', 'Issues']}
        emptyIcon={IssueOpenedIcon}
        searchPlaceholder="Search by objective, label or #id"
        controls={
          <>
            <LabelMenu labels={labelsByCount(rows)} value={label} />
            <MilestoneMenu rows={rows} value={milestone} />
          </>
        }
      />
    </div>
  );
}
