import { DatabaseIcon, FileDirectoryIcon } from '@primer/octicons-react';
import { lazy, Suspense, useMemo, useState, useSyncExternalStore } from 'react';
import { query, useApi, type WorldModel } from '../api.ts';
import { DepGraph } from '../DepGraph.tsx';
import { Loading } from '../shared/Loading.tsx';
import { currentHash, mapHash, parseMapQuery, subscribeHash, type MapScope } from '../shared/route.ts';
import { Blankslate } from '../ui/Blankslate.tsx';
import { Box } from '../ui/Box.tsx';
import { SegmentedControl, type Segment } from '../ui/SegmentedControl.tsx';
import { DirectoryListing } from './map/DirectoryListing.tsx';
import { DirectoryTree } from './map/DirectoryTree.tsx';
import { SearchField, SearchResults, useDebouncedTerm } from './map/MapSearch.tsx';
import { ancestors } from './map/paths.ts';
import { RepoPicker } from './map/RepoPicker.tsx';

const ConceptSearch = lazy(() => import('./concepts/ConceptSearch.tsx').then((m) => ({ default: m.ConceptSearch })));

const SCOPES: readonly Segment<MapScope>[] = [
  { value: 'files', label: 'Files' },
  { value: 'concepts', label: 'Concepts' },
];

function useMapQuery() {
  const hash = useSyncExternalStore(subscribeHash, currentHash, currentHash);
  return useMemo(() => parseMapQuery(hash.split('?')[1] ?? ''), [hash]);
}

export function ProjectMapView() {
  const [picked, setPicked] = useState('');
  const [selected, setSelected] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(['']));
  const route = useMapQuery();
  const search = useDebouncedTerm();
  const q = useApi<WorldModel>(`world-model?${query({ repo: picked, depth: '0' })}`);

  const open = (repo: string, path: string) => {
    if (repo !== picked) setPicked(repo);
    setSelected(path);
    setExpanded((s) => new Set([...s, ...ancestors(path)]));
  };
  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (next.delete(path)) {
      if (ancestors(selected).includes(path)) setSelected(path);
    } else next.add(path);
    setExpanded(next);
  };
  const navigate = (scope: MapScope, q: string, concept?: string) => {
    window.location.hash = mapHash({ scope, q, ...(concept ? { concept } : {}) });
  };

  return (
    <Loading q={q}>
      {(wm) => {
        if (!wm.available) {
          return (
            <Box>
              <Blankslate icon={DatabaseIcon} heading="World Model Not Built Yet" description="Open a Claude Code session to upgrade the DB and run /scan." />
            </Box>
          );
        }
        const repo = picked || wm.repos[0];
        if (repo === undefined) {
          return (
            <Box>
              <Blankslate icon={FileDirectoryIcon} heading="The World Model Is Empty" description="Run /scan in a Claude Code session." />
            </Box>
          );
        }
        const root = wm.nodes[0];
        return (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <RepoPicker
                repos={wm.repos}
                value={repo}
                onChange={(r) => {
                  setPicked(r);
                  setSelected('');
                  setExpanded(new Set(['']));
                }}
              />
              <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
                <SegmentedControl label="Search scope" segments={SCOPES} value={route.scope} onChange={(scope) => navigate(scope, search.input.trim())} />
                <SearchField scope={route.scope} value={search.input} onChange={search.setInput} />
              </div>
            </div>
            {route.scope === 'concepts' ? (
              <Suspense fallback={<p className="text-fg-muted">Loading…</p>}>
                <ConceptSearch term={search.term} repo={repo} id={route.concept} onSelect={(key) => navigate('concepts', search.term, key)} />
              </Suspense>
            ) : (
              <>
                <div className="grid gap-4 md:grid-cols-[280px_minmax(0,1fr)] [&>*]:min-w-0">
                  <nav aria-label="Directory tree" className="min-w-0">
                    {root ? (
                      <div className="overflow-x-auto py-1 pr-1 pl-2">
                        <DirectoryTree root={root} selected={selected} expanded={expanded} onSelect={(p) => open(repo, p)} onToggle={toggle} />
                      </div>
                    ) : (
                      <p className="text-sm text-fg-muted">No root directory recorded for {repo}.</p>
                    )}
                  </nav>
                  <div className="min-w-0 space-y-4">
                    {search.term && <SearchResults term={search.term} onOpen={open} />}
                    {root && <DirectoryListing repo={repo} path={selected} onSelect={(p) => open(repo, p)} />}
                  </div>
                </div>
                <DepGraph key={repo} repo={repo} />
              </>
            )}
          </div>
        );
      }}
    </Loading>
  );
}
