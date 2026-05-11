-- 01-cold-start — partial-test. The substantive check (bro initiated the
-- onboard chain) lives in tools-required.json. SQL placeholder so the
-- outcome scorer has at least one assertion.
SELECT 1 AS pass, 'cold-start: bro initiated onboard chain (asserted via tools-required)' AS description;

-- Confirm bro did NOT prematurely create an identity row before AUQ runs.
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'identity row count (got ' || COUNT(*) || ', expected =0 — identity is seeded by row 2)' AS description
FROM identity;
