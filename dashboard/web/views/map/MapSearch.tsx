import { FileDirectoryFillIcon, FileIcon, SearchIcon } from '@primer/octicons-react';
import { useEffect, useState } from 'react';
import { query, useApi, type WorldModelSearch } from '../../api.ts';
import { FIELD } from '../../shared/classes.ts';
import { Loading } from '../../shared/Loading.tsx';
import { Box, BoxHeader, BoxRow } from '../../ui/Box.tsx';
import { CounterLabel } from '../../ui/CounterLabel.tsx';
import { Label } from '../../ui/Label.tsx';

type OpenDir = (repo: string, path: string) => void;

export function useDebouncedTerm() {
  const [input, setInput] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(input.trim()), 250);
    return () => clearTimeout(t);
  }, [input]);
  return { input, setInput, term };
}

export function SearchField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="relative block w-full sm:max-w-xs">
      <span className="sr-only">Search directories and files</span>
      <SearchIcon size={16} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-muted" aria-hidden="true" />
      <input type="search" className={`${FIELD} min-h-(--control-medium-size) pl-8`} placeholder="Search directories and files…" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function SearchResults({ term, onOpen }: { term: string; onOpen: OpenDir }) {
  const q = useApi<WorldModelSearch>(`world-model/search?${query({ q: term, limit: '50' })}`);
  return (
    <Loading q={q}>
      {(r) => (
        <Box className="min-w-0 overflow-hidden">
          <BoxHeader className="flex items-center gap-2 text-sm font-semibold">
            Results for “{term}” <CounterLabel>{r.hits.length}</CounterLabel>
          </BoxHeader>
          {r.hits.length === 0 && <BoxRow className="text-sm text-fg-muted">No matches.</BoxRow>}
          {r.hits.map((h) => {
            const dir = h['kind'] === 'directory';
            const repo = String(h['repo']);
            const path = String(h['path']);
            const Icon = dir ? FileDirectoryFillIcon : FileIcon;
            return (
              <BoxRow key={`${h['kind']}:${repo}:${path}`} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <Icon size={16} className={`shrink-0 ${dir ? 'text-(--fgColor-accent)' : 'text-fg-muted'}`} aria-hidden="true" />
                {dir ? (
                  <button type="button" className="min-w-0 cursor-pointer truncate text-left text-fg hover:text-(--fgColor-accent) hover:underline" onClick={() => onOpen(repo, path)}>
                    {path || repo}
                  </button>
                ) : (
                  <span className="min-w-0 truncate text-fg">{path}</span>
                )}
                <Label variant="secondary">{repo}</Label>
                {h['text'] ? <span className="w-full min-w-0 truncate pl-7 text-fg-muted">{String(h['text'])}</span> : null}
              </BoxRow>
            );
          })}
        </Box>
      )}
    </Loading>
  );
}
