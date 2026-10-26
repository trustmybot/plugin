import type { ReactNode } from 'react';
import type { TaskDetail } from '../../api.ts';
import { Badge } from '../../shared/Badge.tsx';
import { ENTITY_LINK, hrefFor } from '../../shared/columns.tsx';
import { CommitSha } from '../../shared/remote.tsx';
import { CodeBlock } from '../../ui/CodeBlock.tsx';
import { DescriptionList } from '../../ui/DescriptionList.tsx';
import { RelativeTime } from '../../ui/RelativeTime.tsx';
import { Muted } from './Section.tsx';

const DASH = <span className="text-fg-muted">—</span>;

const text = (v: unknown): ReactNode => (v === null || v === undefined || v === '' ? DASH : String(v));
const mono = (v: unknown): ReactNode => (v === null || v === undefined || v === '' ? DASH : <code className="font-mono break-all">{String(v)}</code>);

function CodeList({ title, value, raw, empty }: { title: string; value: unknown; raw?: string; empty: string }) {
  const items = Array.isArray(value) ? value.map(String) : [];
  return (
    <section className="border-t border-(--borderColor-muted) pt-4 text-xs">
      <h3 className="mb-2 font-semibold text-fg-muted">{title}</h3>
      {raw !== undefined ? (
        <CodeBlock text={raw} label={`${title} (unparsed)`} maxLines={10} />
      ) : items.length ? (
        <ul className="space-y-1">
          {items.map((item, i) => (
            <li key={i}>
              <code className="block rounded-md bg-(--bgColor-muted) px-1.5 py-0.5 font-mono break-all whitespace-pre-wrap text-fg">{item}</code>
            </li>
          ))}
        </ul>
      ) : (
        <Muted>{empty}</Muted>
      )}
    </section>
  );
}

export function TaskSidebar({ task }: { task: TaskDetail['task'] }) {
  return (
    <aside aria-label="Task details" className="min-w-0 space-y-4 md:order-last">
      <DescriptionList
        items={[
          { term: 'Status', detail: <Badge value={task['status']} /> },
          { term: 'Effort', detail: text(task['effort']) },
          { term: 'Repo', detail: text(task['repo']) },
          {
            term: 'Branch',
            detail: task['branch_id'] ? (
              <a href={hrefFor('branch', task['branch_id'])} className={ENTITY_LINK}>
                {mono(task['branch_id'])}
              </a>
            ) : (
              DASH
            ),
          },
          { term: 'Commit', detail: <CommitSha sha={task['commit_sha']} web={task['remote_web_url']} provider={task['remote_provider']} /> },
          { term: 'Created', detail: <RelativeTime value={task['created_at']} /> },
          { term: 'Updated', detail: <RelativeTime value={task['updated_at']} /> },
          { term: 'Completed', detail: <RelativeTime value={task['completed_at']} /> },
        ]}
      />
      <CodeList title="Files" value={task.files} raw={task.files_raw} empty="No files listed" />
      <CodeList title="Verification" value={task.verification} raw={task.verification_raw} empty="No verification commands" />
    </aside>
  );
}
