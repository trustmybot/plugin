-- 01-first-contact outcome assertions
-- Empty DB → @bro hi → bro applies defaults silently. No interactive ceremony.
-- Identity stays UNSET (no row) until the user reonboards. Three policy keys
-- get default values. Ledger gets exactly one tmb_defaults_applied event.

SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no-identity-row-on-first-contact (got ' || COUNT(*) || ', expected 0)' AS description
FROM identity;

SELECT
  CASE WHEN COUNT(*) = 1 AND value_json = '"github-flow"' THEN 1 ELSE 0 END AS pass,
  'branching_model-default-applied' AS description
FROM plugin_config WHERE key = 'branching_model';

SELECT
  CASE WHEN COUNT(*) = 1 AND value_json = '"main"' THEN 1 ELSE 0 END AS pass,
  'pr_target-default-applied' AS description
FROM plugin_config WHERE key = 'pr_target';

SELECT
  CASE WHEN COUNT(*) = 1 AND value_json = '["main"]' THEN 1 ELSE 0 END AS pass,
  'protected_branches-default-applied' AS description
FROM plugin_config WHERE key = 'protected_branches';

SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'tmb_defaults_applied-ledger-event-present (got ' || COUNT(*) || ')' AS description
FROM ledger WHERE event_type = 'tmb_defaults_applied';
