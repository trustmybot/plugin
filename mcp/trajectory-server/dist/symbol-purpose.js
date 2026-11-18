// The `symbols` purpose post-pass (GH 1843): after indexRepoSymbols, each
// wm_files row with no header purpose (purpose_source 'none' or 'symbols') gets
// the purpose purposeFromSymbols builds from its wm_symbols rows. A row is
// written only when its text changes, so an unchanged file keeps its purpose
// byte for byte, and a header or an swe purpose is never touched.
import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { nowISO } from './db.js';
import { needsHeadForSymbols, PURPOSE_HEAD_BYTES, purposeFromSymbols } from './file-purpose.js';
export function readFileHead(absPath) {
    let fd = null;
    try {
        fd = openSync(absPath, 'r');
        const buf = Buffer.alloc(PURPOSE_HEAD_BYTES);
        const n = readSync(fd, buf, 0, PURPOSE_HEAD_BYTES, 0);
        return buf.subarray(0, n).toString('utf8');
    }
    catch {
        return '';
    }
    finally {
        if (fd !== null)
            closeSync(fd);
    }
}
function candidates(db, repo, paths) {
    const files = db.all(`SELECT id, path, purpose, purpose_source FROM wm_files
      WHERE repo = ? AND purpose_source IN ('none', 'symbols') ORDER BY path`, [repo]);
    return paths ? files.filter((f) => paths.has(f.path)) : files;
}
export function purposeHeadPaths(db, repo, paths) {
    return candidates(db, repo, paths)
        .map((f) => f.path)
        .filter(needsHeadForSymbols);
}
// purposeHeadPaths over the given wm_files rows instead of the stored ones,
// for a caller whose file writes have not run yet.
export function purposeHeadPathsOf(files, paths) {
    return files
        .filter((f) => (f.purpose_source === 'none' || f.purpose_source === 'symbols') && (!paths || paths.has(f.path)))
        .map((f) => f.path)
        .sort()
        .filter(needsHeadForSymbols);
}
export function refreshSymbolPurposes(db, repo, opts = {}) {
    const files = candidates(db, repo, opts.paths);
    if (files.length === 0)
        return { updated: 0 };
    const repoPath = db.get(`SELECT path FROM repos WHERE name = ?`, [repo])?.path ?? null;
    const headOf = (path) => opts.heads ? (opts.heads.get(path) ?? '') : repoPath !== null ? readFileHead(join(repoPath, path)) : '';
    const byPath = new Map();
    const rows = db.all(`SELECT path, kind, qualified_name, doc, exported, start_line, end_line FROM wm_symbols
      WHERE repo = ? AND path IN (SELECT value FROM json_each(?))
      ORDER BY path, start_line, id`, [repo, JSON.stringify(files.map((f) => f.path))]);
    for (const r of rows) {
        const symbol = {
            kind: r.kind,
            qualified_name: r.qualified_name,
            doc: r.doc,
            exported: Number(r.exported),
            start_line: r.start_line === null ? null : Number(r.start_line),
            end_line: r.end_line === null ? null : Number(r.end_line),
        };
        const list = byPath.get(r.path);
        if (list)
            list.push(symbol);
        else
            byPath.set(r.path, [symbol]);
    }
    const now = nowISO();
    let updated = 0;
    db.transaction(() => {
        for (const f of files) {
            const head = needsHeadForSymbols(f.path) ? headOf(f.path) : '';
            const next = purposeFromSymbols(f.path, byPath.get(f.path) ?? [], head);
            const purpose = next?.purpose ?? '';
            const source = next ? 'symbols' : 'none';
            if (purpose === f.purpose && source === f.purpose_source)
                continue;
            db.run(`UPDATE wm_files SET purpose = ?, purpose_source = ?, updated_at = ? WHERE id = ?`, [purpose, source, now, f.id]);
            updated++;
        }
    });
    return { updated };
}
//# sourceMappingURL=symbol-purpose.js.map