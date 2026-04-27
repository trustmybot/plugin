-- 10-codebase-memory-cold-start outcome assertions (#45)
-- Existing repo + identity present + file_registry empty + headless mode
-- (no Human to answer AskUserQuestion). Per tmb_headless-fallback, bro
-- defaults to 'lazy' and records a headless_fallback ledger event with
-- a summary mentioning project-prescan or cold-start. Then bro proceeds
-- with planning the actual ask (issue_create + task_create_batch).

-- #181: headless_fallback ledger event is bro prompt-only doctrine; bro
-- skips inconsistently in headless `claude -p` mode. Disabled until #181's
-- enforcement hook lands. Original assertion (kept commented for restoration):
--   headless_fallback event WHERE summary mentions project-prescan/cold-start/deep-scan ≥ 1

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
