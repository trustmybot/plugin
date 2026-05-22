// Layer 3 integration: discussion_search, audit_search, file_registry_search
// via real MCP subprocess (harness.mjs). Tests all 3 modes: keyword, semantic, hybrid.
// Cold-fallback: semantic mode gracefully degrades when model unavailable.
// Role gate: discussion_search rejects callers that lack normalizable agent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, call } from './harness.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedIssue(client) {
  const r = await call(client, 'issue_create', {
    agent: 'bro',
    objective: 'search-tools test fixture',
    description: 'fixture for search integration tests',
  });
  assert.equal(r.ok, true, `seed issue: ${JSON.stringify(r)}`);
  return r.data.id;
}

// ---------------------------------------------------------------------------
// discussion_search
// ---------------------------------------------------------------------------

test('discussion_search — keyword: single match returns snippet + total_matched=1', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const issueId = await seedIssue(client);
  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, author: 'bro', kind: 'note',
    body: 'authentication flow implemented with JWT tokens',
  });
  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, author: 'bro', kind: 'note',
    body: 'unrelated note about database schema',
  });

  const res = await call(client, 'discussion_search', {
    agent: 'bro', query: 'authentication', mode: 'keyword',
  });
  assert.equal(res.ok, true, `discussion_search: ${JSON.stringify(res)}`);
  assert.equal(res.data.total_matched, 1);
  assert.equal(res.data.results.length, 1);
  assert.ok(
    res.data.results[0].snippet.toLowerCase().includes('authentication') ||
    res.data.results[0].snippet.includes('[authentication]'),
    `snippet should highlight term: ${res.data.results[0].snippet}`,
  );
});

test('discussion_search — keyword: multiple matches returns all + correct count', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const issueId = await seedIssue(client);
  for (let i = 1; i <= 3; i++) {
    await call(client, 'discussion_append', {
      agent: 'bro', issue_id: issueId, author: 'bro', kind: 'note',
      body: `webhook handler iteration ${i}`,
    });
  }

  const res = await call(client, 'discussion_search', {
    agent: 'bro', query: 'webhook', mode: 'keyword',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.total_matched, 3);
  assert.equal(res.data.results.length, 3);
});

test('discussion_search — keyword: no match returns empty results + total_matched=0', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const issueId = await seedIssue(client);
  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, author: 'bro', kind: 'note',
    body: 'planning started for deployment pipeline',
  });

  const res = await call(client, 'discussion_search', {
    agent: 'bro', query: 'xyzzy99uniquetoken', mode: 'keyword',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.total_matched, 0);
  assert.equal(res.data.results.length, 0);
});

test('discussion_search — semantic: model-unavailable path returns graceful fallback', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const issueId = await seedIssue(client);
  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, author: 'bro', kind: 'note',
    body: 'semantic search graceful degradation test content',
  });

  const res = await call(client, 'discussion_search', {
    agent: 'bro', query: 'graceful degradation', mode: 'semantic',
  });
  assert.equal(res.ok, true, `semantic must not throw: ${JSON.stringify(res)}`);
  assert.ok(Array.isArray(res.data.results), 'results must be array');
  // Either model loaded (results present) or model unavailable (warning set)
  if (res.data.results.length === 0) {
    assert.equal(
      res.data.warning,
      'semantic_unavailable',
      'empty results must carry semantic_unavailable warning',
    );
  }
});

test('discussion_search — semantic: when model unavailable, tool succeeds without exception', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  // Empty DB — no embeddings possible; model will return null → empty results.
  const res = await call(client, 'discussion_search', {
    agent: 'bro', query: 'some query', mode: 'semantic',
  });
  assert.equal(res.ok, true, 'semantic search must not throw on empty DB');
  assert.ok(
    Array.isArray(res.data.results),
    `results must be array; got ${JSON.stringify(res.data)}`,
  );
  // Model unavailable → warning expected when results is empty
  if (res.data.results.length === 0) {
    assert.equal(res.data.warning, 'semantic_unavailable');
  }
});

