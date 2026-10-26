// Forked from Primer React DataTable (github.com/primer/react, MIT), rebuilt on TanStack Table and Primer tokens without @primer/react.
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowBothIcon, ArrowDownIcon, ArrowUpIcon, SearchIcon, TableIcon } from '@primer/octicons-react';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import type { Row } from './api.ts';
import { FIELD } from './shared/classes.ts';
import { Blankslate } from './ui/Blankslate.tsx';
import { Box } from './ui/Box.tsx';

export interface Column {
  key: string;
  header: string;
  cell?: (row: Row) => ReactNode;
  truncate?: boolean | 'fill';
  hideBelow?: 'sm' | 'md';
}

const HIDE_BELOW = { sm: 'max-sm:hidden', md: 'max-md:hidden' } as const;
const FOCUS_RING = 'focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color) focus-visible:-outline-offset-2';
const ARIA_SORT = { asc: 'ascending', desc: 'descending' } as const;

const cx = (...classes: Array<string | false | undefined>) => classes.filter(Boolean).join(' ');
const hideClass = (col?: Column) => col?.hideBelow && HIDE_BELOW[col.hideBelow];

function SortIcon({ dir }: { dir: false | 'asc' | 'desc' }) {
  if (dir === 'asc') return <ArrowUpIcon size={16} aria-hidden="true" />;
  if (dir === 'desc') return <ArrowDownIcon size={16} aria-hidden="true" />;
  return <ArrowBothIcon size={16} aria-hidden="true" className="rotate-90 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />;
}

export function DataTable({
  rows,
  columns,
  onRowClick,
  filter = true,
}: {
  rows: Row[];
  columns: Column[];
  onRowClick?: (row: Row) => void;
  filter?: boolean;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const defs = useMemo<ColumnDef<Row>[]>(
    () =>
      columns.map((c) => ({
        id: c.key,
        accessorFn: (r) => r[c.key] ?? '',
        header: c.header,
        cell: (ctx) => (c.cell ? c.cell(ctx.row.original) : formatCell(ctx.getValue())),
      })),
    [columns],
  );
  const byKey = useMemo(() => new Map(columns.map((c) => [c.key, c])), [columns]);
  const table = useReactTable({
    data: rows,
    columns: defs,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });
  const visible = table.getRowModel().rows;
  const activate = (row: Row) => (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    onRowClick?.(row);
  };

  return (
    <div className="space-y-3">
      {filter && (
        <div className="relative max-w-sm">
          <SearchIcon size={16} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-muted" />
          <input
            type="search"
            aria-label="Filter rows"
            className={`${FIELD} pl-8`}
            placeholder="Filter…"
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
          />
        </div>
      )}
      <Box className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-left text-sm">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const dir = h.column.getIsSorted();
                  return (
                    <th
                      key={h.id}
                      scope="col"
                      aria-sort={dir ? ARIA_SORT[dir] : 'none'}
                      className={cx(
                        'whitespace-nowrap border-b border-(--borderColor-default) bg-canvas-muted px-4 py-2 text-xs font-semibold text-fg-muted first:rounded-tl-md last:rounded-tr-md max-sm:px-2',
                        hideClass(byKey.get(h.column.id)),
                      )}
                    >
                      <button
                        type="button"
                        className={`group -mx-1 inline-flex items-center gap-1 rounded-md px-1 font-semibold hover:text-fg ${FOCUS_RING}`}
                        onClick={h.column.getToggleSortingHandler()}
                      >
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        <SortIcon dir={dir} />
                      </button>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr
                key={r.id}
                className={cx('group/row', onRowClick && `cursor-pointer ${FOCUS_RING}`)}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick ? () => onRowClick(r.original) : undefined}
                onKeyDown={onRowClick ? activate(r.original) : undefined}
              >
                {r.getVisibleCells().map((cell) => {
                  const col = byKey.get(cell.column.id);
                  const value = cell.getValue();
                  return (
                    <td
                      key={cell.id}
                      className={cx(
                        'whitespace-nowrap border-t border-(--borderColor-muted) px-4 py-2 align-top group-first/row:border-t-0 group-hover/row:bg-canvas-muted max-sm:px-2',
                        col?.truncate === 'fill' ? 'w-full min-w-32 max-w-0 truncate' : col?.truncate && 'max-w-[32rem] truncate',
                        hideClass(col),
                      )}
                      title={col?.truncate && value !== '' && value !== null && value !== undefined ? String(value) : undefined}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={columns.length}>
                  <Blankslate
                    icon={TableIcon}
                    heading={rows.length === 0 ? 'No rows yet' : 'No matching rows'}
                    description={rows.length === 0 ? undefined : 'Try a different filter.'}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Box>
    </div>
  );
}

function formatCell(value: unknown): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="text-fg-muted">—</span>;
  return String(value);
}
