-- 12-scan-required-before-tasks — bro must have run /scan (deep_scan_completed
-- audit row) AND must have created at least one task afterward.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'deep_scan_completed audit row (got ' || COUNT(*) || ', expected >=1) — bro ran /scan' AS description
FROM audit
WHERE event_type = 'deep_scan_completed';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'tasks created post-scan (got ' || COUNT(*) || ', expected >=1)' AS description
FROM tasks;
