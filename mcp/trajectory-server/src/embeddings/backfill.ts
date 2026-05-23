import type { TrajectoryDB } from '../db.js';
import { embedAndStore } from './store.js';

export async function startBackfill(db: TrajectoryDB): Promise<void> {
  const counts = db.get<{
    discussions: number;
    audit: number;
    directories: number;
  }>(
    `SELECT
      (SELECT COUNT(*) FROM discussions WHERE id NOT IN (SELECT discussion_id FROM discussions_embeddings)) AS discussions,
      (SELECT COUNT(*) FROM audit WHERE id NOT IN (SELECT audit_id FROM audit_embeddings)) AS audit,
      (SELECT COUNT(*) FROM directories WHERE summary IS NOT NULL AND id NOT IN (SELECT directory_id FROM directories_embeddings)) AS directories`,
  );
  if (!counts) return;
  const total = counts.discussions + counts.audit + counts.directories;
  if (total === 0) return;

  console.log(`[embeddings] backfill starting: ${total} rows pending`);

  (async () => {
    let done = 0;
    const dRows = db.all<{ id: number; body: string }>(
      'SELECT id, body FROM discussions WHERE id NOT IN (SELECT discussion_id FROM discussions_embeddings)',
    );
    for (const r of dRows) {
      await embedAndStore(db, 'discussions', r.id, r.body);
      done++;
      if (done % 50 === 0) console.log(`[embeddings] backfill ${done}/${total}`);
    }
    const aRows = db.all<{ id: number; summary: string; content_json: string | null }>(
      'SELECT id, summary, content_json FROM audit WHERE id NOT IN (SELECT audit_id FROM audit_embeddings)',
    );
    for (const r of aRows) {
      const text = r.content_json ? `${r.summary} ${r.content_json}` : r.summary;
      await embedAndStore(db, 'audit', r.id, text);
      done++;
      if (done % 50 === 0) console.log(`[embeddings] backfill ${done}/${total}`);
    }
    const dRows2 = db.all<{ id: number; summary: string; path: string }>(
      'SELECT id, summary, path FROM directories WHERE summary IS NOT NULL AND id NOT IN (SELECT directory_id FROM directories_embeddings)',
    );
    for (const r of dRows2) {
      // Combine path + summary so semantic queries can match either signal.
      const text = `${r.path}\n${r.summary}`;
      await embedAndStore(db, 'directories', r.id, text);
      done++;
      if (done % 50 === 0) console.log(`[embeddings] backfill ${done}/${total}`);
    }
    console.log(`[embeddings] backfill complete: ${done} rows`);
  })().catch((e) => console.error('[embeddings] backfill error:', e));
}
