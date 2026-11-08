// Pre-seed the state that step 08 (10-architectural-change) would have
// produced organically in L6 chain mode: a kind='decision' discussion
// recording why the storage layer was extracted into a backend interface,
// plus a corresponding discussions_embeddings row with a deterministic
// stub vector (zero bytes) so keyword + cosine search both return the
// row without a real ONNX model call.
//
// In L6, setup-l5.ts is NOT run — step 08's bro turn produces the
// decision discussion organically; the after-10-architectural-change.sql
// seed bridges any post-AUQ gap; the backfill step on server startup
// would normally populate embeddings. The stub vector here ensures L5
// isolation gets a hit regardless of whether the embedding model is
// available in the test environment.
import { setupArgs, withDb } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);

withDb(project, (db) => {
  // Ensure an issue exists to attach the discussion to.
  const first = db.prepare('SELECT id FROM issues ORDER BY id LIMIT 1').get();
  const issueId =
    first?.id ??
    db
      .prepare(
        `INSERT INTO issues (objective, description, status, created_at, updated_at)
VALUES (
  'Extract storage layer into backend interface',
  'Refactor src/cli.py JSON storage into a pluggable backend interface so SQLite can be swapped in later.',
  'closed',
  datetime('now', '-2 hours'),
  datetime('now', '-2 hours')
)`,
      )
      .run().lastInsertRowid;

  // Insert the kind='decision' discussion mirroring step 08's decision body.
  const discussionId = db
    .prepare(
      `INSERT INTO discussions (issue_id, author, kind, body, created_at)
VALUES (
  ?,
  'bro',
  'decision',
  'Decision: extract storage into a backend interface (StorageBackend ABC) with a JsonFileBackend default implementation. Factory function selects backend at runtime. Rationale: (1) decouples command handlers from persistence detail; (2) makes SQLite swap-in a targeted change; (3) preserves back-compat for existing ~/.todo-cli/todos.json files via JsonFileBackend.',
  datetime('now', '-1 hour')
)`,
    )
    .run(issueId).lastInsertRowid;

  // Seed a stub embedding for the decision row so discussion_search returns it
  // deterministically without a real ONNX call. zeroblob(1536*4) = 6144 zero
  // bytes = 1536-dim float32 zero vector. Cosine of zero vector is undefined
  // (div-by-zero), so the server's topKByCosine will return score=NaN/0 for
  // this row. The FTS5 keyword path and hybrid path will still find it via
  // BM25. The outcome assertion only checks row existence, not search score.
  db.prepare(
    `INSERT OR REPLACE INTO discussions_embeddings (discussion_id, embedding, model_id, embedded_at)
VALUES (?, zeroblob(6144), 'stub-zero-v0', datetime('now', '-55 minutes'))`,
  ).run(discussionId);
});
