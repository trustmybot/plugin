import { normalizeAgent } from '../middleware/agent-scope.js';
export const NEEDS_REVIEW_LIMIT = 20;
// The needs_review keys for a response covering `repos`: none when nothing
// is flagged. Each list holds at most NEEDS_REVIEW_LIMIT entries, concepts by
// id and READMEs by repo and path; needs_review_truncated gives both totals
// when either list is cut.
export function needsReview(db, repos, agent) {
    if (repos.length === 0)
        return {};
    const scope = JSON.stringify(repos);
    return db.transaction(() => {
        const concepts = db
            .all(`SELECT id, name, status, status_reason FROM wm_concepts
          WHERE repo IN (SELECT value FROM json_each(?)) AND status IN ('suspect','broken')
          ORDER BY id LIMIT ?`, [scope, NEEDS_REVIEW_LIMIT])
            .map((c) => ({ id: Number(c.id), name: c.name, status: c.status, status_reason: c.status_reason ?? null }));
        const pending = db.all(`SELECT id, repo, path FROM wm_directories
        WHERE repo IN (SELECT value FROM json_each(?)) AND readme_review_pending = 1
        ORDER BY repo, path LIMIT ?`, [scope, NEEDS_REVIEW_LIMIT]);
        if (concepts.length === 0 && pending.length === 0)
            return {};
        const conceptTotal = concepts.length < NEEDS_REVIEW_LIMIT
            ? concepts.length
            : Number(db.get(`SELECT COUNT(*) AS n FROM wm_concepts
                WHERE repo IN (SELECT value FROM json_each(?)) AND status IN ('suspect','broken')`, [scope])?.n ?? concepts.length);
        const readmeTotal = pending.length < NEEDS_REVIEW_LIMIT
            ? pending.length
            : Number(db.get(`SELECT COUNT(*) AS n FROM wm_directories
                WHERE repo IN (SELECT value FROM json_each(?)) AND readme_review_pending = 1`, [scope])?.n ?? pending.length);
        if (pending.length > 0 && normalizeAgent(agent) === 'bro') {
            db.run(`UPDATE wm_directories SET readme_review_pending = 0 WHERE id IN (SELECT value FROM json_each(?))`, [
                JSON.stringify(pending.map((d) => Number(d.id))),
            ]);
        }
        const truncated = conceptTotal > concepts.length || readmeTotal > pending.length;
        return {
            needs_review: { concepts, readmes: pending.map((d) => ({ repo: d.repo, path: d.path })) },
            ...(truncated ? { needs_review_truncated: { concepts: conceptTotal, readmes: readmeTotal } } : {}),
        };
    });
}
//# sourceMappingURL=needs-review.js.map