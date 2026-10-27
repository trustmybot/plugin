import type { ReactNode } from 'react';
import { GitBranchIcon } from '@primer/octicons-react';
import type { Row } from '../../api.ts';
import { Badge } from '../../shared/Badge.tsx';
import { ENTITY_LINK, hrefFor } from '../../shared/columns.tsx';
import { RemoteIssueLink, remoteIssue } from '../../shared/remote.tsx';
import { IssueLabel } from './labels.tsx';

const DONE = new Set(['completed', 'closed']);

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-(--borderColor-muted) py-4 text-xs first:pt-0 last:border-b-0">
      <h3 className="mb-2 flex justify-between font-semibold text-fg-muted">
        {title}
        {aside}
      </h3>
      {children}
    </section>
  );
}

const None = ({ children }: { children: ReactNode }) => <span className="text-fg-muted">{children}</span>;

export function Sidebar({ issue, labels, tasks }: { issue: Row; labels: string[]; tasks: Row[] }) {
  const branches = [...new Set(tasks.map((t) => String(t['branch_id'] ?? '')).filter(Boolean))];
  const done = tasks.filter((t) => DONE.has(String(t['status']))).length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  return (
    <aside aria-label="Issue details" className="min-w-0">
      <Section title="Labels">
        {labels.length ? <div className="flex flex-wrap gap-1">{labels.map((l) => <IssueLabel key={l} name={l} />)}</div> : <None>None yet</None>}
      </Section>
      <Section title="Milestone">{issue['milestone'] ? <span className="text-fg">{String(issue['milestone'])}</span> : <None>No milestone</None>}</Section>
      <Section title="Branches">
        {branches.length ? (
          <ul className="space-y-1">
            {branches.map((b) => (
              <li key={b} className="font-mono break-all text-fg">
                <a href={hrefFor('branch', b)} className={`${ENTITY_LINK} flex items-start gap-1`}>
                  <GitBranchIcon size={16} className="shrink-0 text-fg-muted" aria-hidden="true" />
                  {b}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <None>No branches yet</None>
        )}
      </Section>
      <Section title="Tasks" aside={<span data-progress>{done} / {tasks.length}</span>}>
        <div
          role="progressbar"
          aria-label="Tasks Done"
          aria-valuemin={0}
          aria-valuemax={tasks.length}
          aria-valuenow={done}
          className="flex h-2 overflow-hidden rounded-md bg-(--bgColor-neutral-muted)"
        >
          <span className="bg-(--bgColor-success-emphasis)" style={{ width: `${pct}%` }} />
        </div>
        {tasks.length > 0 && (
          <ul className="mt-2 space-y-1.5">
            {tasks.map((t) => (
              <li key={String(t['id'])}>
                <a href={hrefFor('task', t['id'])} className={`${ENTITY_LINK} flex items-start justify-between gap-2`}>
                  <span className="min-w-0 break-words">
                    <span className="text-fg-muted">#{String(t['id'])}</span> {String(t['title'] || t['branch_id'] || '')}
                  </span>
                  <Badge value={t['status']} />
                </a>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Remote">{remoteIssue(issue) ? <RemoteIssueLink issue={issue} className="text-fg" /> : <None>Not synced yet</None>}</Section>
    </aside>
  );
}
