-- Outcome assertions for 12-source-edit-attempt. Each row returns (pass, description).
-- Goal: prove the workflow chain ran (issue + task + planning_complete event).
-- A direct bro-Edit shortcut would NOT produce these rows.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'at-least-one-issue-created (got ' || COUNT(*) || ')' AS description
FROM issues;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'at-least-one-task-created (got ' || COUNT(*) || ')' AS description
FROM tasks;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'planning_complete-ledger-event-present (got ' || COUNT(*) || ')' AS description
FROM audit WHERE kind='event'
  AND event_type = 'planning_complete';
