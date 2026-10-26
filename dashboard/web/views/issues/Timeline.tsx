import type { ReactNode } from 'react';
import { CommentIcon } from '@primer/octicons-react';
import type { Row } from '../../api.ts';
import { Markdown } from '../../Markdown.tsx';
import { ENTITY_LINK, hrefFor } from '../../shared/columns.tsx';
import { Label } from '../../ui/Label.tsx';
import { RelativeTime } from '../../ui/RelativeTime.tsx';
import { Avatar } from './Avatar.tsx';
import { kindVariant } from './labels.tsx';

const SHORT_NOTE = 90;

export const isCompactNote = (c: Row) => {
  const body = String(c['body'] ?? '');
  return c['kind'] === 'note' && body.length < SHORT_NOTE && !body.includes('\n');
};

export function TaskChip({ id }: { id: unknown }) {
  if (id === null || id === undefined || id === '') return null;
  return (
    <span className="text-xs text-fg-muted" data-task-chip>
      <a href={hrefFor('task', id)} className={`${ENTITY_LINK} underline`}>
        task {String(id)}
      </a>
    </span>
  );
}

export function CommentCard({ author, verb, at, badge, body, taskId }: { author: string; verb: string; at: unknown; badge: ReactNode; body: string; taskId?: unknown }) {
  return (
    <article className="relative flex gap-4 pb-4" data-comment>
      <span className="hidden shrink-0 sm:block">
        <Avatar author={author} />
      </span>
      <div className="min-w-0 flex-1 rounded-md border border-(--borderColor-default) bg-canvas">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-t-md border-b border-(--borderColor-default) bg-canvas-muted px-4 py-2 text-sm text-fg-muted">
          <span className="flex sm:hidden">
            <Avatar author={author} size="small" />
          </span>
          <span className="font-semibold text-fg">{author}</span>
          <span>
            {verb} <RelativeTime value={at} />
          </span>
          <span className="ml-auto flex items-center gap-2">
            <TaskChip id={taskId} />
            {badge}
          </span>
        </header>
        {body.trim() ? <Markdown className="p-4">{body}</Markdown> : <p className="p-4 text-sm text-fg-muted italic">No description provided.</p>}
      </div>
    </article>
  );
}

function TimelineEvent({ c }: { c: Row }) {
  return (
    <div className="relative flex items-center gap-3 pb-4 text-sm text-fg-muted sm:pl-14">
      <span className="grid size-8 shrink-0 place-items-center rounded-full border-2 border-(--bgColor-default) bg-canvas-muted">
        <CommentIcon size={16} aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 break-words">
        <Avatar author={String(c['author'])} size="small" />
        <span className="font-semibold text-fg">{String(c['author'])}</span>
        <span>{String(c['body'])}</span>
        <RelativeTime value={c['created_at']} />
        <TaskChip id={c['task_id']} />
      </span>
    </div>
  );
}

export function Timeline({ discussions }: { discussions: Row[] }) {
  if (discussions.length === 0) return null;
  return (
    <div className="relative">
      <div aria-hidden="true" className="absolute inset-y-0 left-[15px] w-0.5 bg-(--borderColor-muted) sm:left-[71px]" />
      {discussions.map((c) =>
        isCompactNote(c) ? (
          <TimelineEvent key={String(c['id'])} c={c} />
        ) : (
          <CommentCard
            key={String(c['id'])}
            author={String(c['author'])}
            verb="commented"
            at={c['created_at']}
            badge={<Label variant={kindVariant(String(c['kind']))}>{String(c['kind'])}</Label>}
            body={String(c['body'] ?? '')}
            taskId={c['task_id']}
          />
        ),
      )}
    </div>
  );
}
