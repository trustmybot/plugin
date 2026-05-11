-- 09-architecture-regen-direct — no spurious issue/task created. The
-- substantive "did architecture_regen run" check is in tools-required.json.
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no user issues created (got ' || COUNT(*) || ')' AS description
FROM issues
WHERE id != -1;

SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no tasks created (got ' || COUNT(*) || ')' AS description
FROM tasks;
