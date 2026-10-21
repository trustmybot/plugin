import { auditEmbedText, embedAndStore, worldModelEmbedText, } from './store.js';
import { serverLog } from '../logger.js';
const MISSING_WHERE = {
    discussions: 'id NOT IN (SELECT discussion_id FROM discussions_embeddings)',
    audit: 'id NOT IN (SELECT audit_id FROM audit_embeddings)',
    wm_directories: 'id NOT IN (SELECT dir_id FROM wm_directories_embeddings)',
    wm_files: "purpose <> '' AND id NOT IN (SELECT file_id FROM wm_files_embeddings)",
};
const MISSING_SQL = {
    discussions: `SELECT id, body AS text FROM discussions WHERE ${MISSING_WHERE.discussions} ORDER BY id DESC LIMIT ?`,
    audit: `SELECT id, summary AS text, content_json FROM audit WHERE ${MISSING_WHERE.audit} ORDER BY id DESC LIMIT ?`,
    wm_directories: `SELECT id, CASE WHEN path = '' THEN repo ELSE path END AS text, summary AS body FROM wm_directories WHERE ${MISSING_WHERE.wm_directories} ORDER BY id DESC LIMIT ?`,
    wm_files: `SELECT id, path AS text, purpose AS body FROM wm_files WHERE ${MISSING_WHERE.wm_files} ORDER BY id DESC LIMIT ?`,
};
const BACKFILL_ORDER = ['discussions', 'audit', 'wm_directories', 'wm_files'];
export const WORLD_MODEL_TABLES = ['wm_directories', 'wm_files'];
function embedText(table, r) {
    if (table === 'audit')
        return auditEmbedText(r.text, r.content_json ?? null);
    if (table === 'wm_directories' || table === 'wm_files')
        return worldModelEmbedText(r.text, r.body ?? null);
    return r.text;
}
export function countMissing(db, table) {
    return db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${MISSING_WHERE[table]}`)?.n ?? 0;
}
/**
 * Embeds up to `limit` rows of `table` that have no embeddings row (newest
 * first; a negative limit means no cap). Shared by boot-time `startBackfill`
 * and the lazy tick in audit_search / discussion_search / world_model_search.
 * A failed embed is logged and skipped, never thrown. Returns the number of
 * rows attempted.
 */
export async function backfillMissing(db, table, limit = 50, onRow) {
    const rows = db.all(MISSING_SQL[table], [limit]);
    for (const r of rows) {
        await embedAndStore(db, table, r.id, embedText(table, r)).catch((e) => console.error(`[embeddings] backfill ${table} #${r.id} failed:`, e));
        onRow?.();
    }
    return rows.length;
}
let worldModelBackfill = null;
/**
 * Embeds every world-model row still missing a vector, in the background. A
 * scan can add thousands of rows after the boot backfill ran; one call at a
 * time, later calls while it runs are no-ops.
 */
export function startWorldModelBackfill(db) {
    if (worldModelBackfill)
        return;
    worldModelBackfill = (async () => {
        for (const table of WORLD_MODEL_TABLES) {
            if (!db.isOpen)
                return;
            await backfillMissing(db, table, -1);
        }
    })()
        .catch((e) => console.error('[embeddings] world-model backfill error:', e))
        .finally(() => {
        worldModelBackfill = null;
    });
}
export async function startBackfill(db) {
    const missing = BACKFILL_ORDER.map((table) => ({ table, n: countMissing(db, table) }));
    const total = missing.reduce((sum, m) => sum + m.n, 0);
    serverLog({ event: 'embeddings_backfill_start', total });
    if (total === 0)
        return;
    (async () => {
        let done = 0;
        const progress = () => {
            done++;
            if (done % 50 === 0)
                serverLog({ event: 'embeddings_backfill_progress', done, total });
        };
        for (const { table } of missing)
            await backfillMissing(db, table, -1, progress);
        serverLog({ event: 'embeddings_backfill_complete', done });
    })().catch((e) => console.error('[embeddings] backfill error:', e));
}
//# sourceMappingURL=backfill.js.map