import { FileDirectoryFillIcon } from '@primer/octicons-react';
import { Fragment } from 'react';
import { useApi, type WorldModel } from '../../api.ts';
import { Loading } from '../../shared/Loading.tsx';
import { Box, BoxHeader, BoxRow } from '../../ui/Box.tsx';
import { CounterLabel } from '../../ui/CounterLabel.tsx';
import { ancestors, childrenOf, childrenPath, dirName } from './paths.ts';

const LINK = 'cursor-pointer text-(--fgColor-accent) hover:underline focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color)';

export function DirectoryListing({ repo, path, onSelect }: { repo: string; path: string; onSelect: (path: string) => void }) {
  const q = useApi<WorldModel>(childrenPath(repo, path), { keepPrevious: true });
  const crumbs = ancestors(path);
  return (
    <Box className="min-w-0 overflow-hidden">
      <BoxHeader className="flex items-center gap-2">
        <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
          <ol className="m-0 flex list-none flex-wrap items-center gap-x-1 p-0 text-sm font-semibold break-all">
            {crumbs.map((p, i) => {
              const name = p === '' ? repo : p.split('/').pop();
              const last = i === crumbs.length - 1;
              return (
                <Fragment key={p}>
                  {i > 0 && <li aria-hidden="true" className="font-normal text-fg-muted">/</li>}
                  <li>
                    {last ? (
                      <span aria-current="page" className="text-fg">{name}</span>
                    ) : (
                      <button type="button" className={LINK} onClick={() => onSelect(p)}>{name}</button>
                    )}
                  </li>
                </Fragment>
              );
            })}
          </ol>
        </nav>
        <Loading q={q}>
          {(wm) => {
            const self = wm.nodes.find((n) => n.path === path);
            if (!self) return null;
            return (
              <span className="flex shrink-0 items-center gap-1 text-xs text-fg-muted" title={`${self.file_count} files`}>
                <CounterLabel>{self.file_count}</CounterLabel> files
              </span>
            );
          }}
        </Loading>
      </BoxHeader>
      <Loading q={q}>
        {(wm) => {
          const kids = childrenOf(wm.nodes, path);
          if (kids.length === 0) return <BoxRow className="text-sm text-fg-muted">No subdirectories.</BoxRow>;
          return kids.map((c) => (
            <BoxRow key={c.path} className="flex items-center gap-3 py-2 text-sm hover:bg-canvas-muted">
              <FileDirectoryFillIcon size={16} className="shrink-0 text-(--treeViewItem-leadingVisual-iconColor-rest,var(--fgColor-accent))" aria-hidden="true" />
              <button type="button" className="shrink-0 cursor-pointer text-fg hover:text-(--fgColor-accent) hover:underline" onClick={() => onSelect(c.path)}>
                {dirName(c)}
              </button>
              <span className="min-w-0 flex-1 truncate text-fg-muted" title={c.summary ?? undefined}>{c.summary}</span>
              <span className="shrink-0 text-xs text-fg-muted tabular-nums">{c.file_count} files</span>
            </BoxRow>
          ));
        }}
      </Loading>
    </Box>
  );
}
