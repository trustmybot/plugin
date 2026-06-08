-- 08-roundtable-routing-redirect — no roundtable rows should exist after
-- the session.
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'roundtables row count = 0 (got ' || COUNT(*) || ')' AS description
FROM roundtables;