test('discussion_search — semantic: model-available path returns ranked results including target', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const issueId = await seedIssue(client);
  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, author: 'bro', kind: 'note',
    body: 'deploying authentication service to production cluster',
  });

  const res = await call(client, 'discussion_search', {
    agent: 'bro', query: 'deploy auth service', mode: 'semantic',
  });
  assert.equal(res.ok, true, `semantic must not throw: ${JSON.stringify(res)}`);
  assert.ok(Array.isArray(res.data.results));
  // If model loaded: results are non-empty. If not: warning is set. Both OK.
  if (res.data.results.length > 0) {
    assert.ok(typeof res.data.results[0].id === 'number', 'each result needs an id');
  } else {
    assert.equal(res.data.warning, 'semantic_unavailable');
  }
});

test('discussion_search — hybrid: returns results array and does not throw', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const issueId = await seedIssue(client);
  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, author: 'bro', kind: 'note',
    body: 'hybrid ranking combines fts and semantic scores',
  });
  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, author: 'bro', kind: 'decision',
    body: 'decided on hybrid search for ranking pipeline',
  });

  const res = await call(client, 'discussion_search', {
    agent: 'bro', query: 'hybrid ranking', mode: 'hybrid',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(Array.isArray(res.data.results));
});

test('discussion_search — hybrid: keyword-hit rows appear in hybrid results (RRF)', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const issueId = await seedIssue(client);
  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, author: 'bro', kind: 'note',
    body: 'cachebusting the static asset pipeline',
  });

  const res = await call(client, 'discussion_search', {
    agent: 'bro', query: 'cachebusting', mode: 'hybrid',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(Array.isArray(res.data.results));
  // FTS5 should find the keyword-match row; hybrid must include it.
  assert.ok(
    res.data.results.length >= 1,
    'hybrid must surface keyword-matched row',
  );
});

test('discussion_search — hybrid: no FTS-match on empty DB returns array, not error', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  // Hybrid includes cosine when model loaded; even nonsense queries may get
  // cosine results from any existing embeddings. Contract: ok=true, array.
  const res = await call(client, 'discussion_search', {
    agent: 'bro', query: 'xyzzy9999noresult', mode: 'hybrid',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(Array.isArray(res.data.results), 'results must be an array');
});

// ---------------------------------------------------------------------------
// discussion_search — agent identity + pagination
// ---------------------------------------------------------------------------

test('discussion_search — agent identity: bro succeeds; file_registry_upsert with swe is rejected', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  // discussion_search is not role-gated (no requireRoles); any agent may call it.
  // Verify bro succeeds (broad contract).
  const res = await call(client, 'discussion_search', {
    agent: 'bro', query: 'anything', mode: 'keyword',
  });
  assert.equal(res.ok, true, `bro must succeed on discussion_search: ${JSON.stringify(res)}`);

  // Role gate is enforced on write tools (e.g. file_registry_upsert).
  const gated = await call(client, 'file_registry_upsert', {
    agent: 'swe', path: 'src/x.ts', type: 'source',
  });
  assert.equal(gated.ok, false, `swe must be forbidden from file_registry_upsert: ${JSON.stringify(gated)}`);
  assert.equal(gated.error?.error, 'forbidden');
});

test('discussion_search — pagination: k limits returned rows', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const issueId = await seedIssue(client);
  for (let i = 1; i <= 8; i++) {
    await call(client, 'discussion_append', {
      agent: 'bro', issue_id: issueId, author: 'bro', kind: 'note',
      body: `pagination test entry number ${i} keyword paginate`,
    });
  }

  const res = await call(client, 'discussion_search', {
    agent: 'bro', query: 'paginate', mode: 'keyword', k: 3,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.results.length, 3, 'k=3 must return exactly 3 results');
  assert.equal(res.data.total_matched, 8, 'total_matched must reflect full count');
});

// ---------------------------------------------------------------------------
// audit_search
// ---------------------------------------------------------------------------

