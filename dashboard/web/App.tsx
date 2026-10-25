import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  ApiError,
  query,
  useApi,
  useApis,
  useIssueWrite,
  useLiveRefresh,
  type ConceptDetail,
  type ConceptGraph,
  type ConceptHit,
  type ConceptSearch,
  type ConceptStep,
  type Gates,
  type GraphEdge,
  type GraphNode,
  type IssueDetail,
  type Row,
  type NodeId,
  type Summary,
  type Trust,
  type WmNode,
  type WorldModel,
  type WorldModelSearch,
} from './api.ts';
import { DataTable, type Column } from './DataTable.tsx';
import { Markdown } from './Markdown.tsx';
import { Time } from './Time.tsx';

const TABS = [
  ['overview', 'Overview'],
  ['issues', 'Issues'],
  ['tasks', 'Tasks'],
  ['runs', 'Runs & gates'],
  ['audit', 'Audit'],
  ['map', 'Project map'],
  ['concepts', 'Concepts'],
] as const;

function useHashRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('?')[0]!.split('/').filter(Boolean);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

const go = (path: string) => {
  window.location.hash = `/${path}`;
};

export function App() {
  useLiveRefresh();
  const [tab = 'overview', id] = useHashRoute();
  return (
    <div className="mx-auto w-full max-w-[120rem] space-y-4 px-4 py-4 sm:px-6 2xl:px-10">
      <header className="flex flex-wrap items-center gap-4 border-b border-zinc-200 pb-3 dark:border-zinc-800">
        <h1 className="text-lg font-semibold">TMB dashboard</h1>
        <nav className="flex gap-1 text-sm">
          {TABS.map(([key, label]) => (
            <a
              key={key}
              href={`#/${key}`}
              className={`rounded px-2 py-1 ${tab === key ? 'bg-zinc-200 dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'}`}
            >
              {label}
            </a>
          ))}
        </nav>
        <span className="ml-auto text-xs text-zinc-500">live</span>
      </header>
      {tab === 'issues' && id ? <IssueView id={id} /> : tab === 'concepts' ? <ConceptsView id={id} /> : <TabView tab={tab} />}
    </div>
  );
}

function TabView({ tab }: { tab: string }) {
  switch (tab) {
    case 'issues': return <IssuesView />;
    case 'tasks': return <TasksView />;
    case 'runs': return <RunsView />;
    case 'audit': return <AuditView />;
    case 'map': return <ProjectMapView />;
    default: return <OverviewView />;
  }
}

function Loading<T>({ q, children }: { q: { data?: T; error: Error | null }; children: (data: T) => ReactNode }) {
  if (q.error) return <p className="text-red-600">{q.error.message}</p>;
  if (q.data === undefined) return <p className="text-zinc-500">Loading…</p>;
  return <>{children(q.data)}</>;
}

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  running: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  needs_validation: 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300',
  completed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  closed: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  pass: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  fail: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  escalated: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  escalate: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  verified: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  suspect: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  broken: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
};

