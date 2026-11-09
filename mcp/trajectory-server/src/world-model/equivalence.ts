// Row-level comparison of two world-model DBs for one repo (GH 2584): the
// wm_files, wm_symbols and wm_edges rows each holds, normalized so surrogate
// ids and write timestamps drop out. The differential test and the daily
// shadow compare both use it, with a clean full rebuild as the oracle.
import type { TrajectoryDB } from '../db.js';

export type WmTable = 'wm_files' | 'wm_symbols' | 'wm_edges';

export const WM_TABLES: readonly WmTable[] = ['wm_files', 'wm_symbols', 'wm_edges'];

// Columns left out of the comparison: surrogate ids and write timestamps.
// wm_edges.src_id and dst_id are compared through the path, kind and name of
// the symbols they point at.
const DROPPED_COLUMNS: Readonly<Record<WmTable, readonly string[]>> = {
  wm_files: ['id', 'updated_at'],
  wm_symbols: ['id'],
  wm_edges: ['src_id', 'dst_id'],
};

const MISMATCH_LISTING_CAP = 20;

export type Snapshot = Record<WmTable, string[]>;

export interface Mismatch {
  table: WmTable;
  onlyA: string[];
  onlyB: string[];
}

export function compared(db: TrajectoryDB, table: WmTable): string[] {
  const dropped = new Set(DROPPED_COLUMNS[table]);
  return db
    .all<{ name: string }>(`SELECT name FROM pragma_table_info(?) ORDER BY cid`, [table])
    .map((c) => c.name)
    .filter((c) => !dropped.has(c));
}

export function normalizedRows(db: TrajectoryDB, repo: string, table: WmTable): string[] {
  const cols = compared(db, table);
  if (table === 'wm_edges') {
    const sql = `SELECT ${cols.map((c) => `e.${c}`).join(', ')},
                        s.path AS src_path, s.kind AS src_kind, s.qualified_name AS src_name,
                        d.path AS dst_path, d.kind AS dst_kind, d.qualified_name AS dst_qualified_name,
                        (e.dst_id IS NOT NULL AND d.id IS NULL) AS dst_dangling
                   FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id LEFT JOIN wm_symbols d ON d.id = e.dst_id
                  WHERE s.repo = ?`;
    return db.all<Record<string, unknown>>(sql, [repo]).map((r) => JSON.stringify(r)).sort();
  }
  return db
    .all<Record<string, unknown>>(`SELECT ${cols.join(', ')} FROM ${table} WHERE repo = ?`, [repo])
    .map((r) => JSON.stringify(r))
    .sort();
}

export function snapshot(db: TrajectoryDB, repo: string): Snapshot {
  return {
    wm_files: normalizedRows(db, repo, 'wm_files'),
    wm_symbols: normalizedRows(db, repo, 'wm_symbols'),
    wm_edges: normalizedRows(db, repo, 'wm_edges'),
  };
}

export function multisetMinus(xs: string[], ys: string[]): string[] {
  const left = new Map<string, number>();
  for (const y of ys) left.set(y, (left.get(y) ?? 0) + 1);
  const out: string[] = [];
  for (const x of xs) {
    const n = left.get(x) ?? 0;
    if (n > 0) left.set(x, n - 1);
    else out.push(x);
  }
  return out;
}

export function compare(a: Snapshot, b: Snapshot): Mismatch[] {
  return WM_TABLES.map((table) => ({ table, onlyA: multisetMinus(a[table], b[table]), onlyB: multisetMinus(b[table], a[table]) })).filter(
    (m) => m.onlyA.length > 0 || m.onlyB.length > 0,
  );
}

function listing(rows: string[]): string {
  const shown = rows.slice(0, MISMATCH_LISTING_CAP).map((r) => `    ${r}`);
  if (rows.length > MISMATCH_LISTING_CAP) shown.push(`    … ${rows.length - MISMATCH_LISTING_CAP} more`);
  return shown.join('\n');
}

export function describeMismatch(label: string, mismatches: Mismatch[]): string {
  const parts = mismatches.map(
    (m) => `${m.table}: ${m.onlyA.length} only in A (incremental), ${m.onlyB.length} only in B (clean rebuild)\n` +
      `  only in A:\n${listing(m.onlyA)}\n  only in B:\n${listing(m.onlyB)}`,
  );
  return `${label}: incremental index differs from the clean rebuild\n${parts.join('\n')}`;
}
