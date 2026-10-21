import { useMemo, useState, type ReactNode } from 'react';
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

export interface Column {
  key: string;
  header: string;
  cell?: (row: Row) => ReactNode;
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

  return (
    <div className="space-y-2">
      {filter && (
        <input
          className="w-full max-w-xs rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
          placeholder="Filter…"
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
        />
      )}
      <div className="overflow-x-auto rounded border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-100 dark:bg-zinc-900">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    className="cursor-pointer select-none whitespace-nowrap px-3 py-2 font-medium"
                    onClick={h.column.getToggleSortingHandler()}
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {{ asc: ' ▲', desc: ' ▼' }[h.column.getIsSorted() as string] ?? ''}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((r) => (
              <tr
                key={r.id}
                className={`border-t border-zinc-200 dark:border-zinc-800 ${onRowClick ? 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900' : ''}`}
                onClick={onRowClick ? () => onRowClick(r.original) : undefined}
              >
                {r.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-1.5 align-top">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {table.getRowModel().rows.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-zinc-500" colSpan={columns.length}>
                  No rows.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatCell(value: unknown): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="text-zinc-400">—</span>;
  return String(value);
}
