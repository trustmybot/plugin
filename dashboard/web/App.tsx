import { useEffect, useState, type ReactNode } from 'react';
import {
  query,
  useApi,
  useLiveRefresh,
  type Gates,
  type IssueDetail,
  type Row,
  type Summary,
  type WmNode,
  type WorldModel,
  type WorldModelSearch,
} from './api.ts';
import { DataTable, type Column } from './DataTable.tsx';

const TABS = [
  ['overview', 'Overview'],
  ['issues', 'Issues'],
  ['tasks', 'Tasks'],
  ['runs', 'Runs & gates'],
  ['audit', 'Audit'],
  ['map', 'Project map'],
] as const;

function useHashRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
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
    <div className="mx-auto max-w-7xl space-y-4 p-4">
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
        <span className="ml-auto text-xs text-zinc-500">read-only · live</span>
      </header>
      {tab === 'issues' && id ? <IssueView id={id} /> : <TabView tab={tab} />}
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
};

function Badge({ value }: { value: unknown }) {
  const s = String(value ?? '—');
  return <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_COLORS[s] ?? 'bg-zinc-100 dark:bg-zinc-800'}`}>{s}</span>;
}

const badge = (key: string) => (r: Row) => <Badge value={r[key]} />;
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
  { key: 'task_title', header: 'Title' },
  { key: 'started_at', header: 'Started' },
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
  { key: 'objective', header: 'Objective' },
  { key: 'status', header: 'Status', cell: badge('status') },
  { key: 'repo', header: 'Repo' },
  { key: 'gh_iid', header: 'GH' },
  { key: 'tasks_done', header: 'Tasks', cell: (r) => `${r['tasks_done']}/${r['task_count']}` },
  { key: 'updated_at', header: 'Updated' },
];

function IssuesView() {
  const q = useApi<Row[]>('issues');
  return <Loading q={q}>{(rows) => <DataTable rows={rows} columns={ISSUE_COLUMNS} onRowClick={(r) => go(`issues/${r['id']}`)} />}</Loading>;
}

const ISSUE_TASK_COLUMNS: Column[] = [
  { key: 'id', header: 'Task' },
  { key: 'branch_id', header: 'Branch' },
  { key: 'title', header: 'Title' },
  { key: 'status', header: 'Status', cell: badge('status') },
  { key: 'commit_sha', header: 'Commit', cell: (r) => String(r['commit_sha'] ?? '').slice(0, 8) },
  { key: 'updated_at', header: 'Updated' },
];

function IssueView({ id }: { id: string }) {
  const q = useApi<IssueDetail>(`issues/${id}`);
  return (
    <Loading q={q}>
      {(d) => (
        <div className="space-y-6">
          <div className="space-y-1">
            <a href="#/issues" className="text-sm text-zinc-500 hover:underline">← Issues</a>
            <h2 className="text-xl font-semibold">
              #{String(d.issue['id'])} {String(d.issue['objective'])}
            </h2>
            <div className="flex gap-2 text-sm text-zinc-500">
              <Badge value={d.issue['status']} />
              {d.issue['gh_iid'] ? <span>GH {String(d.issue['gh_iid'])}</span> : null}
              <span>updated {String(d.issue['updated_at'])}</span>
            </div>
            {d.issue['description'] ? <p className="whitespace-pre-wrap text-sm">{String(d.issue['description'])}</p> : null}
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
                  <span>{String(c['created_at'])}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm">{String(c['body'])}</p>
              </article>
            ))}
          </section>
        </div>
      )}
    </Loading>
  );
}

const TASK_COLUMNS: Column[] = [
  { key: 'id', header: 'Task' },
  { key: 'issue_id', header: 'Issue' },
  { key: 'title', header: 'Title' },
  { key: 'branch_id', header: 'Branch' },
  { key: 'status', header: 'Status', cell: badge('status') },
  { key: 'effort', header: 'Effort' },
  { key: 'repo', header: 'Repo' },
  { key: 'updated_at', header: 'Updated' },
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
  { key: 'task_title', header: 'Title' },
  { key: 'attempt_n', header: 'Attempt' },
  { key: 'agent', header: 'Agent' },
  { key: 'verdict', header: 'Verdict', cell: badge('verdict') },
  { key: 'created_at', header: 'At' },
];

const VERIFICATION_COLUMNS: Column[] = [
  { key: 'id', header: 'Run' },
  { key: 'task_id', header: 'Task' },
  { key: 'task_title', header: 'Title' },
  { key: 'commit_sha', header: 'Commit', cell: (r) => String(r['commit_sha'] ?? '').slice(0, 8) },
  { key: 'source', header: 'Source' },
  { key: 'exit_code', header: 'Result', cell: exitBadge },
  { key: 'failed_commands', header: 'Failed', cell: (r) => `${r['failed_commands']}/${r['commands']}` },
  { key: 'started_at', header: 'Started' },
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
  { key: 'created_at', header: 'At' },
  { key: 'issue_id', header: 'Issue' },
  { key: 'branch_id', header: 'Branch' },
  { key: 'from_node', header: 'From' },
  { key: 'event_type', header: 'Event' },
  { key: 'summary', header: 'Summary' },
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
          <div className="grid gap-6 lg:grid-cols-2">
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
  { key: 'path', header: 'Path' },
  { key: 'text', header: 'Summary' },
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
