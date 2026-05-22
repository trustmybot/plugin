// Flow 10 — RAG backfill + embed-on-write
//
// Verifies two embedding paths in the trajectory server:
//
//   1. Embed-on-write: discussion_append / audit_log / file_registry_upsert
//      fire embedAndStore(...) fire-and-forget. After seeding N rows via
//      MCP tools, semantic search must either return results (model loaded)
//      or return graceful warning (model unavailable) — never throw.
//
//   2. Startup backfill: startBackfill() runs when the server starts with
//      pre-existing rows. In the :memory: harness DB, rows are seeded before
//      backfill would touch them (they arrive via MCP calls after startup),
//      so this flow tests the embed-on-write path exclusively. The backfill
//      path is tested indirectly: if embed-on-write produces embeddings,
//      semantic search returns results; if the model is unavailable, the
//      graceful fallback contract (warning: 'semantic_unavailable') is verified.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, call } from '../mcp-integration/harness.mjs';

// ---------------------------------------------------------------------------
// Helper: seed a minimal issue + return its id.
// ---------------------------------------------------------------------------

async function seedIssue(client, objective) {
  const r = await call(client, 'issue_create', {
    agent: 'bro',
    objective: objective ?? 'flow-10 rag backfill fixture',
    description: 'RAG backfill test fixture',
  });
  assert.equal(r.ok, true, `issue_create: ${JSON.stringify(r)}`);
  return r.data.id;
}

// ---------------------------------------------------------------------------
// Flow 10a — Embed-on-write: discussion rows
// ---------------------------------------------------------------------------

test('Flow 10a — embed-on-write: discussion_append triggers embedding attempt; semantic search stable', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const issueId = await seedIssue(client, 'embed-on-write discussions');

  // Insert 5 discussion rows via discussion_append.
  const bodies = [
    'authentication module implemented with JWT tokens',
    'database schema migration for user profiles',
    'deployment pipeline configured with rolling updates',
    'caching layer added with Redis sentinel failover',
    'webhook handler for GitHub push events registered',
  ];

  for (const body of bodies) {
    const r = await call(client, 'discussion_append', {
      agent: 'bro', issue_id: issueId, author: 'bro', kind: 'note', body,
    });
    assert.equal(r.ok, true, `discussion_append: ${JSON.stringify(r)}`);
  }

  // Allow brief time for fire-and-forget embedding tasks to settle.
  // (Model load may or may not succeed in this environment.)
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Verify semantic search returns a valid response for each of the 5 rows.
  // Contract: ok=true, results is array, if empty then warning='semantic_unavailable'.
  for (const [i, query] of [
    [0, 'JWT authentication'],
    [1, 'database migration user'],
    [2, 'deployment rolling update'],
  ].entries()) {
    const res = await call(client, 'discussion_search', {
      agent: 'bro', query, mode: 'semantic',
    });
    assert.equal(res.ok, true, `semantic search ${i}: ${JSON.stringify(res)}`);
    assert.ok(Array.isArray(res.data.results), `results must be array for query "${query}"`);
    if (res.data.results.length === 0) {
      assert.equal(
        res.data.warning,
        'semantic_unavailable',
        `empty semantic results must carry warning (query "${query}"): ${JSON.stringify(res.data)}`,
      );
    } else {
      assert.ok(
        typeof res.data.results[0].id === 'number',
        'each result must have numeric id',
      );
    }
  }

  // Keyword search must always find the rows (model-independent).
  const kwRes = await call(client, 'discussion_search', {
    agent: 'bro', query: 'authentication', mode: 'keyword',
  });
  assert.equal(kwRes.ok, true, JSON.stringify(kwRes));
  assert.equal(kwRes.data.total_matched, 1, 'keyword must find exactly the authentication row');
});

// ---------------------------------------------------------------------------
// Flow 10b — Embed-on-write: audit rows
// ---------------------------------------------------------------------------

