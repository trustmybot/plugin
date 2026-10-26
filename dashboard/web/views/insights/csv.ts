export type Cell = string | number;

export interface TableData {
  columns: string[];
  rows: Cell[][];
}

const quote = (cell: Cell) => {
  const text = String(cell);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// RFC 4180: CRLF line ends, fields with a quote, comma or line break quoted.
export const toCsv = ({ columns, rows }: TableData) => [columns, ...rows].map((r) => r.map(quote).join(',')).join('\r\n');

export const csvName = (section: string, range: string) => `insights-${section}-${range}.csv`;

export function downloadCsv(table: TableData, name: string): void {
  const url = URL.createObjectURL(new Blob([toCsv(table)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
