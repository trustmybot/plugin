-- 11-roundtable — slash-invoke gate cleared, deliberation produced analyses.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'roundtable_slash_invoked audit row (got ' || COUNT(*) || ', expected >=1)' AS description
FROM audit
WHERE event_type = 'roundtable_slash_invoked';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'roundtables row count (got ' || COUNT(*) || ', expected >=1)' AS description
FROM roundtables;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'discussions kind=analysis row count (got ' || COUNT(*) || ', expected >=1)' AS description
FROM discussions
WHERE kind = 'analysis';
