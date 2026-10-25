import { useState } from 'react';
import type { IssueDetail } from '../../api.ts';
import { Button } from '../../ui/Button.tsx';
import { Label } from '../../ui/Label.tsx';
import { RelativeTime } from '../../ui/RelativeTime.tsx';
import { StateLabel } from '../../ui/StateLabel.tsx';
import { Composer } from './Composer.tsx';
import { IssueEditor } from './IssueEditor.tsx';
import { parseLabels } from './labels.tsx';
import { Sidebar } from './Sidebar.tsx';
import { CommentCard, Timeline } from './Timeline.tsx';

const ISSUE_AUTHOR = 'bro';

export function IssuePage({ id, detail }: { id: string; detail: IssueDetail }) {
  const [editing, setEditing] = useState(false);
  const { issue, discussions, tasks } = detail;
  const open = issue['status'] === 'open';
  const count = discussions.length;
  return (
    <div className="space-y-6">
      {editing ? (
        <IssueEditor id={id} detail={detail} onDone={() => setEditing(false)} />
      ) : (
        <div className="space-y-2 border-b border-(--borderColor-default) pb-4">
          <h2 className="text-2xl leading-tight break-words text-fg md:text-[32px]">
            {String(issue['objective'])} <span className="font-light text-fg-muted">#{String(issue['id'])}</span>
          </h2>
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <StateLabel status={open ? 'open' : 'closed'} />
            <span>
              opened <RelativeTime value={issue['created_at']} /> · {count} {count === 1 ? 'comment' : 'comments'}
            </span>
            <Button size="small" className="ml-auto" onClick={() => setEditing(true)}>Edit</Button>
          </div>
        </div>
      )}
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_256px]">
        <div className="min-w-0">
          <CommentCard
            author={ISSUE_AUTHOR}
            verb="opened"
            at={issue['created_at']}
            badge={<Label variant="secondary">Author</Label>}
            body={String(issue['description'] ?? '')}
          />
          <Timeline discussions={discussions} />
          <Composer id={id} open={open} updatedAt={String(issue['updated_at'])} />
        </div>
        <Sidebar issue={issue} labels={parseLabels(issue['labels'])} tasks={tasks} />
      </div>
    </div>
  );
}
