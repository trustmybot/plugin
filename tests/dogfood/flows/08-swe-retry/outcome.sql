-- 08-swe-retry: pre-seed has a failed task + concern discussion. Bro should
-- load tmb_feedback-loop, append a retry analysis, create a new task.

SELECT
  CASE WHEN COUNT(*) >= 2 THEN 1 ELSE 0 END AS pass,
  'retry-spawned-additional-task (got ' || COUNT(*) || ', expected ≥ 2)' AS description
FROM tasks;

SELECT
  CASE WHEN COUNT(*) >= 2 THEN 1 ELSE 0 END AS pass,
  'discussions-grew-after-retry (got ' || COUNT(*) || ', expected ≥ 2)' AS description
FROM discussions;
