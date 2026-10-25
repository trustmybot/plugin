import { useState } from 'react';
import { ApiError, useApi, useIssueWrite, type IssueDetail, type Row } from '../api.ts';
import { DataTable, type Column } from '../DataTable.tsx';
import { Markdown } from '../Markdown.tsx';
import { Time } from '../Time.tsx';
import { Badge } from '../shared/Badge.tsx';
import { BUTTON, FIELD } from '../shared/classes.ts';
import { badge, time } from '../shared/columns.tsx';
import { Loading } from '../shared/Loading.tsx';

const ISSUE_TASK_COLUMNS: Column[] = [
  { key: 'id', header: 'Task' },
  { key: 'branch_id', header: 'Branch' },
  { key: 'title', header: 'Title', truncate: true },
  { key: 'status', header: 'Status', cell: badge('status') },
  { key: 'commit_sha', header: 'Commit', cell: (r) => String(r['commit_sha'] ?? '').slice(0, 8) },
  { key: 'updated_at', header: 'Updated', cell: time('updated_at') },
];

export function IssueView({ id }: { id: string }) {
  const q = useApi<IssueDetail>(`issues/${id}`);
  const [editing, setEditing] = useState(false);
  return (
    <Loading q={q}>
      {(d) => (
        <div className="space-y-6">
          <div className="space-y-1">
            <a href="#/issues" className="text-sm text-zinc-500 hover:underline">← Issues</a>
            {editing ? (
              <IssueEditor id={id} detail={d} onDone={() => setEditing(false)} />
            ) : (
              <>
                <h2 className="text-xl font-semibold">
                  #{String(d.issue['id'])} {String(d.issue['objective'])}
                </h2>
                <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-500">
                  <Badge value={d.issue['status']} />
                  {d.issue['gh_iid'] ? <span>GH {String(d.issue['gh_iid'])}</span> : null}
                  {d.issue['milestone'] ? <span>milestone {String(d.issue['milestone'])}</span> : null}
                  {parseLabels(d.issue['labels']).map((l) => (
                    <span key={l} className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs dark:bg-zinc-800">{l}</span>
                  ))}
                  <span>updated <Time value={d.issue['updated_at']} /></span>
                  <button type="button" className={BUTTON} onClick={() => setEditing(true)}>Edit</button>
                  {d.issue['status'] === 'open' && <CloseIssue id={id} updatedAt={String(d.issue['updated_at'])} />}
                </div>
                {d.issue['description'] ? <Markdown className="pt-2">{String(d.issue['description'])}</Markdown> : null}
              </>
            )}
          </div>
          <section className="space-y-2">
            <h3 className="font-medium">Tasks</h3>
            <DataTable rows={d.tasks} columns={ISSUE_TASK_COLUMNS} filter={false} />
          </section>
          <section className="space-y-2">
            <h3 className="font-medium">Discussion</h3>
            {d.discussions.length === 0 && <p className="text-sm text-zinc-500">No discussion yet.</p>}
            {d.discussions.map((c) => (
              <article key={String(c['id'])} className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
                <div className="mb-1 flex gap-2 text-xs text-zinc-500">
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">{String(c['author'])}</span>
                  <Badge value={c['kind']} />
                  <Time value={c['created_at']} />
                </div>
                <Markdown>{String(c['body'])}</Markdown>
              </article>
            ))}
            <CommentForm id={id} />
          </section>
        </div>
      )}
    </Loading>
  );
}

function parseLabels(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === 'string') : [];
  } catch {
    return [];
  }
}

