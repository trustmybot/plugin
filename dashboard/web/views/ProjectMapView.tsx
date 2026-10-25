import { useEffect, useState } from 'react';
import { query, useApi, type WmNode, type WorldModel, type WorldModelSearch } from '../api.ts';
import { DataTable, type Column } from '../DataTable.tsx';
import { DepGraph } from '../DepGraph.tsx';
import { badge } from '../shared/columns.tsx';
import { Loading } from '../shared/Loading.tsx';

const WM_MISSING = 'World model not built yet — open a Claude Code session to upgrade the DB and run /scan.';

export function ProjectMapView() {
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
          <div className="space-y-6">
            <label className="flex items-center gap-2 text-sm">
              <span className="font-medium">Repo</span>
              <select
                className="rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
                value={repo}
                onChange={(e) => setPicked(e.target.value)}
              >
                {wm.repos.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <DepGraph key={repo} repo={repo} />
            <div className="grid gap-6 lg:grid-cols-2 2xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] [&>*]:min-w-0">
              <section className="space-y-2">
                <h2 className="font-medium">Directories</h2>
                {root ? (
                  <ul className="text-sm"><TreeNode node={root} open /></ul>
                ) : (
                  <p className="text-sm text-zinc-500">No root directory recorded for {repo}.</p>
                )}
              </section>
              <WorldModelSearchView />
            </div>
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
