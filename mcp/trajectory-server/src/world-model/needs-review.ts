// needs_review (GH 2584, decision 2474 item 4): what the meaning layer asks
// bro to look at, carried by every world_model_get, world_model_search and
// world_model_symbol answer that has any. Two kinds, with two lifetimes:
//   - concepts whose status is suspect or broken, listed for as long as they
//     stay flagged (refreshConcepts sets the status, a re-verify, rewrite or
//     retire through world_model_concept_upsert clears it);
//   - dirs whose README-sourced summary a reindex changed
//     (wm_directories.readme_review_pending), listed until a response delivers
//     them to bro, which clears the rows it lists in one write. Reads by any
//     other agent list them and clear nothing.
import type { TrajectoryDB } from '../db.js';
import { normalizeAgent } from '../middleware/agent-scope.js';

export const NEEDS_REVIEW_LIMIT = 20;

export interface ReviewConcept {
  id: number;
  name: string;
  status: string;
  status_reason: string | null;
}

export interface ReviewReadme {
  repo: string;
  path: string;
}

export interface NeedsReview {
  needs_review?: { concepts: ReviewConcept[]; readmes: ReviewReadme[] };
  needs_review_truncated?: { concepts: number; readmes: number };
}

// The needs_review keys for a response covering `repos`: none when nothing
// is flagged. Each list holds at most NEEDS_REVIEW_LIMIT entries, concepts by
// id and READMEs by repo and path; needs_review_truncated gives both totals
// when either list is cut.
export function needsReview(db: TrajectoryDB, repos: readonly string[], agent: unknown): NeedsReview {
  if (repos.length === 0) return {};
  const scope = JSON.stringify(repos);
  return db.transaction(() => {
    const concepts = db
      .all<ReviewConcept>(
        `SELECT id, name, status, status_reason FROM wm_concepts
          WHERE repo IN (SELECT value FROM json_each(?)) AND status IN ('suspect','broken')
          ORDER BY id LIMIT ?`,
        [scope, NEEDS_REVIEW_LIMIT],
      )
      .map((c) => ({ id: Number(c.id), name: c.name, status: c.status, status_reason: c.status_reason ?? null }));
    const pending = db.all<{ id: number; repo: string; path: string }>(
      `SELECT id, repo, path FROM wm_directories
        WHERE repo IN (SELECT value FROM json_each(?)) AND readme_review_pending = 1
        ORDER BY repo, path LIMIT ?`,
      [scope, NEEDS_REVIEW_LIMIT],
    );
    if (concepts.length === 0 && pending.length === 0) return {};
    const conceptTotal =
      concepts.length < NEEDS_REVIEW_LIMIT
        ? concepts.length
        : Number(
            db.get<{ n: number }>(
              `SELECT COUNT(*) AS n FROM wm_concepts
                WHERE repo IN (SELECT value FROM json_each(?)) AND status IN ('suspect','broken')`,
              [scope],
            )?.n ?? concepts.length,
          );
    const readmeTotal =
      pending.length < NEEDS_REVIEW_LIMIT
        ? pending.length
        : Number(
            db.get<{ n: number }>(
              `SELECT COUNT(*) AS n FROM wm_directories
                WHERE repo IN (SELECT value FROM json_each(?)) AND readme_review_pending = 1`,
              [scope],
            )?.n ?? pending.length,
          );
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
