import type { TrajectoryDB } from '../db.js';
import { auditEmbedText, embedAndStore, type EmbeddableTable } from './store.js';
import { serverLog } from '../logger.js';

const MISSING_SQL: Record<EmbeddableTable, string> = {
  discussions:
    'SELECT id, body AS text FROM discussions WHERE id NOT IN (SELECT discussion_id FROM discussions_embeddings) ORDER BY id DESC LIMIT ?',
  audit:
    'SELECT id, summary AS text, content_json FROM audit WHERE id NOT IN (SELECT audit_id FROM audit_embeddings) ORDER BY id DESC LIMIT ?',
};

/**
 * Embeds up to `limit` rows of `table` that have no embeddings row (newest
 * first; a negative limit means no cap). Shared by boot-time `startBackfill`
 * and the lazy tick in audit_search / discussion_search. A failed embed is
 * logged and skipped, never thrown. Returns the number of rows attempted.
 */
export async function backfillMissing(
  db: TrajectoryDB,
  table: EmbeddableTable,
  limit = 50,
  onRow?: () => void,
): Promise<number> {
  const rows = db.all<{ id: number; text: string; content_json?: string | null }>(MISSING_SQL[table], [limit]);
  for (const r of rows) {
    const text = table === 'audit' ? auditEmbedText(r.text, r.content_json ?? null) : r.text;
    await embedAndStore(db, table, r.id, text).catch((e) =>
      console.error(`[embeddings] backfill ${table} #${r.id} failed:`, e),
    );
    onRow?.();
  }
  return rows.length;
}

export async function startBackfill(db: TrajectoryDB): Promise<void> {
  const counts = db.get<{
    discussions: number;
    audit: number;
  }>(
    `SELECT
      (SELECT COUNT(*) FROM discussions WHERE id NOT IN (SELECT discussion_id FROM discussions_embeddings)) AS discussions,
      (SELECT COUNT(*) FROM audit WHERE id NOT IN (SELECT audit_id FROM audit_embeddings)) AS audit`,
  );
  if (!counts) return;
  const total = counts.discussions + counts.audit;

  serverLog({ event: 'embeddings_backfill_start', total });

  if (total === 0) return;

  (async () => {
    let done = 0;
    const progress = () => {
      done++;
      if (done % 50 === 0) serverLog({ event: 'embeddings_backfill_progress', done, total });
    };
    await backfillMissing(db, 'discussions', -1, progress);
    await backfillMissing(db, 'audit', -1, progress);
    serverLog({ event: 'embeddings_backfill_complete', done });
  })().catch((e) => console.error('[embeddings] backfill error:', e));
}
