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

-- #45: tmb_direct-mode step 4 must update file_registry for the edited file
-- (refreshed content_md5 + summary). README.md is what the typo-fix prompt
-- targets; assert there's at least one row with non-null md5 + summary.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'file_registry-row-after-direct-mode-edit (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM file_registry
WHERE content_md5 IS NOT NULL AND summary IS NOT NULL;

-- #45: last_verified_sha was advanced (step 4's advance_verified_sha arg).
SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'last_verified_sha-was-set-after-direct-mode (got ' || COUNT(*) || ', expected 1)' AS description
FROM plugin_config
WHERE key = 'last_verified_sha';
