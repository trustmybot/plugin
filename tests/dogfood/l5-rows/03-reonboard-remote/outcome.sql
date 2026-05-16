-- 03-reonboard-remote — partial-test. Substantive check lives in
-- tools-required.json (onboard_state_get + onboard_get_questions).
SELECT 1 AS pass, 'reonboard: bro re-initiated onboard chain (asserted via tools-required)' AS description;

-- Confirm bro did NOT create a duplicate identity row.
SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'identity row count (got ' || COUNT(*) || ', expected =1 — no duplicate)' AS description
FROM plugin_config WHERE key = 'onboarded';
