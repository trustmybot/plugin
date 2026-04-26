-- 01-onboarding outcome assertions
SELECT
  CASE WHEN COUNT(*) = 1 AND MIN(created_at) IS NOT NULL THEN 1 ELSE 0 END AS pass,
  'identity-row-exists-with-created_at (rows=' || COUNT(*) || ')' AS description
FROM identity;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'branching_model-config-present' AS description
FROM plugin_config WHERE key = 'branching_model';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'pr_target-config-present' AS description
FROM plugin_config WHERE key = 'pr_target';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'protected_branches-config-present' AS description
FROM plugin_config WHERE key = 'protected_branches';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'tmb_onboarding_complete-ledger-event-present' AS description
FROM ledger WHERE event_type = 'tmb_onboarding_complete';
