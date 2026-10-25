import { IssueOpenedIcon } from '@primer/octicons-react';
import type { Row } from '../../api.ts';
import { Loading } from '../../shared/Loading.tsx';
import { Blankslate } from '../../ui/Blankslate.tsx';
import { Box, BoxHeader, BoxRow } from '../../ui/Box.tsx';
import { RelativeTime } from '../../ui/RelativeTime.tsx';

const LIMIT = 5;

export const recentOpen = (issues: Row[]) =>
  issues
    .filter((i) => i['status'] === 'open')
    .sort((a, b) => String(b['updated_at'] ?? '').localeCompare(String(a['updated_at'] ?? '')))
    .slice(0, LIMIT);

function IssueRows({ issues }: { issues: Row[] }) {
  const rows = recentOpen(issues);
  if (rows.length === 0) return <Blankslate icon={IssueOpenedIcon} heading="No open issues" description="Every issue is closed." />;
  return (
    <div>
      {rows.map((i) => (
        <BoxRow key={String(i['id'])} data-issue={String(i['id'])} className="flex gap-2 hover:bg-canvas-muted">
          <IssueOpenedIcon size={16} className="mt-0.5 shrink-0 text-(--fgColor-open)" aria-hidden="true" />
          <span className="min-w-0">
            <a href={`#/issues/${i['id']}`} className="block break-words font-semibold text-fg hover:text-accent hover:underline">
              {String(i['objective'] ?? '')}
            </a>
            <span className="block text-xs text-fg-muted">
              #{String(i['id'])} · updated <RelativeTime value={i['updated_at']} />
            </span>
          </span>
        </BoxRow>
      ))}
    </div>
  );
}

export function OpenIssues({ q }: { q: { data?: Row[]; error: Error | null } }) {
  return (
    <Box className="min-w-0">
      <BoxHeader className="flex items-center gap-2">
        <IssueOpenedIcon size={16} className="text-fg-muted" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-fg">Open issues</h2>
      </BoxHeader>
      {q.error || q.data === undefined ? (
        <div className="p-4">
          <Loading q={q}>{() => null}</Loading>
        </div>
      ) : (
        <IssueRows issues={q.data} />
      )}
      <div className="border-t border-(--borderColor-muted) px-4 py-2 text-center text-sm">
        <a href="#/issues" className="text-accent hover:underline">
          View all issues
        </a>
      </div>
    </Box>
  );
}
