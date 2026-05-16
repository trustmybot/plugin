-- Outcome assertions for 13-bulk-cleanup. Each row returns (pass, description).
-- Goal: prove bro executed a pre-authorized bulk delete without routing through
-- SWE and without pausing for confirmation.
-- Note: .DS_Store removal is filesystem hygiene — no issue/task/audit required.
-- The key DB assertion is that AskUserQuestion was NOT called (see tools-forbidden.json)
-- and no task was wastefully created for this trivial housekeeping op.

SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no-task-created-for-housekeeping (got ' || COUNT(*) || ', expected 0 — cleanup is direct Bash, not SWE-routed)' AS description
FROM tasks;