test('Flow 10b — embed-on-write: audit_log triggers embedding attempt; semantic search stable', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const issueId = await seedIssue(client, 'embed-on-write audit');

  // Insert 3 audit rows.
  const audits = [
    { event_type: 'planning_complete', summary: 'planning done for authentication module rollout' },
    { event_type: 'swe_complete', summary: 'database migration service implemented and tested' },
    { event_type: 'bro_verification_pass', summary: 'verification passed for webhook handler deployment' },
  ];

  for (const { event_type, summary } of audits) {
    const r = await call(client, 'audit_log', {
      agent: 'bro', issue_id: issueId, from_node: 'bro', event_type, summary,
    });
    assert.equal(r.ok, true, `audit_log ${event_type}: ${JSON.stringify(r)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 200));

  // Semantic search must be stable: either returns results or graceful warning.
  const res = await call(client, 'audit_search', {
    agent: 'bro', query: 'authentication rollout planning', mode: 'semantic',
  });
  assert.equal(res.ok, true, `audit semantic search: ${JSON.stringify(res)}`);
  assert.ok(Array.isArray(res.data.results));
  if (res.data.results.length === 0) {
    assert.equal(res.data.warning, 'semantic_unavailable');
  }

  // Keyword must find all 3 rows (model-independent guarantee).
  const kwRes = await call(client, 'audit_search', {
    agent: 'bro', query: 'authentication', mode: 'keyword',
  });
  assert.equal(kwRes.ok, true);
  assert.equal(kwRes.data.total_matched, 1, 'keyword must find the planning_complete audit row');

  const kwRes2 = await call(client, 'audit_search', {
    agent: 'bro', query: 'database', mode: 'keyword',
  });
  assert.equal(kwRes2.ok, true);
  assert.equal(kwRes2.data.total_matched, 1);

  const kwRes3 = await call(client, 'audit_search', {
    agent: 'bro', query: 'webhook', mode: 'keyword',
  });
  assert.equal(kwRes3.ok, true);
  assert.equal(kwRes3.data.total_matched, 1);
});

// ---------------------------------------------------------------------------
// Flow 10c — File registry via path_prefix
//
// file_registry_upsert inserts without summary; the FTS5 trigger only fires
// WHEN new.summary IS NOT NULL. Keyword/hybrid modes rely on FTS5 for path
// matching. We use path_prefix (which bypasses FTS5) to verify that upserted
// entries are retrievable, and verify semantic/hybrid remain stable.
// ---------------------------------------------------------------------------

test('Flow 10c — file_registry_upsert entries retrievable via path_prefix; hybrid stable', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  // Insert 2 file_registry rows.
  const files = [
    { path: 'src/auth/jwthandler.ts', type: 'source' },
    { path: 'src/db/schemamigration.ts', type: 'source' },
  ];

  for (const { path, type } of files) {
    const r = await call(client, 'file_registry_upsert', {
      agent: 'bro', path, type,
    });
    assert.equal(r.ok, true, `file_registry_upsert ${path}: ${JSON.stringify(r)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 200));

  // path_prefix bypasses FTS5 — works regardless of summary presence.
  const authRes = await call(client, 'file_registry_search', {
    agent: 'bro', query: 'ignored', path_prefix: 'src/auth',
  });
  assert.equal(authRes.ok, true, `path_prefix auth: ${JSON.stringify(authRes)}`);
  assert.equal(authRes.data.total_matched, 1);
  assert.ok(authRes.data.results[0].path.startsWith('src/auth'));

  const dbRes = await call(client, 'file_registry_search', {
    agent: 'bro', query: 'ignored', path_prefix: 'src/db',
  });
  assert.equal(dbRes.ok, true, `path_prefix db: ${JSON.stringify(dbRes)}`);
  assert.equal(dbRes.data.total_matched, 1);

  // Hybrid stable (no FTS entries without summary; cosine may or may not fire).
  const hybRes = await call(client, 'file_registry_search', {
    agent: 'bro', query: 'jwt handler authentication', mode: 'hybrid',
  });
  assert.equal(hybRes.ok, true, `hybrid stable: ${JSON.stringify(hybRes)}`);
  assert.ok(Array.isArray(hybRes.data.results));

  // Semantic stable.
  const semRes = await call(client, 'file_registry_search', {
    agent: 'bro', query: 'jwt handler', mode: 'semantic',
  });
  assert.equal(semRes.ok, true, `semantic stable: ${JSON.stringify(semRes)}`);
  assert.ok(Array.isArray(semRes.data.results));
  if (semRes.data.results.length === 0) {
    assert.equal(semRes.data.warning, 'semantic_unavailable');
  }
});

