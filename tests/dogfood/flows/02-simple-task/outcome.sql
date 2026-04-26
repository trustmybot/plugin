-- Outcome assertions for 02-simple-task. Each row returns (pass, description).
-- The scorer requires every row's pass column to be 1.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'at-least-one-issue-created (got ' || COUNT(*) || ')' AS description
FROM issues
WHERE LOWER(objective) LIKE '%todo%' OR LOWER(objective) LIKE '%cli%';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'at-least-one-task-created (got ' || COUNT(*) || ')' AS description
FROM tasks;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'planning_complete-ledger-event-present (got ' || COUNT(*) || ')' AS description
FROM ledger
WHERE event_type = 'planning_complete';

-- Negative: no Direct Mode marker should appear (this is a non-trivial task)
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no-direct-mode-event (got ' || COUNT(*) || ', expected 0)' AS description
FROM ledger
WHERE event_type = 'direct_mode_used';
