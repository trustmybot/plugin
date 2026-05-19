-- 20-codebase-memory-cold-start outcome assertions (#45)
-- Existing repo + identity present + file_registry empty + headless mode
-- (no Human to answer AskUserQuestion). Per tmb_recovery §A, bro
-- defaults to 'lazy' and records a headless_fallback audit event.
-- Then bro proceeds with planning the actual ask.

-- Bro should NOT have run a deep scan in headless (default = lazy).
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'deep_scan-NOT-completed-in-headless (got ' || COUNT(*) || ', expected 0)' AS description
FROM audit WHERE event_type = 'deep_scan_completed';

-- After the fallback, bro must still proceed with planning.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'issue-was-created-after-fallback (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM issues;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'task-was-created-after-fallback (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM tasks;