// ---------------------------------------------------------------------------
// Flow 10d — Live embed-on-write increment
// Seed 5 discussions, then add 1 more. Keyword search must find 6 total rows.
// Semantic search must remain stable after each insert.
// ---------------------------------------------------------------------------

test('Flow 10d — live embed-on-write: count grows correctly after additional discussion_append', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const issueId = await seedIssue(client, 'live embed-on-write increment');

  const uniqueToken = 'backfilltoken99';

  // Step 1: seed 5 discussions.
  for (let i = 1; i <= 5; i++) {
    const r = await call(client, 'discussion_append', {
      agent: 'bro', issue_id: issueId, author: 'bro', kind: 'note',
      body: `${uniqueToken} discussion entry number ${i}`,
    });
    assert.equal(r.ok, true, `seed discussion ${i}: ${JSON.stringify(r)}`);
  }

  // Step 2: verify keyword finds all 5.
  const kw5 = await call(client, 'discussion_search', {
    agent: 'bro', query: uniqueToken, mode: 'keyword', k: 20,
  });
  assert.equal(kw5.ok, true, JSON.stringify(kw5));
  assert.equal(kw5.data.total_matched, 5, `expected 5 seeded rows; got ${kw5.data.total_matched}`);

  // Step 3: insert 1 more discussion (live embed-on-write).
  const extra = await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, author: 'bro', kind: 'note',
    body: `${uniqueToken} sixth discussion added after initial seed`,
  });
  assert.equal(extra.ok, true, `extra discussion_append: ${JSON.stringify(extra)}`);

  // Brief wait for fire-and-forget.
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Step 4: keyword count must reflect the 6th row immediately (keyword is synchronous).
  const kw6 = await call(client, 'discussion_search', {
    agent: 'bro', query: uniqueToken, mode: 'keyword', k: 20,
  });
  assert.equal(kw6.ok, true, JSON.stringify(kw6));
  assert.equal(kw6.data.total_matched, 6, `expected 6 rows after extra insert; got ${kw6.data.total_matched}`);

  // Step 5: semantic search stable after the 6th insert.
  const sem6 = await call(client, 'discussion_search', {
    agent: 'bro', query: 'discussion entry seed', mode: 'semantic',
  });
  assert.equal(sem6.ok, true, `semantic after 6th insert: ${JSON.stringify(sem6)}`);
  assert.ok(Array.isArray(sem6.data.results));
  if (sem6.data.results.length === 0) {
    assert.equal(sem6.data.warning, 'semantic_unavailable');
  }
});

// ---------------------------------------------------------------------------
// Flow 10e — Backfill startup contract: server starts, log emitted, no crash.
// The :memory: harness starts with an empty DB so backfill finds 0 pending
// rows and exits immediately. We verify the server remains responsive after
// startBackfill() completes.
// ---------------------------------------------------------------------------

test('Flow 10e — startup backfill: server remains responsive after startBackfill() completes', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  // Wait slightly longer to give startBackfill() time to finish its count
  // query on the :memory: DB (it will find 0 pending rows and return early).
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Server must still respond to MCP calls correctly.
  const issueId = await seedIssue(client, 'post-backfill server health');
  assert.ok(typeof issueId === 'number', 'server must remain responsive after backfill');

  // One round-trip of each search tool to confirm no startup corruption.
  const dis = await call(client, 'discussion_search', {
    agent: 'bro', query: 'post backfill health', mode: 'keyword',
  });
  assert.equal(dis.ok, true, `discussion_search after backfill: ${JSON.stringify(dis)}`);

  const aud = await call(client, 'audit_search', {
    agent: 'bro', query: 'post backfill audit', mode: 'keyword',
  });
  assert.equal(aud.ok, true, `audit_search after backfill: ${JSON.stringify(aud)}`);

  const fil = await call(client, 'file_registry_search', {
    agent: 'bro', query: 'postbackfillfile', mode: 'keyword',
  });
  assert.equal(fil.ok, true, `file_registry_search after backfill: ${JSON.stringify(fil)}`);
});
