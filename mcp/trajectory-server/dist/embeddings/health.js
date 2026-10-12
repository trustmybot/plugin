import { serverLog } from '../logger.js';
import { insertAudit } from '../tools/audit.js';
import { embeddingStatus, onEmbeddingTransition } from './model.js';
/**
 * Records every degraded / recovered transition of the embedding model: one
 * `embeddings_degraded` or `embeddings_recovered` audit row on the system issue
 * `-1`, and one `embeddings_state` line in mcp-server.log carrying
 * `embeddingStatus()`. Returns the unsubscribe.
 */
export function recordEmbeddingTransitions(db) {
    return onEmbeddingTransition((t) => {
        serverLog({ kind: 'embeddings_state', transition: t.kind, embeddings: embeddingStatus() });
        if (!db.isOpen)
            return;
        if (t.kind === 'degraded') {
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