function Badge({ value }: { value: unknown }) {
  const s = String(value ?? '—');
  return <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_COLORS[s] ?? 'bg-zinc-100 dark:bg-zinc-800'}`}>{s}</span>;
}

const badge = (key: string) => (r: Row) => <Badge value={r[key]} />;
const time = (key: string) => (r: Row) => <Time value={r[key]} />;
const exitBadge = (r: Row) =>
  r['exit_code'] === null || r['exit_code'] === undefined ? <Badge value="running" /> : <Badge value={r['exit_code'] === 0 ? 'pass' : 'fail'} />;

function Card({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
}

const RUN_COLUMNS: Column[] = [
  { key: 'id', header: 'Run' },
  { key: 'agent_type', header: 'Agent' },
  { key: 'task_id', header: 'Task' },
  { key: 'task_title', header: 'Title', truncate: true },
  { key: 'started_at', header: 'Started', cell: time('started_at') },
  { key: 'exit_reason', header: 'Exit', cell: (r) => <Badge value={r['completed_at'] ? r['exit_reason'] ?? 'completed' : 'running'} /> },
];

function OverviewView() {
  const q = useApi<Summary>('summary');
  return (
    <Loading q={q}>
      {(s) => (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card label="Open issues" value={s.issues.open ?? 0} />
            <Card label="Closed issues" value={s.issues.closed ?? 0} />
            <Card label="Agents running" value={s.open_runs} />
            <Card label="Tasks" value={s.tasks_by_status.reduce((n, t) => n + t.count, 0)} />
          </div>
          <section className="space-y-2">
            <h2 className="font-medium">Tasks by status</h2>
            <div className="flex flex-wrap gap-2">
              {s.tasks_by_status.map((t) => (
                <span key={t.status} className="flex items-center gap-1 text-sm">
                  <Badge value={t.status} /> {t.count}
                </span>
              ))}
            </div>
          </section>
          <section className="space-y-2">
            <h2 className="font-medium">Recent agent runs</h2>
            <DataTable rows={s.recent_runs} columns={RUN_COLUMNS} filter={false} />
          </section>
        </div>
      )}
    </Loading>
  );
}

const ISSUE_COLUMNS: Column[] = [
  { key: 'id', header: '#' },
  { key: 'objective', header: 'Objective', truncate: true },
  { key: 'status', header: 'Status', cell: badge('status') },
  { key: 'repo', header: 'Repo' },
  { key: 'gh_iid', header: 'GH' },
  { key: 'tasks_done', header: 'Tasks', cell: (r) => `${r['tasks_done']}/${r['task_count']}` },
  { key: 'updated_at', header: 'Updated', cell: time('updated_at') },
];

function IssuesView() {
  const q = useApi<Row[]>('issues');
  return <Loading q={q}>{(rows) => <DataTable rows={rows} columns={ISSUE_COLUMNS} onRowClick={(r) => go(`issues/${r['id']}`)} />}</Loading>;
}

const ISSUE_TASK_COLUMNS: Column[] = [
  { key: 'id', header: 'Task' },
  { key: 'branch_id', header: 'Branch' },
  { key: 'title', header: 'Title', truncate: true },
  { key: 'status', header: 'Status', cell: badge('status') },
  { key: 'commit_sha', header: 'Commit', cell: (r) => String(r['commit_sha'] ?? '').slice(0, 8) },
  { key: 'updated_at', header: 'Updated', cell: time('updated_at') },
];

function IssueView({ id }: { id: string }) {
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

const BUTTON = 'rounded border border-zinc-300 px-2 py-0.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900';
const FIELD = 'w-full rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700';

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

const TASK_COLUMNS: Column[] = [
  { key: 'id', header: 'Task' },
  { key: 'issue_id', header: 'Issue' },
  { key: 'title', header: 'Title', truncate: true },
  { key: 'branch_id', header: 'Branch' },
  { key: 'status', header: 'Status', cell: badge('status') },
  { key: 'effort', header: 'Effort' },
  { key: 'repo', header: 'Repo' },
  { key: 'updated_at', header: 'Updated', cell: time('updated_at') },
];

function TasksView() {
  const q = useApi<Row[]>('tasks');
  return <Loading q={q}>{(rows) => <DataTable rows={rows} columns={TASK_COLUMNS} onRowClick={(r) => go(`issues/${r['issue_id']}`)} />}</Loading>;
}

const AGENT_RUN_COLUMNS: Column[] = [
  ...RUN_COLUMNS,
  { key: 'model', header: 'Model' },
  { key: 'tokens_out', header: 'Tokens out' },
  { key: 'duration_ms', header: 'Duration', cell: (r) => `${Math.round(Number(r['duration_ms'] ?? 0) / 1000)}s` },
];

const VALIDATION_COLUMNS: Column[] = [
  { key: 'id', header: 'ID' },
  { key: 'task_id', header: 'Task' },
  { key: 'task_title', header: 'Title', truncate: true },
  { key: 'attempt_n', header: 'Attempt' },
  { key: 'agent', header: 'Agent' },
  { key: 'verdict', header: 'Verdict', cell: badge('verdict') },
  { key: 'created_at', header: 'At', cell: time('created_at') },
];

const VERIFICATION_COLUMNS: Column[] = [
  { key: 'id', header: 'Run' },
  { key: 'task_id', header: 'Task' },
  { key: 'task_title', header: 'Title', truncate: true },
  { key: 'commit_sha', header: 'Commit', cell: (r) => String(r['commit_sha'] ?? '').slice(0, 8) },
  { key: 'source', header: 'Source' },
  { key: 'exit_code', header: 'Result', cell: exitBadge },
  { key: 'failed_commands', header: 'Failed', cell: (r) => `${r['failed_commands']}/${r['commands']}` },
  { key: 'started_at', header: 'Started', cell: time('started_at') },
];

function RunsView() {
  const runs = useApi<Row[]>('agent-runs');
  const gates = useApi<Gates>('gates');
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="font-medium">Agent runs</h2>
        <Loading q={runs}>{(rows) => <DataTable rows={rows} columns={AGENT_RUN_COLUMNS} />}</Loading>
      </section>
      <Loading q={gates}>
        {(g) => (
          <>
            <section className="space-y-2">
              <h2 className="font-medium">Review verdicts</h2>
              <DataTable rows={g.validations} columns={VALIDATION_COLUMNS} />
            </section>
            <section className="space-y-2">
              <h2 className="font-medium">Verification runs</h2>
              <DataTable rows={g.verifications} columns={VERIFICATION_COLUMNS} />
            </section>
          </>
        )}
      </Loading>
    </div>
  );
}

const AUDIT_COLUMNS: Column[] = [
  { key: 'created_at', header: 'At', cell: time('created_at') },
  { key: 'issue_id', header: 'Issue' },
  { key: 'branch_id', header: 'Branch' },
  { key: 'from_node', header: 'From' },
  { key: 'event_type', header: 'Event' },
  { key: 'summary', header: 'Summary', truncate: true },
];

function AuditView() {
  const q = useApi<Row[]>('audit?limit=300');
  return <Loading q={q}>{(rows) => <DataTable rows={rows} columns={AUDIT_COLUMNS} />}</Loading>;
}

const WM_MISSING = 'World model not built yet — open a Claude Code session to upgrade the DB and run /scan.';

function ProjectMapView() {
  const [picked, setPicked] = useState('');
  const q = useApi<WorldModel>(`world-model?${query({ repo: picked, depth: '0' })}`);
  return (
    <Loading q={q}>
      {(wm) => {
        if (!wm.available) return <p className="text-zinc-500">{WM_MISSING}</p>;
        const repo = picked || wm.repos[0];
        if (repo === undefined) return <p className="text-zinc-500">The world model is empty — run /scan in a Claude Code session.</p>;
        const root = wm.nodes[0];
        return (
          <div className="grid gap-6 lg:grid-cols-2 2xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] [&>*]:min-w-0">
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <h2 className="font-medium">Directories</h2>
                <select
                  className="rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
                  value={repo}
                  onChange={(e) => setPicked(e.target.value)}
                >
                  {wm.repos.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              {root ? (
                <ul className="text-sm"><TreeNode node={root} open /></ul>
              ) : (
                <p className="text-sm text-zinc-500">No root directory recorded for {repo}.</p>
              )}
            </section>
            <WorldModelSearchView />
          </div>
        );
      }}
    </Loading>
  );
}

function TreeNode({ node, open = false }: { node: WmNode; open?: boolean }) {
  const [expanded, setExpanded] = useState(open);
  const name = node.path === '' ? node.repo : node.path.split('/').pop();
  return (
    <li>
      <button
        type="button"
        className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-900"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="w-3 text-zinc-500">{expanded ? '▾' : '▸'}</span>
        <span className="font-medium">{name}/</span>
        <span className="text-xs text-zinc-500">{node.file_count} files</span>
        {node.summary ? <span className="truncate text-xs text-zinc-500">{node.summary}</span> : null}
      </button>
      {expanded && <TreeChildren node={node} />}
    </li>
  );
}

function TreeChildren({ node }: { node: WmNode }) {
  const q = useApi<WorldModel>(`world-model?${query({ repo: node.repo, path: node.path, depth: '1' })}`);
  return (
    <div className="ml-4 border-l border-zinc-200 pl-2 dark:border-zinc-800">
      <Loading q={q}>
        {(wm) => {
          const children = wm.nodes.filter((n) => n.parent_path === node.path && n.path !== node.path);
          if (children.length === 0) return <p className="px-1 text-xs text-zinc-500">No subdirectories.</p>;
          return <ul>{children.map((c) => <TreeNode key={c.path} node={c} />)}</ul>;
        }}
      </Loading>
    </div>
  );
}

const HIT_COLUMNS: Column[] = [
  { key: 'kind', header: 'Kind', cell: badge('kind') },
  { key: 'repo', header: 'Repo' },
  { key: 'path', header: 'Path', truncate: true },
  { key: 'text', header: 'Summary', truncate: true },
];

function WorldModelSearchView() {
  const [input, setInput] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(input.trim()), 250);
    return () => clearTimeout(t);
  }, [input]);
  return (
    <section className="space-y-2">
      <h2 className="font-medium">Search</h2>
      <input
        className="w-full max-w-xs rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
        placeholder="Search directories and files…"
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      {term && <SearchHits term={term} />}
    </section>
  );
}

function SearchHits({ term }: { term: string }) {
  const q = useApi<WorldModelSearch>(`world-model/search?${query({ q: term, limit: '50' })}`);
  return <Loading q={q}>{(r) => <DataTable rows={r.hits} columns={HIT_COLUMNS} filter={false} />}</Loading>;
}

const CONCEPT_COPY = {
  placeholder: 'Search concepts or functions…',
  help: 'A concept is a feature, like cold start, traced step by step through the functions that make it up.',
  empty: 'No saved concept matches. Try a function name.',
  unavailable: 'Concepts need a fresh world model scan — run /scan in a Claude Code session.',
  derived: 'Unverified — built from the call graph',
  showGraph: 'Show graph',
  showTable: 'Show as table',
};

const TRUST_LABEL: Record<Trust, { icon: string; label: string }> = {
  verified: { icon: '✓', label: 'Verified' },
  suspect: { icon: '!', label: 'Suspect' },
  broken: { icon: '✕', label: 'Broken' },
};

const DERIVED_ID = 'derived';
const MIN_QUERY = 2;
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:focus-visible:outline-blue-400';
const MUTED = 'text-zinc-600 dark:text-zinc-400';
const TARGET = `${BUTTON} min-h-6 ${FOCUS}`;

const hashParams = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '');
const routeQuery = () => hashParams().get('q') ?? '';
const hashPath = () => window.location.hash.replace(/^#\/?/, '').split('?')[0]!;
const stepCount = (n: number) => `${n} ${n === 1 ? 'step' : 'steps'}`;
const TRUST_RANK: Record<Trust, number> = { verified: 0, suspect: 1, broken: 2 };
const worseTrust = (a: Trust, b: Trust) => (TRUST_RANK[b] > TRUST_RANK[a] ? b : a);
const headerTrust = (status: Trust, steps: ConceptStep[]) =>
  steps.reduce<Trust>((worst, s) => worseTrust(worst, s.symbol === null ? 'broken' : s.trust ?? 'verified'), status);
const conceptsPath = (id: string | undefined, term: string) =>
  `concepts${id ? `/${id}` : ''}${term ? `?${query({ q: term })}` : ''}`;
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function TrustBadge({ trust, count }: { trust: Trust; count?: number }) {
  const { icon, label } = TRUST_LABEL[trust];
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${STATUS_COLORS[trust]}`}>
      <span aria-hidden="true">{icon}</span>
      {count === undefined ? label : `${count} ${label}`}
    </span>
  );
}

