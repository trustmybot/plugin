-- Outcome assertions for 23-bulk-cleanup.
-- Goal: prove bro executed a pre-authorized bulk delete without routing through
-- SWE and without pausing for confirmation.

SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no-task-created-for-housekeeping (got ' || COUNT(*) || ', expected 0 — cleanup is direct Bash, not SWE-routed)' AS description
FROM tasks;
