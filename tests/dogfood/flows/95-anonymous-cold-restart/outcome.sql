-- 95 outcome: state must be UNCHANGED from pre-fixture (no re-onboarding writes)
SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'identity-row-count-unchanged (got ' || COUNT(*) || ', expected 1)' AS description
FROM identity;

SELECT
  CASE WHEN COUNT(*) = 1 AND human_name IS NULL THEN 1 ELSE 0 END AS pass,
  'identity-still-anonymous (human_name should be NULL)' AS description
FROM identity;

SELECT
  CASE WHEN COUNT(*) = 3 THEN 1 ELSE 0 END AS pass,
  'three-config-keys-still-present (got ' || COUNT(*) || ', expected 3)' AS description
FROM plugin_config;

-- The fixture seeded ONE tmb_defaults_applied event; if bro re-onboards,
-- a SECOND event would land. Count must stay at 1.
SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'tmb_defaults_applied-not-duplicated (got ' || COUNT(*) || ', expected 1)' AS description
FROM ledger
WHERE event_type = 'tmb_defaults_applied';