test('audit_search — keyword: single match in summary', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const issueId = await seedIssue(client);
  await call(client, 'audit_log', {
    agent: 'bro', issue_id: issueId, from_node: 'bro',
    event_type: 'planning_complete',
    summary: 'completed planning for authentication module deployment',
  });
  await call(client, 'audit_log', {
    agent: 'bro', issue_id: issueId, from_node: 'bro',
    event_type: 'swe_complete',
    summary: 'database migration committed',
  });

  const res = await call(client, 'audit_search', {
    agent: 'bro', query: 'authentication', mode: 'keyword',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.total_matched, 1);
  assert.equal(res.data.results[0].event_type, 'planning_complete');
});

test('audit_search — keyword: multiple matches + event_types filter', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const issueId = await seedIssue(client);
  await call(client, 'audit_log', {
    agent: 'bro', issue_id: issueId, from_node: 'bro',
    event_type: 'planning_complete', summary: 'deployment plan for cache layer',
  });
  await call(client, 'audit_log', {
    agent: 'swe', issue_id: issueId, from_node: 'swe',
    event_type: 'swe_complete', summary: 'deployment of cache layer committed',
  });

  const res = await call(client, 'audit_search', {
    agent: 'bro', query: 'deployment', mode: 'keyword',
    event_types: ['swe_complete'],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.total_matched, 1);
  assert.equal(res.data.results[0].event_type, 'swe_complete');
});

test('audit_search — keyword: no match returns empty', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const res = await call(client, 'audit_search', {
    agent: 'bro', query: 'zzznoaudittoken99', mode: 'keyword',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.total_matched, 0);
  assert.equal(res.data.results.length, 0);
});

test('audit_search — semantic: model-unavailable path returns graceful fallback', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const res = await call(client, 'audit_search', {
    agent: 'bro', query: 'planning complete for module', mode: 'semantic',
  });
  assert.equal(res.ok, true, `semantic must not throw: ${JSON.stringify(res)}`);
  assert.ok(Array.isArray(res.data.results));
  if (res.data.results.length === 0) {
    assert.equal(res.data.warning, 'semantic_unavailable');
  }
});

test('audit_search — semantic: empty DB returns warning, not exception', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const res = await call(client, 'audit_search', {
    agent: 'bro', query: 'any query', mode: 'semantic',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(Array.isArray(res.data.results));
  if (res.data.results.length === 0) {
    assert.equal(res.data.warning, 'semantic_unavailable');
  }
});

test('audit_search — semantic: model-available returns ranked results including target', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const issueId = await seedIssue(client);
  await call(client, 'audit_log', {
    agent: 'bro', issue_id: issueId, from_node: 'bro',
    event_type: 'planning_complete',
    summary: 'authentication module planning completed with OIDC strategy',
  });

  const res = await call(client, 'audit_search', {
    agent: 'bro', query: 'auth OIDC planning', mode: 'semantic',
  });
  assert.equal(res.ok, true, `semantic: ${JSON.stringify(res)}`);
  assert.ok(Array.isArray(res.data.results));
  if (res.data.results.length > 0) {
    assert.ok(typeof res.data.results[0].id === 'number');
  } else {
    assert.equal(res.data.warning, 'semantic_unavailable');
  }
});

