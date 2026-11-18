import { serverLog } from '../logger.js';
import { insertAudit } from '../tools/audit.js';
import { embeddingStatus, onEmbeddingTransition } from './model.js';
/** created_at of the latest `embeddings_degraded` row with no later `embeddings_recovered` row, or null. */
function openDegradedSince(db) {
    return (db.get(`SELECT d.created_at FROM audit d
        WHERE d.event_type = 'embeddings_degraded'
          AND NOT EXISTS (SELECT 1 FROM audit r WHERE r.event_type = 'embeddings_recovered' AND r.id > d.id)
        ORDER BY d.id DESC LIMIT 1`)?.created_at ?? null);
}
/**
 * Records every degraded / recovered transition of the embedding model: one
 * `embeddings_degraded` or `embeddings_recovered` audit row on the system issue
 * `-1`, and one `embeddings_state` line in mcp-server.log carrying
 * `embeddingStatus()`. A `ready` model closes a degraded episode an earlier
 * process left open with one `embeddings_recovered` row (reason
 * `process_start`); with no open episode it writes nothing. Returns the
 * unsubscribe.
 */
export function recordEmbeddingTransitions(db) {
    return onEmbeddingTransition((t) => {
        serverLog({ kind: 'embeddings_state', transition: t.kind, embeddings: embeddingStatus() });
        if (!db.isOpen)
            return;
        if (t.kind === 'ready') {
            const since = openDegradedSince(db);
            if (since === null)
                return;
            insertAudit(db, {
                issue_id: -1,
                from_node: 'trajectory-server',
                event_type: 'embeddings_recovered',
                summary: `embeddings ready at process start — closes the degraded episode open since ${since}`,
                content_json: JSON.stringify({ degraded_since: since, reason: 'process_start', retries: 0 }),
            });
        }
        else if (t.kind === 'degraded') {
            insertAudit(db, {
                issue_id: -1,
                from_node: 'trajectory-server',
                event_type: 'embeddings_degraded',
                summary: `embeddings degraded — semantic search falls back to FTS: ${t.reason}`,
                content_json: JSON.stringify({ reason: t.reason, consecutive_failures: t.consecutive_failures }),
            });
        }
        else {
            insertAudit(db, {
                issue_id: -1,
                from_node: 'trajectory-server',
                event_type: 'embeddings_recovered',
                summary: `embeddings recovered after ${t.retries} re-attempt(s)`,
                content_json: JSON.stringify({ degraded_since: t.degraded_since, reason: t.reason, retries: t.retries }),
            });
        }
    });
}
//# sourceMappingURL=health.js.map