const STOPWORDS = new Set([
    'a', 'about', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'has',
    'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'our', 'that', 'the',
    'their', 'there', 'these', 'this', 'those', 'to', 'was', 'we', 'were', 'what', 'when', 'where',
    'which', 'who', 'why', 'will', 'with', 'you', 'your',
]);
function queryTokens(raw) {
    return Array.from(raw.matchAll(/"([^"]*)"|\S+/g), (m) => (m[1] ?? m[0].replace(/^"+|"+$/g, '')).trim()).filter((token) => token.length > 0);
}
function quoted(token) {
    return `"${token.replace(/"/g, '""')}"`;
}
export function toFtsQuery(raw) {
    const tokens = queryTokens(raw).map(quoted);
    return tokens.length > 0 ? tokens.join(' ') : '""';
}
// The any-term fallback for a sentence whose all-terms query matched nothing:
// the same tokens minus English stopwords, ORed. null when no token is left.
export function toFtsOrQuery(raw) {
    const terms = orTerms(raw);
    return terms.length > 0 ? terms.join(' OR ') : null;
}
// The distinct quoted terms toFtsOrQuery ORs together.
export function toFtsOrTerms(raw) {
    return [...new Set(orTerms(raw))];
}
function orTerms(raw) {
    return queryTokens(raw)
        .filter((token) => {
        const word = token.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        return word.length > 0 && !STOPWORDS.has(word);
    })
        .map(quoted);
}
const ANY_TERM_POOL_FACTOR = 4;
const ANY_TERM_POOL_CAP = 200;
// How many OR rows to fetch before reordering by matched-term count, so a
// multi-term row bm25 alone would rank past k still makes the cut.
export function anyTermPoolSize(k) {
    return Math.max(k, Math.min(k * ANY_TERM_POOL_FACTOR, ANY_TERM_POOL_CAP));
}
// Reorders any-term rows so those matching more distinct terms come first;
// the sort is stable, so ties keep the caller's bm25 order. FTS5 itself
// decides each match (one MATCH per term over the pool's rowids), because the
// wm_*_fts tables stem with porter and a JS tokenizer would disagree.
export function orderByMatchedTerms(db, ftsTable, terms, rows) {
    if (rows.length < 2 || terms.length < 2)
        return rows;
    const ids = rows.map((r) => Number(r.id));
    const marks = ids.map(() => '?').join(', ');
    const matched = new Map();
    for (const term of terms) {
        const hits = db.all(`SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH ? AND rowid IN (${marks})`, [term, ...ids]);
        for (const h of hits)
            matched.set(Number(h.rowid), (matched.get(Number(h.rowid)) ?? 0) + 1);
    }
    const count = (r) => matched.get(Number(r.id)) ?? 0;
    return [...rows].sort((a, b) => count(b) - count(a));
}
export function withFtsGuard(run) {
    try {
        return run();
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (/fts5|no such column/i.test(message)) {
            throw new Error(`fts_query_invalid: ${message}`);
        }
        throw e;
    }
}
//# sourceMappingURL=fts-query.js.map