const splitLabels = (raw: string) => raw.split(',').map((l) => l.trim()).filter(Boolean);
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function WriteError({ error }: { error: Error | null }) {
  if (!error) return null;
  const body = error instanceof ApiError ? error.body : {};
  const tasks = Array.isArray(body['tasks']) ? (body['tasks'] as Row[]) : [];
  const applied = Array.isArray(body['applied']) ? body['applied'].map(String) : [];
  return (
    <div role="alert" className="space-y-1 rounded border border-red-300 p-2 text-sm text-red-700 dark:border-red-900 dark:text-red-400">
      <p>{error.message}</p>
      {applied.length > 0 && <p>Already applied before the error: {applied.join(', ')}</p>}
      {tasks.length > 0 && (
        <ul className="list-inside list-disc">
          {tasks.map((t) => (
            <li key={String(t['task_id'])}>
              task {String(t['task_id'])} {t['status'] ? <Badge value={t['status']} /> : `commit ${String(t['commit_sha'] ?? '—').slice(0, 8)}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function IssueEditor({ id, detail, onDone }: { id: string; detail: IssueDetail; onDone: () => void }) {
  const { label_taxonomy: taxonomy, milestones } = detail;
  const [base] = useState(() => detail.issue);
  const changedElsewhere = detail.issue['updated_at'] !== base['updated_at'];
  const priorities = taxonomy.priority ?? [];
  const labels0 = parseLabels(base['labels']);
  const priority0 = labels0.find((l) => priorities.includes(l)) ?? '';
  const objective0 = String(base['objective'] ?? '');
  const description0 = String(base['description'] ?? '');
  const milestone0 = String(base['milestone'] ?? '');
  const [objective, setObjective] = useState(objective0);
  const [description, setDescription] = useState(description0);
  const [priority, setPriority] = useState(priority0);
  const [labels, setLabels] = useState(labels0.filter((l) => l !== priority0).join(', '));
  const [milestone, setMilestone] = useState(milestone0);
  const write = useIssueWrite(id, 'edit');

  const save = () => {
    const body: Row = { updated_at: base['updated_at'] };
    if (objective !== objective0) body['objective'] = objective;
    if (description !== description0) body['description'] = description;
    const nextLabels = [...splitLabels(labels), ...(priority ? [priority] : [])];
    if (!sameList(nextLabels, labels0)) body['labels'] = nextLabels;
    if (milestone !== milestone0) body['milestone'] = milestone;
    if (Object.keys(body).length === 1) return onDone();
    write.mutate(body, { onSuccess: onDone });
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {changedElsewhere && (
        <p role="status" className="rounded border border-amber-300 p-2 text-sm text-amber-800 dark:border-amber-900 dark:text-amber-300">
          This issue changed since you started editing. Cancel and reopen the editor to see it; saving now is refused as stale.
        </p>
      )}
      <label className="block text-sm">
        Objective
        <input className={FIELD} value={objective} onChange={(e) => setObjective(e.target.value)} />
      </label>
      <label className="block text-sm">
        Description
        <textarea className={`${FIELD} h-40 font-mono`} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="grid gap-2 md:grid-cols-3">
        <label className="block text-sm">
          Priority
          <select className={FIELD} value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">—</option>
            {priorities.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          Labels (comma-separated{taxonomy.classification ? `; one of ${taxonomy.classification.join(', ')}` : ''})
          <input className={FIELD} value={labels} onChange={(e) => setLabels(e.target.value)} />
        </label>
        <label className="block text-sm">
          Milestone
          <input className={FIELD} list="tmb-milestones" value={milestone} onChange={(e) => setMilestone(e.target.value)} />
          <datalist id="tmb-milestones">
            {milestones.map((m) => <option key={m} value={m} />)}
          </datalist>
        </label>
      </div>
      <WriteError error={write.error} />
      <div className="flex gap-2">
        <button type="submit" className={BUTTON} disabled={write.isPending}>Save</button>
        <button type="button" className={BUTTON} onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function CommentForm({ id }: { id: string }) {
  const [text, setText] = useState('');
  const write = useIssueWrite(id, 'comment');
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) write.mutate({ body: text }, { onSuccess: () => setText('') });
      }}
    >
      <textarea
        className={`${FIELD} h-24`}
        placeholder="Add a comment as the Human — bro sees it on its next read of this issue"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <WriteError error={write.error} />
      <button type="submit" className={BUTTON} disabled={write.isPending || !text.trim()}>Comment</button>
    </form>
  );
}

function CloseIssue({ id, updatedAt }: { id: string; updatedAt: string }) {
  const write = useIssueWrite(id, 'close');
  return (
    <>
      <button
        type="button"
        className={BUTTON}
        disabled={write.isPending}
        onClick={() => {
          if (window.confirm(`Close issue #${id}?`)) write.mutate({ updated_at: updatedAt });
        }}
      >
        Close issue
      </button>
      {write.error && <div className="w-full"><WriteError error={write.error} /></div>}
    </>
  );
}
