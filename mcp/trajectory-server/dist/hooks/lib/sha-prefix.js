/**
 * SHA matching for gates that compare a stored commit_sha with the full SHAs
 * git hands them: task_update_status and verification runs may store a short
 * SHA (7+ hex), so an equality test on the full SHA never matches it and the
 * gate fails open (GH 3102).
 */
const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
export const MIN_SHA_PREFIX = 7;
/** A `p(sha)` CTE over <shas>, or null when one is not a full lowercase SHA, so no caller quotes unchecked text into SQL. */
export function shaValuesCte(shas) {
    if (shas.length === 0 || shas.some((sha) => !FULL_SHA.test(sha)))
        return null;
    return `p(sha) AS (VALUES ${shas.map((sha) => `('${sha}')`).join(',')})`;
}
/** SQL that holds when the stored SHA column <stored> is a hex prefix, at least MIN_SHA_PREFIX long, of the full SHA expression <full>. */
export function shaPrefixMatchSql(stored, full) {
    return `(length(${stored}) >= ${MIN_SHA_PREFIX} AND lower(${stored}) NOT GLOB '*[^0-9a-f]*' AND substr(${full}, 1, length(${stored})) = lower(${stored}))`;
}
//# sourceMappingURL=sha-prefix.js.map