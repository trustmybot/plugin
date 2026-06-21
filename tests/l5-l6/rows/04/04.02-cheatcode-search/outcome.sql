-- Outcome assertions for 04.02-cheatcode-search. Each row returns (pass, description).
-- The scorer requires every row's pass column to be 1.
--
-- Scope: bro spots the capability gap and fires cheatcode_search. The
-- deterministic proof is the cheatcode_search audit row — ranking quality is
-- covered by L2/L3, not here.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'cheatcode_search-audit-row-exists (got ' || COUNT(*) || ')' AS description
FROM audit
WHERE event_type = 'cheatcode_search';
