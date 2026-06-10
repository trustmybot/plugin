import { embedAndStore } from './store.js';
import { serverLog } from '../logger.js';
export async function startBackfill(db) {
    const counts = db.get(`SELECT
      (SELECT COUNT(*) FROM discussions WHERE id NOT IN (SELECT discussion_id FROM discussions_embeddings)) AS discussions,
      (SELECT COUNT(*) FROM audit WHERE id NOT IN (SELECT audit_id FROM audit_embeddings)) AS audit`);
    if (!counts)
        return;
    const total = counts.discussions + counts.audit;
    serverLog({ event: 'embeddings_backfill_start', total });
    if (total === 0)
        return;
    (async () => {
        let done = 0;
        const dRows = db.all('SELECT id, body FROM discussions WHERE id NOT IN (SELECT discussion_id FROM discussions_embeddings)');
        for (const r of dRows) {
            await embedAndStore(db, 'discussions', r.id, r.body);
            done++;
            if (done % 50 === 0)
                serverLog({ event: 'embeddings_backfill_progress', done, total });
        }
        const aRows = db.all('SELECT id, summary, content_json FROM audit WHERE id NOT IN (SELECT audit_id FROM audit_embeddings)');
        for (const r of aRows) {
            const text = r.content_json ? `${r.summary} ${r.content_json}` : r.summary;
            await embedAndStore(db, 'audit', r.id, text);
            done++;
            if (done % 50 === 0)
                serverLog({ event: 'embeddings_backfill_progress', done, total });
        }
        serverLog({ event: 'embeddings_backfill_complete', done });
    })().catch((e) => console.error('[embeddings] backfill error:', e));
}
//# sourceMappingURL=backfill.js.map