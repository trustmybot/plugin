import { utimesSync } from 'node:fs';
import { releaseLock, takeLock } from '../hooks/ensure-mcp-deps-installed.js';
import { auditEmbedText, embedAndStore, worldModelEmbedText, } from './store.js';
import { MODEL_ID } from './model.js';
import { serverLog } from '../logger.js';
const MISSING_WHERE = {
    discussions: 'id NOT IN (SELECT discussion_id FROM discussions_embeddings WHERE model_id = ?)',
    audit: 'id NOT IN (SELECT audit_id FROM audit_embeddings WHERE model_id = ?)',
    wm_directories: 'id NOT IN (SELECT dir_id FROM wm_directories_embeddings WHERE model_id = ?)',
    wm_files: "purpose <> '' AND id NOT IN (SELECT file_id FROM wm_files_embeddings WHERE model_id = ?)",
};
const MISSING_SQL = {
    discussions: `SELECT id, body AS text FROM discussions WHERE ${MISSING_WHERE.discussions} ORDER BY id DESC LIMIT ?`,
    audit: `SELECT id, summary AS text, content_json FROM audit WHERE ${MISSING_WHERE.audit} ORDER BY id DESC LIMIT ?`,
    wm_directories: `SELECT id, CASE WHEN path = '' THEN repo ELSE path END AS text, summary AS body FROM wm_directories WHERE ${MISSING_WHERE.wm_directories} ORDER BY id DESC LIMIT ?`,
    wm_files: `SELECT id, path AS text, purpose AS body FROM wm_files WHERE ${MISSING_WHERE.wm_files} ORDER BY id DESC LIMIT ?`,
};
const RECHECK_BATCH = 50;
/** A boot backfill lease whose lock dir mtime is older than this is taken over. */
export const BACKFILL_LEASE_STALE_MIN = 5;
/** How often the lease holder refreshes the lock dir's mtime. */
export const BACKFILL_HEARTBEAT_MS = 60_000;
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
    return db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${MISSING_WHERE[table]}`, [MODEL_ID])?.n ?? 0;
}
/**
 * Embeds up to `limit` rows of `table` that have no embeddings row under the
 * current MODEL_ID (newest first; a negative limit means no cap). A row
 * embedded under an older model id counts as missing and is overwritten.
 * Shared by boot-time `startBackfill` and the lazy tick in audit_search /
 * discussion_search / world_model_search.
 * Before each batch of 50 the rows another connection embedded meanwhile are
 * dropped. A failed embed is logged and skipped, never thrown or retried.
 * Returns the number of rows attempted.
 */
export async function backfillMissing(db, table, limit = 50, onRow) {
    const rows = db.all(MISSING_SQL[table], [MODEL_ID, limit]);
    let attempted = 0;
    for (let i = 0; i < rows.length; i += RECHECK_BATCH) {
        if (!db.isOpen)
            break;
        const batch = rows.slice(i, i + RECHECK_BATCH);
        const ids = batch.map((r) => r.id);
        const stillMissing = new Set(db
            .all(`SELECT id FROM ${table} WHERE ${MISSING_WHERE[table]} AND id IN (${ids.map(() => '?').join(', ')})`, [MODEL_ID, ...ids])
            .map((r) => r.id));
        for (const r of batch) {
            if (!stillMissing.has(r.id))
                continue;
            attempted++;
            await embedAndStore(db, table, r.id, embedText(table, r)).catch((e) => console.error(`[embeddings] backfill ${table} #${r.id} failed:`, e));
            onRow?.();
        }
    }
    return attempted;
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
function heartbeat(lock) {
    try {
        const now = new Date();
        utimesSync(lock, now, now);
    }
    catch (e) {
        console.error('[embeddings] backfill lease heartbeat failed:', e);
    }
}
/**
 * Embeds every row missing a vector, once per DB: a file DB's run holds the
 * lease `<dbPath>.backfill.lock`, refreshed every `heartbeatMs`, and a boot
 * that finds it held skips. An in-memory DB runs with no lease. Resolves when
 * the run ends or is skipped.
 */
export async function startBackfill(db, dbPath, opts = {}) {
    const missing = BACKFILL_ORDER.map((table) => ({ table, n: countMissing(db, table) }));
    const total = missing.reduce((sum, m) => sum + m.n, 0);
    if (total === 0) {
        serverLog({ event: 'embeddings_backfill_start', total });
        return;
    }
    const lock = dbPath && dbPath !== ':memory:' ? `${dbPath}.backfill.lock` : undefined;
    const token = lock ? takeLock(lock, BACKFILL_LEASE_STALE_MIN) : undefined;
    if (lock && !token) {
        serverLog({ event: 'embeddings_backfill_skipped', reason: 'lease_held', total });
        return;
    }
    serverLog({ event: 'embeddings_backfill_start', total });
    const timer = lock ? setInterval(() => heartbeat(lock), opts.heartbeatMs ?? BACKFILL_HEARTBEAT_MS) : undefined;
    timer?.unref();
    try {
        let done = 0;
        const progress = () => {
            done++;
            if (done % 50 === 0)
                serverLog({ event: 'embeddings_backfill_progress', done, total });
        };
        for (const { table } of missing)
            await backfillMissing(db, table, -1, progress);
        serverLog({ event: 'embeddings_backfill_complete', done });
    }
    catch (e) {
        console.error('[embeddings] backfill error:', e);
    }
    finally {
        clearInterval(timer);
        if (lock)
            releaseLock(lock, token);
    }
}
//# sourceMappingURL=backfill.js.map