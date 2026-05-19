import type { TrajectoryDB } from '../db.js';
import { embedAndStore } from './store.js';

export async function startBackfill(db: TrajectoryDB): Promise<void> {
  const counts = db.get<{ discussions: number; audit: number; file_registry: number }>(
    `SELECT
      (SELECT COUNT(*) FROM discussions WHERE id NOT IN (SELECT discussion_id FROM discussions_embeddings)) AS discussions,
      (SELECT COUNT(*) FROM audit WHERE id NOT IN (SELECT audit_id FROM audit_embeddings)) AS audit,
      (SELECT COUNT(*) FROM file_registry WHERE summary IS NOT NULL AND rowid NOT IN (SELECT file_registry_id FROM file_registry_embeddings)) AS file_registry`,
  );
  if (!counts) return;
  const total = counts.discussions + counts.audit + counts.file_registry;
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
    const fRows = db.all<{ rowid: number; summary: string }>(
      'SELECT rowid, summary FROM file_registry WHERE summary IS NOT NULL AND rowid NOT IN (SELECT file_registry_id FROM file_registry_embeddings)',
    );
    for (const r of fRows) {
      await embedAndStore(db, 'file_registry', r.rowid, r.summary);
      done++;
      if (done % 50 === 0) console.log(`[embeddings] backfill ${done}/${total}`);
    }
    console.log(`[embeddings] backfill complete: ${done} rows`);
  })().catch((e) => console.error('[embeddings] backfill error:', e));
}
