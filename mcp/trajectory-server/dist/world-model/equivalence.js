export const WM_TABLES = ['wm_files', 'wm_symbols', 'wm_edges'];
// Columns left out of the comparison: surrogate ids and write timestamps.
// wm_edges.src_id and dst_id are compared through the path, kind and name of
// the symbols they point at.
const DROPPED_COLUMNS = {
    wm_files: ['id', 'updated_at'],
    wm_symbols: ['id'],
    wm_edges: ['src_id', 'dst_id'],
};
const MISMATCH_LISTING_CAP = 20;
export function compared(db, table) {
    const dropped = new Set(DROPPED_COLUMNS[table]);
    return db
        .all(`SELECT name FROM pragma_table_info(?) ORDER BY cid`, [table])
        .map((c) => c.name)
        .filter((c) => !dropped.has(c));
}
export function normalizedRows(db, repo, table) {
    const cols = compared(db, table);
    if (table === 'wm_edges') {
        const sql = `SELECT ${cols.map((c) => `e.${c}`).join(', ')},
                        s.path AS src_path, s.kind AS src_kind, s.qualified_name AS src_name,
                        d.path AS dst_path, d.kind AS dst_kind, d.qualified_name AS dst_qualified_name,
                        (e.dst_id IS NOT NULL AND d.id IS NULL) AS dst_dangling
                   FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id LEFT JOIN wm_symbols d ON d.id = e.dst_id
                  WHERE s.repo = ?`;
        return db.all(sql, [repo]).map((r) => JSON.stringify(r)).sort();
    }
    return db
        .all(`SELECT ${cols.join(', ')} FROM ${table} WHERE repo = ?`, [repo])
        .map((r) => JSON.stringify(r))
        .sort();
}
export function snapshot(db, repo) {
    return {
        wm_files: normalizedRows(db, repo, 'wm_files'),
        wm_symbols: normalizedRows(db, repo, 'wm_symbols'),
        wm_edges: normalizedRows(db, repo, 'wm_edges'),
    };
}
export function multisetMinus(xs, ys) {
    const left = new Map();
    for (const y of ys)
        left.set(y, (left.get(y) ?? 0) + 1);
    const out = [];
    for (const x of xs) {
        const n = left.get(x) ?? 0;
        if (n > 0)
            left.set(x, n - 1);
        else
            out.push(x);
    }
    return out;
}
export function compare(a, b) {
    return WM_TABLES.map((table) => ({ table, onlyA: multisetMinus(a[table], b[table]), onlyB: multisetMinus(b[table], a[table]) })).filter((m) => m.onlyA.length > 0 || m.onlyB.length > 0);
}
function listing(rows) {
    const shown = rows.slice(0, MISMATCH_LISTING_CAP).map((r) => `    ${r}`);
    if (rows.length > MISMATCH_LISTING_CAP)
        shown.push(`    … ${rows.length - MISMATCH_LISTING_CAP} more`);
    return shown.join('\n');
}
export function describeMismatch(label, mismatches) {
    const parts = mismatches.map((m) => `${m.table}: ${m.onlyA.length} only in A (incremental), ${m.onlyB.length} only in B (clean rebuild)\n` +
        `  only in A:\n${listing(m.onlyA)}\n  only in B:\n${listing(m.onlyB)}`);
    return `${label}: incremental index differs from the clean rebuild\n${parts.join('\n')}`;
}
//# sourceMappingURL=equivalence.js.map