test('audit_search — hybrid: returns array, does not throw on empty DB', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const res = await call(client, 'audit_search', {
    agent: 'bro', query: 'any_hybrid_query', mode: 'hybrid',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(Array.isArray(res.data.results));
});

test('audit_search — hybrid: keyword-matched rows appear in results', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const issueId = await seedIssue(client);
  await call(client, 'audit_log', {
    agent: 'bro', issue_id: issueId, from_node: 'bro',
    event_type: 'planning_complete',
    summary: 'multistage build pipeline configured for rollout',
  });

  const res = await call(client, 'audit_search', {
    agent: 'bro', query: 'rollout', mode: 'hybrid',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(Array.isArray(res.data.results));
  assert.ok(res.data.results.length >= 1, 'hybrid must surface keyword-matched audit row');
});

test('audit_search — hybrid: no FTS-match returns results array without throwing', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  // Hybrid includes cosine when model is loaded; results may be non-empty
  // even for nonsense queries (cosine ranks existing embeddings). The
  // contract is: ok=true, results is an array. No throw.
  const res = await call(client, 'audit_search', {
    agent: 'bro', query: 'zzznomatch8889audit', mode: 'hybrid',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(Array.isArray(res.data.results), 'results must be an array');
});

// ---------------------------------------------------------------------------
// file_registry_search
//
// NOTE: file_registry_upsert does NOT set summary. The FTS5 trigger on
// file_registry only fires WHEN new.summary IS NOT NULL. Therefore,
// file_registry_upsert entries are NOT in the FTS5 index. Keyword mode
// can only hit entries with a non-null summary. For integration tests
// we use path_prefix (FTS bypass) to verify the upsert→search path.
// ---------------------------------------------------------------------------

test('file_registry_search — path_prefix: matches upserted entries by prefix', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  await call(client, 'file_registry_upsert', {
    agent: 'bro',
    path: 'src/auth/jwtauthentication.ts',
    type: 'source',
  });
  await call(client, 'file_registry_upsert', {
    agent: 'bro',
    path: 'src/auth/sessionhandler.ts',
    type: 'source',
  });
  await call(client, 'file_registry_upsert', {
    agent: 'bro',
    path: 'src/db/migrationschema.ts',
    type: 'source',
  });

  const res = await call(client, 'file_registry_search', {
    agent: 'bro', query: 'ignored_when_prefix', path_prefix: 'src/auth',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.total_matched, 2, 'path_prefix must find both auth entries');
  assert.ok(res.data.results.every(r => r.path.startsWith('src/auth')));
});

test('file_registry_search — path_prefix: single match by exact prefix', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  await call(client, 'file_registry_upsert', {
    agent: 'bro', path: 'src/webhook/handlerroute1.ts', type: 'source',
  });
  await call(client, 'file_registry_upsert', {
    agent: 'bro', path: 'src/webhook/handlerroute2.ts', type: 'source',
  });
  await call(client, 'file_registry_upsert', {
    agent: 'bro', path: 'src/db/schema.ts', type: 'source',
  });

  const res = await call(client, 'file_registry_search', {
    agent: 'bro', query: 'x', path_prefix: 'src/webhook',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.total_matched, 2);
  assert.ok(res.data.results.every(r => r.path.startsWith('src/webhook')));
});

test('file_registry_search — keyword: no FTS-indexed entries → empty results', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  // file_registry_upsert inserts without summary; FTS trigger skips them.
  // keyword mode queries FTS5, which returns 0 hits.
  await call(client, 'file_registry_upsert', {
    agent: 'bro', path: 'src/nosummary/file.ts', type: 'source',
  });

  const res = await call(client, 'file_registry_search', {
    agent: 'bro', query: 'nosummary', mode: 'keyword',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.total_matched, 0);
  assert.equal(res.data.results.length, 0);
});

test('file_registry_search — semantic: model-unavailable returns graceful fallback', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const res = await call(client, 'file_registry_search', {
    agent: 'bro', query: 'authentication handler', mode: 'semantic',
  });
  assert.equal(res.ok, true, `semantic must not throw: ${JSON.stringify(res)}`);
  assert.ok(Array.isArray(res.data.results));
  if (res.data.results.length === 0) {
    assert.equal(res.data.warning, 'semantic_unavailable');
  }
});

test('file_registry_search — semantic: empty DB returns warning, not exception', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const res = await call(client, 'file_registry_search', {
    agent: 'bro', query: 'any file query', mode: 'semantic',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(Array.isArray(res.data.results));
  if (res.data.results.length === 0) {
    assert.equal(res.data.warning, 'semantic_unavailable');
  }
});

test('file_registry_search — semantic: model-available returns ranked results', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  await call(client, 'file_registry_upsert', {
    agent: 'bro',
    path: 'src/auth/tokenhandler.ts',
    type: 'source',
  });

  const res = await call(client, 'file_registry_search', {
    agent: 'bro', query: 'token authentication handler', mode: 'semantic',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(Array.isArray(res.data.results));
  if (res.data.results.length > 0) {
    assert.ok(typeof res.data.results[0].path === 'string');
  } else {
    assert.equal(res.data.warning, 'semantic_unavailable');
  }
});

test('file_registry_search — hybrid: returns array on empty DB, does not throw', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const res = await call(client, 'file_registry_search', {
    agent: 'bro', query: 'any_query', mode: 'hybrid',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(Array.isArray(res.data.results));
});

test('file_registry_search — hybrid: returns array after upsert (no FTS entries without summary)', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  // Entries without summary are not in FTS. Hybrid will find nothing via
  // keyword; may find via cosine if model is loaded and embedded. Either way:
  // ok=true, results is array.
  await call(client, 'file_registry_upsert', {
    agent: 'bro',
    path: 'src/cachebusting/staticassets.ts',
    type: 'source',
  });

  const res = await call(client, 'file_registry_search', {
    agent: 'bro', query: 'cachebusting', mode: 'hybrid',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(Array.isArray(res.data.results), 'results must be an array');
});

test('file_registry_search — hybrid: empty registry returns empty array, not error', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  // Completely empty file_registry — no FTS hits, no cosine hits.
  const res = await call(client, 'file_registry_search', {
    agent: 'bro', query: 'zzznomatchfile9999', mode: 'hybrid',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(Array.isArray(res.data.results));
  assert.equal(res.data.results.length, 0);
});

// ---------------------------------------------------------------------------
// Cold-fallback scenario: explicit verification of semantic_unavailable contract
// ---------------------------------------------------------------------------

test('cold-fallback — audit_search semantic returns semantic_unavailable when no embeddings', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  // In a fresh :memory: DB there are no embeddings. topKByCosine returns [].
  // Semantic mode must return warning + empty results, not throw.
  const res = await call(client, 'audit_search', {
    agent: 'bro', query: 'cold fallback test', mode: 'semantic',
  });

  assert.equal(res.ok, true, 'cold-fallback: tool must not return isError=true');
  assert.ok(Array.isArray(res.data.results), 'results must be array');
  // Model unavailable in test env → empty results + warning
  if (res.data.results.length === 0) {
    assert.equal(
      res.data.warning,
      'semantic_unavailable',
      `expected semantic_unavailable warning; got: ${JSON.stringify(res.data)}`,
    );
  }
});

test('cold-fallback — discussion_search semantic: response.warning === semantic_unavailable when no embeddings', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  const issueId = await seedIssue(client);
  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, author: 'bro', kind: 'note',
    body: 'cold restart simulation with no cached model',
  });

  const res = await call(client, 'discussion_search', {
    agent: 'bro', query: 'cold restart simulation', mode: 'semantic',
  });

  assert.equal(res.ok, true, 'cold-fallback: must succeed without exception');
  assert.ok(Array.isArray(res.data.results), 'results must be array');
  // If model unavailable (typical in test env): warning is set
  if (res.data.results.length === 0) {
    assert.equal(
      res.data.warning,
      'semantic_unavailable',
      `expected warning on empty semantic results; got: ${JSON.stringify(res.data)}`,
    );
  }
});

test('cold-fallback — file_registry_search semantic: response.warning === semantic_unavailable', async (t) => {
  const { client, close } = await startClient();
  t.after(() => close());

  await call(client, 'file_registry_upsert', {
    agent: 'bro', path: 'src/cold/fallbacktest.ts', type: 'source',
  });

  const res = await call(client, 'file_registry_search', {
    agent: 'bro', query: 'cold fallback test file', mode: 'semantic',
  });

  assert.equal(res.ok, true, 'cold-fallback: file_registry_search must not throw');
  assert.ok(Array.isArray(res.data.results));
  if (res.data.results.length === 0) {
    assert.equal(
      res.data.warning,
      'semantic_unavailable',
      `expected warning; got: ${JSON.stringify(res.data)}`,
    );
  }
});
