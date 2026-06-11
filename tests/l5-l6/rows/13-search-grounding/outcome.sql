-- 13-search-grounding — bro must search discussions to ground its answer
-- about the architectural decision made in step 08.

-- (a) The discussions_embeddings table has at least one row — either seeded
-- by setup-l5.sh (L5 mode) or produced organically by step 08 + server
-- backfill (L6 chain mode). This verifies the search substrate exists.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'discussions_embeddings populated for step-08 decision (got ' || COUNT(*) || ', expected >=1)' AS description
FROM discussions_embeddings;

-- (b) At least one kind='decision' discussion exists — the target of the search.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'kind=decision discussion exists (got ' || COUNT(*) || ', expected >=1)' AS description
FROM discussions
WHERE kind = 'decision';
