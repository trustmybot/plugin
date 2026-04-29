-- 03-difficult-task: arch-touching ask must produce issue + task + a discussion
-- (tmb_planning-difficult logs design Q+A) + planning_complete ledger event.

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
FROM ledger
WHERE event_type = 'planning_complete';

-- difficult-path differentiator: at least one discussion row.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'at-least-one-discussion-row (got ' || COUNT(*) || ', expected ≥ 1 for difficult path)' AS description
FROM discussions;
