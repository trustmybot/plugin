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

-- #45 + #181: bro updates file_registry_update_summaries during verification,
-- BEFORE flipping task to closed. Server-side requireRoles + a PreToolUse
-- hook on task_update_status enforce the new ownership structurally
-- (#181). If bro skips, the close call is denied — so any closed task in
-- the DB implies fresh summaries for its touched paths.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'file_registry-has-md5-and-summary-after-bro-close (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM file_registry
WHERE content_md5 IS NOT NULL AND summary IS NOT NULL;

SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'last_verified_sha-was-set-after-close (got ' || COUNT(*) || ', expected 1)' AS description
FROM plugin_config
WHERE key = 'last_verified_sha';
