-- Outcome assertions for 40-cheatcode. Each row returns (pass, description).
-- The scorer requires every row's pass column to be 1.
--
-- Scope: bro spots the capability gap and fires resource_search. The
-- deterministic proof is the resource_search audit row — ranking quality is
-- covered by L2/L3, not here.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'resource_search-audit-row-exists (got ' || COUNT(*) || ')' AS description
FROM audit
WHERE event_type = 'resource_search';
