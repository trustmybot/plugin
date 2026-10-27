import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { DownloadIcon, GraphIcon, KebabHorizontalIcon, TableIcon } from '@primer/octicons-react';
import { Box, BoxHeader } from '../../ui/Box.tsx';
import { buttonClass } from '../../ui/Button.tsx';
import { csvName, downloadCsv, type TableData } from './csv.ts';

export interface LegendItem {
  label: string;
  color: string;
  kind?: 'fill' | 'outline';
}

export const OUTLINE_DASH = '4 3';

const MENU_ITEM =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-(--control-transparent-bgColor-hover) focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color) focus-visible:-outline-offset-2';

function CardMenu({ title, asTable, onToggle, onDownload }: { title: string; asTable: boolean; onToggle: () => void; onDownload: () => void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        className={buttonClass('invisible', 'small')}
        aria-label={`${title} options`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <KebabHorizontalIcon size={16} aria-hidden="true" />
      </button>
      <div
        id={id}
        role="menu"
        aria-label={`${title} options`}
        hidden={!open}
        className="absolute right-0 z-10 mt-1 w-48 rounded-md border border-(--borderColor-default) bg-(--overlay-bgColor) p-1 shadow-(--shadow-floating-small)"
      >
        <button type="button" role="menuitem" className={MENU_ITEM} onClick={choose(onToggle)}>
          {asTable ? <GraphIcon size={16} aria-hidden="true" /> : <TableIcon size={16} aria-hidden="true" />}
          {asTable ? 'View as Chart' : 'View as Table'}
        </button>
        <button type="button" role="menuitem" className={MENU_ITEM} onClick={choose(onDownload)}>
          <DownloadIcon size={16} aria-hidden="true" />
          Download CSV
        </button>
      </div>
    </div>
  );
}

export function DataTableView({ caption, table, captionRef }: { caption: string; table: TableData; captionRef?: React.Ref<HTMLTableCaptionElement> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular-nums">
        <caption ref={captionRef} tabIndex={-1} className="px-1 pb-2 text-left text-fg-muted focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color)">
          {caption}
        </caption>
        <thead>
          <tr className="border-b border-(--borderColor-default) text-left text-fg-muted">
            {table.columns.map((c) => (
              <th key={c} scope="col" className="px-2 py-1.5 font-semibold">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i} className="border-b border-(--borderColor-muted) last:border-b-0">
              {row.map((cell, j) => (
                <td key={j} className="px-2 py-1.5 whitespace-nowrap">{String(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Legend({ items }: { items: LegendItem[] }) {
  if (items.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted" aria-label="Legend">
      {items.map((item) => (
        <li key={item.label} className="inline-flex items-center gap-1.5">
          <svg width="16" height="8" aria-hidden="true" data-legend-kind={item.kind}>
            {item.kind === 'fill' ? (
              <>
                <rect x="0" y="0" width="16" height="8" rx="2" fill={item.color} style={{ fillOpacity: 'var(--chart-wash)' }} />
                <line x1="1" x2="15" y1="1" y2="1" stroke={item.color} strokeWidth="2" />
              </>
            ) : item.kind === 'outline' ? (
              <rect x="0.75" y="0.75" width="14.5" height="6.5" rx="2" fill="none" stroke={item.color} strokeWidth="1.5" strokeDasharray={OUTLINE_DASH} />
            ) : (
              <line x1="0" x2="16" y1="4" y2="4" stroke={item.color} strokeWidth="2" />
            )}
          </svg>
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export interface ChartCardProps {
  title: string;
  subtitle: string;
  section: string;
  range: string;
  table: TableData;
  legend?: LegendItem[];
  caption?: ReactNode;
  defaultTable?: boolean;
  children: ReactNode;
}

export function ChartCard({ title, subtitle, section, range, table, legend = [], caption, defaultTable = false, children }: ChartCardProps) {
  const [asTable, setAsTable] = useState(defaultTable);
  const captionRef = useRef<HTMLTableCaptionElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (asTable && moved.current) captionRef.current?.focus();
  }, [asTable]);
  const toggle = () => {
    moved.current = true;
    setAsTable(!asTable);
  };
  return (
    <Box className="min-w-0" data-chart-card="">
      <BoxHeader className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          <p className="text-xs text-fg-muted">{subtitle}</p>
        </div>
        <CardMenu title={title} asTable={asTable} onToggle={toggle} onDownload={() => downloadCsv(table, csvName(section, range))} />
      </BoxHeader>
      <div className="space-y-2 px-4 py-3">
        <Legend items={legend} />
        {asTable ? <DataTableView caption={`${title}, ${subtitle}`} table={table} captionRef={captionRef} /> : children}
        {caption && <p className="text-xs text-fg-muted">{caption}</p>}
      </div>
    </Box>
  );
}
