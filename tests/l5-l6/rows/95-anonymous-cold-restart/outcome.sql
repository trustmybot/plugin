-- 95 outcome: state must be UNCHANGED from pre-fixture (bro reads, doesn't write).
-- Fixture seeded the identity row (onboarded marker — no name stored). Bro
-- reads onboard_state_get + issue_resume, sees onboarded=true,
-- emits the welcome banner without re-firing /onboard.

SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'identity-row-count-unchanged (got ' || COUNT(*) || ', expected 1)' AS description
FROM plugin_config WHERE key = 'onboarded';

-- Identity row presence is the onboarded marker — that's it. No name field
-- to assert anything about.
SELECT
  CASE WHEN COUNT(*) >= 5 THEN 1 ELSE 0 END AS pass,
  'config-keys-still-present (schema-seeded; got ' || COUNT(*) || ', expected ≥5)' AS description
FROM plugin_config;

-- Bro reads, writes nothing on a casual greeting. The fixture seeds a
-- deep_scan_completed audit row (world-model-warm proxy); bro must not add
-- any NEW bro-authored audit events beyond it.
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no-new-bro-audit-events (got ' || COUNT(*) || ', expected 0)' AS description
FROM audit WHERE from_node = 'bro' AND event_type <> 'deep_scan_completed';