function DerivedBadge() {
  return (
    <span className="rounded border border-dashed border-zinc-500 px-1.5 py-0.5 text-xs text-zinc-800 dark:border-zinc-400 dark:text-zinc-200">
      {CONCEPT_COPY.derived}
    </span>
  );
}

function ConceptsView({ id }: { id: string | undefined }) {
  const [input, setInput] = useState(routeQuery);
  const [term, setTerm] = useState(() => input.trim());
  const termRef = useRef(term);
  const [repo, setRepo] = useState('');
  useEffect(() => {
    const onHash = () => {
      const q = routeQuery();
      if (q === termRef.current) return;
      termRef.current = q;
      setInput(q);
      setTerm(q);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      const next = input.trim();
      if (next === termRef.current) return;
      termRef.current = next;
      setTerm(next);
      if (routeQuery() !== next) window.history.replaceState(null, '', `#/${hashPath()}${next ? `?${query({ q: next })}` : ''}`);
    }, 200);
    return () => clearTimeout(t);
  }, [input]);
  const search = useApi<ConceptSearch>(`concepts?${query({ q: term, repo })}`, { keepPrevious: true });
  const data = search.data;

  if (search.error) return <p role="alert" className="text-red-700 dark:text-red-400">{search.error.message}</p>;
  if (data && !data.available) return <p role="status" className={MUTED}>{CONCEPT_COPY.unavailable}</p>;

  const hits = data?.concepts ?? [];
  const derived = data?.derived ?? null;
  const searching = term.length >= MIN_QUERY;
  const announce = !searching || !data
    ? ''
    : hits.length === 0
      ? `${CONCEPT_COPY.empty}${derived ? ' Showing an unverified chain built from the call graph.' : ''}`
      : `${hits.length} ${hits.length === 1 ? 'concept' : 'concepts'} found.`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block min-w-64 flex-1 text-sm">
          <span className="sr-only">Search concepts</span>
          <input
            type="search"
            className={`${FIELD} min-h-8 ${FOCUS}`}
            placeholder={CONCEPT_COPY.placeholder}
            aria-describedby="concepts-help"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </label>
        {data && data.repos.length > 1 && (
          <label className="flex items-center gap-2 text-sm">
            Repo
            <select className={`${FIELD} min-h-8 w-auto ${FOCUS}`} value={repo || data.repos[0]} onChange={(e) => setRepo(e.target.value)}>
              {data.repos.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
        )}
      </div>
      <p id="concepts-help" className={`text-sm ${MUTED}`}>{CONCEPT_COPY.help}</p>
      <p role="status" aria-live="polite" className={`text-sm ${MUTED}`}>{announce}</p>
      <div className="grid gap-4 lg:grid-cols-[240px_420px_minmax(0,1fr)]">
        <section aria-label="Results" className="space-y-2">
          <ResultList hits={hits} derived={derived} selected={id} onSelect={(key) => go(conceptsPath(key, term))} />
        </section>
        {id === DERIVED_ID ? (
          derived ? (
            <DerivedPanel steps={derived.steps} />
          ) : (
            <p className={`text-sm ${MUTED}`}>No unverified chain for this search. Try a function name.</p>
          )
        ) : id ? (
          <SavedPanel id={id} />
        ) : (
          <p className={`text-sm ${MUTED}`}>{searching ? 'Select a result to see its steps.' : ''}</p>
        )}
      </div>
    </div>
  );
}

