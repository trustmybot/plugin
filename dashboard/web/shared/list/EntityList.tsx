import { Fragment, useState, type ReactNode } from 'react';
import { SearchIcon, XIcon, type Icon } from '@primer/octicons-react';
import type { Row } from '../../api.ts';
import { Blankslate } from '../../ui/Blankslate.tsx';
import { Box, BoxHeader } from '../../ui/Box.tsx';
import { FIELD } from '../classes.ts';
import { ENTITY_LINK } from '../columns.tsx';
import { hrefWith } from '../route.ts';
import { StateTabs } from './StateTabs.tsx';
import { useListParams } from './useListParams.ts';

export interface ListTab {
  key: string;
  label: string;
  icon: Icon;
  filter: (row: Row) => boolean;
}

export interface ListSort {
  label: string;
  key: string;
  dir: 1 | -1;
}

export interface ListChip {
  key: string;
  label: string;
  clearLabel: string;
}

export interface EntityListProps {
  rows: Row[];
  tabs: ListTab[];
  sorts: Record<string, ListSort>;
  matches: (row: Row, needle: string) => boolean;
  renderRow: (row: Row) => ReactNode;
  chips?: ListChip[];
  tab: string;
  path: string;
  noun: readonly [singular: string, plural: string, heading: string];
  emptyIcon: Icon;
  searchPlaceholder: string;
  controls?: ReactNode;
}

export interface SearchState {
  text: string;
  synced: string;
}

export const typedSearch = (value: string): SearchState => ({ text: value, synced: value.trim() });

export const syncSearch = (state: SearchState, hashQ: string): SearchState => (hashQ === state.synced ? state : { text: hashQ, synced: hashQ });

export function EntityList({ rows, tabs, sorts, matches, renderRow, chips = [], tab, path, noun, emptyIcon, searchPlaceholder, controls }: EntityListProps) {
  const params = useListParams();
  const hashQ = params.get('q') ?? '';
  const [searchState, setSearchState] = useState<SearchState>(() => ({ text: hashQ, synced: hashQ }));
  const synced = syncSearch(searchState, hashQ);
  if (synced !== searchState) setSearchState(synced);
  const search = synced.text;
  const [sort, setSort] = useState(() => Object.keys(sorts)[0]!);
  const current = tabs.find((t) => t.key === tab) ?? tabs[0]!;
  const needle = search.trim().toLowerCase();
  const found = rows.filter((r) => matches(r, needle));
  const { key, dir } = sorts[sort] ?? Object.values(sorts)[0]!;
  const shown = found.filter(current.filter).sort((a, b) => dir * String(a[key] ?? '').localeCompare(String(b[key] ?? ''), undefined, { numeric: true }));
  const stateLabel = current.label.toLowerCase();

  const onSearch = (value: string) => {
    setSearchState(typedSearch(value));
    window.history.replaceState(null, '', hrefWith({ q: value.trim() || null }, path));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <label className="relative min-w-0 flex-1 basis-full sm:basis-60">
          <span className="sr-only">Search {noun[1]}</span>
          <SearchIcon size={16} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-muted" aria-hidden="true" />
          <input type="search" className={`${FIELD} py-1.5 pl-8`} placeholder={searchPlaceholder} value={search} onChange={(e) => onSearch(e.target.value)} />
        </label>
        {controls}
        <label className="flex shrink-0 items-center gap-2 text-sm text-fg-muted">
          Sort
          <select className={`${FIELD} w-auto py-1.5`} value={sort} onChange={(e) => setSort(e.target.value)}>
            {Object.entries(sorts).map(([value, s]) => (
              <option key={value} value={value}>{s.label}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="sr-only" aria-live="polite">
        {shown.length} {stateLabel} {shown.length === 1 ? noun[0] : noun[1]}
      </p>
      <Box>
        <BoxHeader className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <StateTabs
            tabs={tabs.map((t, i) => ({
              key: t.key,
              label: t.label,
              icon: t.icon,
              count: found.filter(t.filter).length,
              href: hrefWith({ state: i === 0 ? null : t.key }, path),
              selected: t.key === current.key,
            }))}
          />
          {chips.length > 0 && (
            <ul role="list" aria-label="Filters" className="flex flex-wrap items-center gap-2">
              {chips.map((c) => (
                <li key={c.key} className="inline-flex max-w-full items-center gap-1 rounded-full border border-(--borderColor-default) bg-canvas px-2 py-0.5 text-xs text-fg">
                  <span className="min-w-0 truncate">{c.label}</span>
                  <a href={hrefWith({ [c.key]: null }, path)} aria-label={c.clearLabel} className={`${ENTITY_LINK} inline-flex shrink-0`}>
                    <XIcon size={12} aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </BoxHeader>
        {shown.length === 0 ? (
          <Blankslate
            icon={emptyIcon}
            heading={needle ? 'No Results Matched Your Search' : `No ${current.label} ${noun[2]}`}
            description={needle ? 'Try a different search.' : undefined}
          />
        ) : (
          <ul role="list">{shown.map((r) => <Fragment key={String(r['id'])}>{renderRow(r)}</Fragment>)}</ul>
        )}
      </Box>
    </div>
  );
}
