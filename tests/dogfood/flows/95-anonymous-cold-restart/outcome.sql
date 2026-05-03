-- 95 outcome: state must be UNCHANGED from pre-fixture (bro reads, doesn't write).
-- Fixture seeded the deliberately-blank identity row; bro reads identity_get +
-- issue_resume + emits the welcome banner. No DB writes.

SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'identity-row-count-unchanged (got ' || COUNT(*) || ', expected 1)' AS description
FROM identity;

SELECT
  CASE WHEN COUNT(*) = 1 AND human_name IS NULL THEN 1 ELSE 0 END AS pass,
  'identity-still-anonymous (human_name should be NULL)' AS description
FROM identity;

SELECT
  CASE WHEN COUNT(*) >= 5 THEN 1 ELSE 0 END AS pass,
  'five-config-keys-still-present (schema-seeded; got ' || COUNT(*) || ', expected ≥5)' AS description
FROM plugin_config;

-- Bro must not write any ledger events on a casual greeting.
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no-ledger-events (got ' || COUNT(*) || ', expected 0)' AS description
FROM audit WHERE kind='event';
