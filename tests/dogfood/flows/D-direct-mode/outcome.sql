-- D-direct-mode outcome assertions
SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'exactly-one-direct_mode_used-ledger-event (got ' || COUNT(*) || ', expected 1)' AS description
FROM ledger
WHERE event_type = 'direct_mode_used';

SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no-tasks-created-in-direct-mode (got ' || COUNT(*) || ', expected 0)' AS description
FROM tasks;

SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no-planning_complete-event-in-direct-mode (got ' || COUNT(*) || ', expected 0)' AS description
FROM ledger
WHERE event_type = 'planning_complete';
