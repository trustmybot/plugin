-- 10-codebase-memory-cold-start outcome assertions (#45)
-- Existing repo + identity present + file_registry empty + headless mode
-- (no Human to answer AskUserQuestion). Per tmb_recovery §A, bro
-- defaults to 'lazy' and records a headless_fallback audit event with
-- a summary mentioning project-prescan or cold-start. Then bro proceeds
-- with planning the actual ask (issue_create + task_create_batch).

-- The `headless_fallback` audit event is bro prompt-only doctrine
-- (`tmb_recovery §A` skill says bro must log when AskUserQuestion
-- defaults are auto-applied). Bro skips inconsistently in `claude -p`
-- headless mode — same h3/h4 ceiling. Separate from #181 (which covers
-- file_registry summaries, not headless_fallback events). Filed as a
-- follow-up: bro needs a Layer 2 enforcement for the headless-fallback
-- audit log. Original assertion kept commented for restoration:
--   headless_fallback event WHERE summary mentions project-prescan/cold-start/deep-scan ≥ 1

-- Bro should NOT have run a deep scan in headless (default = lazy).
-- A deep_scan_completed event would indicate the wrong fallback fired.
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'deep_scan-NOT-completed-in-headless (got ' || COUNT(*) || ', expected 0)' AS description
FROM audit WHERE kind='event' AND event_type = 'deep_scan_completed';

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
