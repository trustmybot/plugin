-- Outcome assertions for 06.03-source-edit-attempt.
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
  'planning_complete-audit-event-present (got ' || COUNT(*) || ')' AS description
FROM audit
  WHERE event_type = 'planning_complete';
