import { useState } from 'react';
import { CheckIcon, CommentIcon, IssueClosedIcon, IssueOpenedIcon, SearchIcon, TasklistIcon } from '@primer/octicons-react';
import type { Row } from '../../api.ts';
import { FIELD } from '../../shared/classes.ts';
import { Blankslate } from '../../ui/Blankslate.tsx';
import { Box, BoxHeader, BoxRow } from '../../ui/Box.tsx';
import { RelativeTime } from '../../ui/RelativeTime.tsx';
import { IssueLabel, parseLabels } from './labels.tsx';

export type IssueState = 'open' | 'closed';

const SORTS = {
  updated: { label: 'Recently updated', key: 'updated_at', dir: -1 },
  newest: { label: 'Newest', key: 'created_at', dir: -1 },
  oldest: { label: 'Oldest', key: 'created_at', dir: 1 },
} as const;
type Sort = keyof typeof SORTS;

const matches = (issue: Row, needle: string) =>
  !needle || `#${String(issue['id'])} ${String(issue['objective'] ?? '')} ${parseLabels(issue['labels']).join(' ')}`.toLowerCase().includes(needle);

function StateTab({ state, current, count }: { state: IssueState; current: IssueState; count: number }) {
  const StateIcon = state === 'open' ? IssueOpenedIcon : CheckIcon;
  const selected = state === current;
  return (
    <a
      href={state === 'open' ? '#/issues' : '#/issues?state=closed'}
      aria-current={selected ? 'page' : undefined}
      className={`flex items-center gap-1.5 text-sm hover:text-fg ${selected ? 'font-semibold text-fg' : 'text-fg-muted'}`}
    >
      <StateIcon size={16} aria-hidden="true" />
      {count} {state === 'open' ? 'Open' : 'Closed'}
    </a>
  );
}

function IssueRow({ issue }: { issue: Row }) {
  const open = issue['status'] === 'open';
  const StateIcon = open ? IssueOpenedIcon : IssueClosedIcon;
  const remote = issue['gh_iid'] ? ` · GH ${String(issue['gh_iid'])}` : issue['gl_iid'] ? ` · GL ${String(issue['gl_iid'])}` : '';
  const taskCount = Number(issue['task_count'] ?? 0);
  return (
    <BoxRow className="flex gap-2.5 py-2 hover:bg-canvas-muted">
      <StateIcon size={16} className={`mt-1 shrink-0 ${open ? 'text-(--fgColor-open)' : 'text-(--fgColor-done)'}`} aria-label={open ? 'Open issue' : 'Closed issue'} />
      <div className="min-w-0 flex-1 break-words">
        <a href={`#/issues/${String(issue['id'])}`} className="mr-1 align-middle text-base font-semibold text-fg hover:text-(--fgColor-accent)">
          {String(issue['objective'] ?? '')}
        </a>
        {parseLabels(issue['labels']).map((l) => (
          <span key={l} className="mr-1 inline-block align-middle">
            <IssueLabel name={l} />
          </span>
        ))}
        <div className="mt-0.5 text-xs text-fg-muted">
          #{String(issue['id'])}
          {remote} {open ? 'opened' : 'closed'} <RelativeTime value={open ? issue['created_at'] : (issue['closed_at'] ?? issue['updated_at'])} />
        </div>
      </div>
      <div className="flex shrink-0 items-start gap-4 pt-1 text-xs whitespace-nowrap text-fg-muted">
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
      </div>
    </BoxRow>
  );
}

export function IssueList({ rows, state }: { rows: Row[]; state: IssueState }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('updated');
  const needle = search.trim().toLowerCase();
  const found = rows.filter((r) => matches(r, needle));
  const counts = { open: found.filter((r) => r['status'] === 'open').length, closed: found.filter((r) => r['status'] !== 'open').length };
  const { key, dir } = SORTS[sort];
  const shown = found
    .filter((r) => (r['status'] === 'open') === (state === 'open'))
    .sort((a, b) => dir * String(a[key] ?? '').localeCompare(String(b[key] ?? '')));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <label className="relative min-w-0 flex-1 basis-60">
          <span className="sr-only">Search issues</span>
          <SearchIcon size={16} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-muted" aria-hidden="true" />
          <input type="search" className={`${FIELD} py-1.5 pl-8`} placeholder="Search by objective, label or #id" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label className="flex shrink-0 items-center gap-2 text-sm text-fg-muted">
          Sort
          <select className={`${FIELD} w-auto py-1.5`} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            {Object.entries(SORTS).map(([value, s]) => (
              <option key={value} value={value}>{s.label}</option>
            ))}
          </select>
        </label>
      </div>
      <Box>
        <BoxHeader className="flex flex-wrap items-center gap-4">
          <StateTab state="open" current={state} count={counts.open} />
          <StateTab state="closed" current={state} count={counts.closed} />
        </BoxHeader>
        {shown.length === 0 ? (
          <Blankslate
            icon={IssueOpenedIcon}
            heading={needle ? 'No results matched your search' : `No ${state} issues`}
            description={needle ? 'Try a different objective, label or #id.' : undefined}
          />
        ) : (
          shown.map((r) => <IssueRow key={String(r['id'])} issue={r} />)
        )}
      </Box>
    </div>
  );
}