interface ResultItem {
  key: string;
  hit: ConceptHit | null;
}

function ResultList({
  hits,
  derived,
  selected,
  onSelect,
}: {
  hits: ConceptHit[];
  derived: ConceptSearch['derived'];
  selected: string | undefined;
  onSelect: (key: string) => void;
}) {
  const items: ResultItem[] = [...hits.map((hit) => ({ key: String(hit.id), hit })), ...(derived ? [{ key: DERIVED_ID, hit: null }] : [])];
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  if (items.length === 0) return null;
  const current = Math.min(active, items.length - 1);
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const moves: Record<string, number> = { ArrowDown: current + 1, ArrowUp: current - 1, Home: 0, End: items.length - 1 };
    if (e.key in moves) {
      e.preventDefault();
      setActive(Math.min(Math.max(moves[e.key]!, 0), items.length - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(items[current]!.key);
    }
  };
  return (
    <ul
      role="listbox"
      tabIndex={0}
      aria-label="Concepts"
      aria-activedescendant={`concept-option-${items[current]!.key}`}
      onKeyDown={onKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      className={`space-y-1 rounded ${FOCUS}`}
    >
      {items.map(({ key, hit }, i) => (
        <li
          key={key}
          id={`concept-option-${key}`}
          role="option"
          aria-selected={selected === key}
          onClick={() => {
            setActive(i);
            onSelect(key);
          }}
          className={`min-h-6 cursor-pointer space-y-1 rounded border px-2 py-1.5 text-sm ${
            selected === key ? 'border-zinc-400 bg-zinc-200 dark:border-zinc-600 dark:bg-zinc-800' : 'border-zinc-200 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-900'
          } ${focused && i === current ? 'outline-2 outline-blue-600 dark:outline-blue-400' : ''}`}
        >
          {hit ? (
            <>
              <div className="font-medium">{hit.name}</div>
              <div className={`text-xs ${MUTED}`}>{stepCount(hit.step_count)}</div>
              <div className="flex flex-wrap gap-1">
                {(Object.keys(TRUST_LABEL) as Trust[]).filter((t) => hit.trust[t] > 0).map((t) => (
                  <TrustBadge key={t} trust={t} count={hit.trust[t]} />
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="font-medium">{derived?.steps[0]?.symbol?.qualified_name ?? 'Call chain'}</div>
              <div className={`text-xs ${MUTED}`}>{stepCount(derived?.steps.length ?? 0)}</div>
              <DerivedBadge />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function SavedPanel({ id }: { id: string }) {
  const detail = useApi<ConceptDetail>(`concepts/${id}`);
  const graph = useApi<ConceptGraph>(`concepts/${id}/graph`);
  if (detail.error) return <p role="alert" className="text-red-700 dark:text-red-400">{detail.error.message}</p>;
  if (!detail.data) return <p role="status" className={MUTED}>Loading…</p>;
  const d = detail.data;
  return (
    <StepsAndGraph
      key={id}
      title={d.name}
      subtitle={d.body}
      badge={d.status in TRUST_LABEL ? <TrustBadge trust={headerTrust(d.status as Trust, d.steps)} /> : <Badge value={d.status} />}
      note={d.status_reason}
      steps={d.steps}
      graph={graph.data}
      graphError={graph.error}
    />
  );
}

function DerivedPanel({ steps }: { steps: ConceptStep[] }) {
  const graph = useMemo(() => derivedGraph(steps), [steps]);
  return (
    <StepsAndGraph
      key={steps.map((s) => s.symbol?.id).join(',')}
      title={steps[0]?.symbol?.qualified_name ?? 'Call chain'}
      subtitle=""
      badge={<DerivedBadge />}
      note={null}
      steps={steps}
      graph={graph}
      graphError={null}
    />
  );
}

const isFileAnchor = (s: ConceptStep['symbol']) => s !== null && (s.id === null || s.kind === 'file');
const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const stepNodeId = (s: NonNullable<ConceptStep['symbol']>): NodeId => (s.id === null || s.kind === 'file' ? `file:${s.repo}:${s.path}` : s.id);

function derivedGraph(steps: ConceptStep[]): ConceptGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let prev: NodeId | null = null;
  let prevHandoff: string | null = null;
  for (const s of steps) {
    if (!s.symbol) continue;
    const id = stepNodeId(s.symbol);
    if (!nodes.some((n) => n.id === id)) {
      nodes.push({
        id,
        label: isFileAnchor(s.symbol) ? baseOf(s.symbol.path) : s.symbol.qualified_name,
        repo: s.symbol.repo,
        path: s.symbol.path,
        dir: dirOf(s.symbol.path),
        kind: isFileAnchor(s.symbol) ? 'file' : s.symbol.kind,
        line_start: isFileAnchor(s.symbol) ? null : s.symbol.line_start,
        step_ordinal: s.ordinal,
      });
    }
    if (prev !== null && prev !== id) edges.push({ src: prev, dst: id, kind: prevHandoff ?? 'then' });
    prev = id;
    prevHandoff = s.handoff;
  }
  return { nodes, edges, truncated: false };
}

function mergeGraphs(base: ConceptGraph, extra: Array<ConceptGraph | undefined>): ConceptGraph {
  const nodes = new Map(base.nodes.map((n) => [n.id, n]));
  const edges = new Map(base.edges.map((e) => [`${e.src}>${e.dst}>${e.kind}`, e]));
  for (const g of extra) {
    if (!g) continue;
    for (const n of g.nodes) if (!nodes.has(n.id)) nodes.set(n.id, { ...n, step_ordinal: null });
    for (const e of g.edges) edges.set(`${e.src}>${e.dst}>${e.kind}`, e);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], truncated: base.truncated || extra.some((g) => g?.truncated) };
}

const stepLocation = (s: ConceptStep) => {
  if (!s.symbol) return null;
  return isFileAnchor(s.symbol) || s.symbol.line_start === null ? s.symbol.path : `${s.symbol.path}:${s.symbol.line_start}`;
};

function StepsAndGraph({
  title,
  subtitle,
  badge,
  note,
  steps,
  graph,
  graphError,
}: {
  title: string;
  subtitle: string;
  badge: ReactNode;
  note: string | null;
  steps: ConceptStep[];
  graph: ConceptGraph | undefined;
  graphError: Error | null;
}) {
  const [step, setStep] = useState<number | null>(null);
  const [picked, setPicked] = useState<NodeId | null>(null);
  const [expanded, setExpanded] = useState<number[]>([]);
  const [showGraph, setShowGraph] = useState(false);
  const extra = useApis<ConceptGraph>(expanded.map((sid) => `symbols/${sid}/neighbourhood`));
  const extraKey = extra.map((r) => r.dataUpdatedAt).join(',');
  const merged = useMemo(() => (graph ? mergeGraphs(graph, extra.map((r) => r.data)) : undefined), [graph, extraKey]);
  const stepNode = (ordinal: number | null): NodeId | null => {
    const s = steps.find((x) => x.ordinal === ordinal);
    return s?.symbol ? stepNodeId(s.symbol) : null;
  };
  const selected = picked ?? stepNode(step);
  const selectStep = (ordinal: number) => {
    setStep(ordinal);
    setPicked(null);
  };
  const onNode = (n: GraphNode) => {
    if (n.step_ordinal !== null) selectStep(n.step_ordinal);
    else {
      setStep(null);
      setPicked(n.id);
    }
  };
  const pickedNode = picked === null ? null : merged?.nodes.find((n) => n.id === picked) ?? null;

  return (
    <>
      <section aria-label="Steps" className="space-y-2">
        <div className="space-y-1">
          <h2 className="flex flex-wrap items-center gap-2 font-medium">{title} {badge}</h2>
          {subtitle ? <Markdown className={MUTED}>{subtitle}</Markdown> : null}
          {note ? <p className={`text-xs ${MUTED}`}>{note}</p> : null}
        </div>
        <ol className="space-y-1">
          {steps.map((s, i) => {
            const location = stepLocation(s);
            const name = s.symbol ? (isFileAnchor(s.symbol) ? s.symbol.path : s.symbol.qualified_name) : 'Anchor gone';
            return (
              <li key={s.ordinal}>
                <button
                  type="button"
                  aria-pressed={step === s.ordinal}
                  onClick={() => selectStep(s.ordinal)}
                  className={`block min-h-6 w-full rounded border px-2 py-1.5 text-left text-sm ${FOCUS} ${
                    step === s.ordinal
                      ? 'border-blue-600 bg-blue-50 dark:border-blue-400 dark:bg-blue-950'
                      : 'border-zinc-200 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-900'
                  }`}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className={`font-mono text-xs ${MUTED}`}>{s.ordinal}</span>
                    <span className="font-medium break-all">{name}</span>
                    {s.trust && <TrustBadge trust={s.trust} />}
                  </span>
                  <Markdown inline className="block">{s.description}</Markdown>
                  {location && <span className={`block font-mono text-xs break-all ${MUTED}`}>{location}</span>}
                  {s.trust_reason && <span className={`block text-xs ${MUTED}`}>{s.trust_reason}</span>}
                </button>
                {i < steps.length - 1 && (
                  <span className={`block pl-3 text-xs ${MUTED}`}>
                    <span aria-hidden="true">↓ </span>
                    {s.handoff ?? 'then'}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </section>
      <section aria-label="Graph" className="min-w-0 space-y-2">
        <button type="button" className={`${TARGET} lg:hidden`} aria-expanded={showGraph} onClick={() => setShowGraph(!showGraph)}>
          {CONCEPT_COPY.showGraph}
        </button>
        <div className={`${showGraph ? 'block' : 'hidden'} space-y-2 lg:block`}>
          {graphError ? (
            <p role="alert" className="text-red-700 dark:text-red-400">{graphError.message}</p>
          ) : !merged ? (
            <p role="status" className={MUTED}>Loading…</p>
          ) : (
            <GraphPanel
              graph={merged}
              selected={selected}
              picked={pickedNode}
              canExpand={pickedNode !== null && typeof pickedNode.id === 'number' && !expanded.includes(pickedNode.id)}
              onExpand={() => typeof picked === 'number' && setExpanded([...expanded, picked])}
              onNode={onNode}
            />
          )}
        </div>
      </section>
    </>
  );
}

const NODE_W = 190;
const NODE_H = 30;
const COL_W = 236;
const NODE_GAP = 8;
const GROUP_PAD = 8;
const LABEL_H = 18;
const GROUP_GAP = 14;
const PAD = 16;

interface Placed {
  node: GraphNode;
  col: number;
  x: number;
  y: number;
}

interface DirGroup {
  dir: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const clipLeft = (s: string, n: number) => (s.length > n ? `…${s.slice(s.length - n + 1)}` : s);

// Layered layout: a step's rank is its ordinal; every other node takes the
// lowest rank among its ranked neighbours, round by round outward from the
// steps. Within a rank, nodes sort by directory and each directory run is
// drawn as one group.
function layoutGraph(graph: ConceptGraph) {
  const rank = new Map<NodeId, number>();
  for (const n of graph.nodes) if (n.step_ordinal !== null && !rank.has(n.id)) rank.set(n.id, n.step_ordinal);
  const adjacent = new Map<NodeId, NodeId[]>();
  for (const e of graph.edges) {
    adjacent.set(e.src, [...(adjacent.get(e.src) ?? []), e.dst]);
    adjacent.set(e.dst, [...(adjacent.get(e.dst) ?? []), e.src]);
  }
  for (let changed = true; changed; ) {
    const next = new Map<NodeId, number>();
    for (const n of graph.nodes) {
      if (rank.has(n.id)) continue;
      const ranks = (adjacent.get(n.id) ?? []).map((o) => rank.get(o)).filter((r): r is number => r !== undefined);
      if (ranks.length > 0) next.set(n.id, Math.min(...ranks));
    }
    for (const [k, v] of next) rank.set(k, v);
    changed = next.size > 0;
  }
  const fallback = Math.max(0, ...rank.values()) + 1;
  const ranks = [...new Set(graph.nodes.map((n) => rank.get(n.id) ?? fallback))].sort((a, b) => a - b);
  const placed = new Map<NodeId, Placed>();
  const groups: DirGroup[] = [];
  let height = 0;
  ranks.forEach((r, col) => {
    const members = graph.nodes
      .filter((n) => (rank.get(n.id) ?? fallback) === r)
      .sort(
        (a, b) =>
          a.dir.localeCompare(b.dir) ||
          (a.step_ordinal ?? Infinity) - (b.step_ordinal ?? Infinity) ||
          a.label.localeCompare(b.label),
      );
    const x = PAD + GROUP_PAD + col * COL_W;
    let y = PAD;
    let group: DirGroup | null = null;
    for (const node of members) {
      if (!group || group.dir !== node.dir) {
        if (group) y = group.y + group.h + GROUP_GAP;
        group = { dir: node.dir, x: x - GROUP_PAD, y, w: NODE_W + 2 * GROUP_PAD, h: 0 };
        groups.push(group);
        y += LABEL_H;
      }
      placed.set(node.id, { node, col, x, y });
      y += NODE_H + NODE_GAP;
      group.h = y - NODE_GAP + GROUP_PAD - group.y;
    }
    if (group) height = Math.max(height, group.y + group.h + PAD);
  });
  return { placed, groups, width: PAD * 2 + ranks.length * COL_W, height };
}

function edgePath(a: Placed, b: Placed): string {
  const ay = a.y + NODE_H / 2;
  const by = b.y + NODE_H / 2;
  if (a.col === b.col) {
    const x = a.x + NODE_W;
    return `M${x},${ay} C${x + 40},${ay} ${x + 40},${by} ${x},${by}`;
  }
  const forward = a.col < b.col;
  const x1 = forward ? a.x + NODE_W : a.x;
  const x2 = forward ? b.x : b.x + NODE_W;
  const dx = Math.max(30, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1);
  return `M${x1},${ay} C${x1 + dx},${ay} ${x2 - dx},${by} ${x2},${by}`;
}

const EDGE_STYLE: Record<string, { dash?: string; label: string }> = {
  calls: { label: 'calls' },
  imports: { dash: '6 4', label: 'imports' },
  runs: { dash: '2 3', label: 'runs' },
  sources: { dash: '2 3', label: 'sources' },
  then: { label: 'then' },
};

const LEGEND: Array<[string, string]> = [
  ['calls', 'calls'],
  ['imports', 'imports'],
  ['runs', 'runs or sources'],
  ['then', 'then (next step)'],
];

function GraphPanel({
  graph,
  selected,
  picked,
  canExpand,
  onExpand,
  onNode,
}: {
  graph: ConceptGraph;
  selected: NodeId | null;
  picked: GraphNode | null;
  canExpand: boolean;
  onExpand: () => void;
  onNode: (n: GraphNode) => void;
}) {
  const [table, setTable] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const dirs = new Set(graph.nodes.map((n) => n.dir)).size;
  const functions = graph.nodes.length;
  const at = selected === null ? undefined : layout.placed.get(selected);

  useEffect(() => {
    const el = box.current;
    if (!el || !at) return;
    el.scrollTo({
      left: at.x + NODE_W / 2 - el.clientWidth / 2,
      top: at.y + NODE_H / 2 - el.clientHeight / 2,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [at?.x, at?.y]);

  const labelOf = (id: NodeId) => layout.placed.get(id)?.node.label ?? String(id);
  const pathOf = (id: NodeId) => {
    const n = layout.placed.get(id)?.node;
    return n ? (n.line_start === null ? n.path : `${n.path}:${n.line_start}`) : '';
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button type="button" className={TARGET} aria-pressed={table} onClick={() => setTable(!table)}>
          {CONCEPT_COPY.showTable}
        </button>
        <span className={MUTED}>
          {functions} {functions === 1 ? 'function' : 'functions'} in {dirs} {dirs === 1 ? 'directory' : 'directories'}
        </span>
        {graph.truncated && <span className={MUTED}>Some neighbours are not shown.</span>}
      </div>
      {picked && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-zinc-200 px-2 py-1 text-sm dark:border-zinc-800">
          <span className="font-medium break-all">{picked.label}</span>
          <span className={`font-mono text-xs break-all ${MUTED}`}>{pathOf(picked.id)}</span>
          {canExpand && <button type="button" className={TARGET} onClick={onExpand}>Show neighbours</button>}
        </div>
      )}
      <div ref={box} className="max-h-[70vh] overflow-auto rounded border border-zinc-200 dark:border-zinc-800">
        <svg
          role="img"
          aria-label={`${functions} ${functions === 1 ? 'function' : 'functions'} in ${dirs} ${dirs === 1 ? 'directory' : 'directories'}`}
          width={layout.width}
          height={layout.height}
          className="block"
        >
          <defs>
            <marker id="concept-arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="fill-zinc-500 dark:fill-zinc-400" />
            </marker>
          </defs>
          {layout.groups.map((g) => (
            <g key={`${g.x}:${g.y}`}>
              <rect x={g.x} y={g.y} width={g.w} height={g.h} rx={8} className="fill-zinc-50 stroke-zinc-300 dark:fill-zinc-900 dark:stroke-zinc-700" />
              <text x={g.x + GROUP_PAD} y={g.y + 13} className="fill-zinc-600 font-mono text-[11px] dark:fill-zinc-400">
                {clipLeft(g.dir || '(repo root)', 30)}
              </text>
            </g>
          ))}
          {graph.edges.map((e) => {
            const a = layout.placed.get(e.src);
            const b = layout.placed.get(e.dst);
            if (!a || !b) return null;
            const hot = selected !== null && (e.src === selected || e.dst === selected);
            const style = EDGE_STYLE[e.kind] ?? { label: e.kind };
            const tone = hot
              ? 'stroke-blue-600 dark:stroke-blue-400'
              : e.kind === 'then'
                ? 'stroke-zinc-400 dark:stroke-zinc-500'
                : 'stroke-zinc-600 dark:stroke-zinc-300';
            return (
              <path
                key={`${e.src}>${e.dst}>${e.kind}`}
                d={edgePath(a, b)}
                fill="none"
                strokeWidth={hot ? 2 : e.kind === 'then' ? 1 : 1.5}
                strokeDasharray={style.dash}
                markerEnd="url(#concept-arrow)"
                className={tone}
              />
            );
          })}
          {[...layout.placed.values()].map(({ node, x, y }) => {
            const isSelected = node.id === selected;
            const isStep = node.step_ordinal !== null;
            const shape = isSelected
              ? 'fill-blue-100 stroke-blue-700 dark:fill-blue-950 dark:stroke-blue-400'
              : isStep
                ? 'fill-white stroke-zinc-700 dark:fill-zinc-950 dark:stroke-zinc-300'
                : 'fill-white stroke-zinc-400 dark:fill-zinc-950 dark:stroke-zinc-600';
            const text = `${isStep ? `${node.step_ordinal} ` : ''}${node.label}`;
            return (
              <g key={String(node.id)} onClick={() => onNode(node)} className="cursor-pointer">
                <title>{`${node.label} — ${node.line_start === null ? node.path : `${node.path}:${node.line_start}`}`}</title>
                <rect x={x} y={y} width={NODE_W} height={NODE_H} rx={4} strokeWidth={isSelected ? 2.5 : isStep ? 1.5 : 1} className={shape} />
                <text x={x + 8} y={y + NODE_H / 2 + 4} className={`fill-zinc-900 font-mono text-xs dark:fill-zinc-100 ${isStep ? 'font-semibold' : ''}`}>
                  {clip(text, 26)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <ul aria-label="Edge legend" className={`flex flex-wrap gap-3 text-xs ${MUTED}`}>
        {LEGEND.map(([kind, label]) => (
          <li key={kind} className="flex items-center gap-1">
            <svg aria-hidden="true" width="28" height="8">
              <line
                x1="0"
                y1="4"
                x2="28"
                y2="4"
                strokeWidth={kind === 'then' ? 1 : 1.5}
                strokeDasharray={EDGE_STYLE[kind]?.dash}
                className={kind === 'then' ? 'stroke-zinc-400 dark:stroke-zinc-500' : 'stroke-zinc-600 dark:stroke-zinc-300'}
              />
            </svg>
            {label}
          </li>
        ))}
      </ul>
      {table && (
        <table className="w-full text-left text-sm">
          <caption className={`text-left text-xs ${MUTED}`}>Edges</caption>
          <thead>
            <tr className="border-b border-zinc-200 dark:border-zinc-800">
              <th className="py-1 pr-2 font-medium">From</th>
              <th className="py-1 pr-2 font-medium">Kind</th>
              <th className="py-1 font-medium">To</th>
            </tr>
          </thead>
          <tbody>
            {graph.edges.length === 0 && (
              <tr><td colSpan={3} className={`py-1 ${MUTED}`}>No edges between these functions.</td></tr>
            )}
            {graph.edges.map((e) => (
              <tr key={`${e.src}>${e.dst}>${e.kind}`} className="border-b border-zinc-100 dark:border-zinc-900">
                <td className="py-1 pr-2"><span className="font-medium">{labelOf(e.src)}</span> <span className={`font-mono text-xs ${MUTED}`}>{pathOf(e.src)}</span></td>
                <td className="py-1 pr-2">{(EDGE_STYLE[e.kind] ?? { label: e.kind }).label}</td>
                <td className="py-1"><span className="font-medium">{labelOf(e.dst)}</span> <span className={`font-mono text-xs ${MUTED}`}>{pathOf(e.dst)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
