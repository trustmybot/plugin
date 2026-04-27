-- 10-codebase-memory-cold-start outcome assertions (#45)
-- Existing repo + identity present + file_registry empty + headless mode
-- (no Human to answer AskUserQuestion). Per tmb_headless-fallback, bro
-- defaults to 'lazy' and records a headless_fallback ledger event with
-- a summary mentioning project-prescan or cold-start. Then bro proceeds
-- with planning the actual ask (issue_create + task_create_batch).

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'headless_fallback-event-recorded-for-cold-start (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM ledger
WHERE event_type = 'headless_fallback'
  AND (summary LIKE '%project-prescan%' OR summary LIKE '%cold-start%' OR summary LIKE '%cold start%' OR summary LIKE '%deep scan%' OR summary LIKE '%deep-scan%');

-- Bro should NOT have run a deep scan in headless (default = lazy).
-- A deep_scan_completed event would indicate the wrong fallback fired.
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'deep_scan-NOT-completed-in-headless (got ' || COUNT(*) || ', expected 0)' AS description
FROM ledger WHERE event_type = 'deep_scan_completed';

-- After the fallback, bro must still proceed with planning. issue_create
-- + task_create_batch indicate the planning chain ran.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'issue-was-created-after-fallback (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM issues;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'task-was-created-after-fallback (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM tasks;
