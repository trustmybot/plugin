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
    const tokens = queryTokens(raw).filter((token) => {
        const word = token.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        return word.length > 0 && !STOPWORDS.has(word);
    });
    return tokens.length > 0 ? tokens.map(quoted).join(' OR ') : null;
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