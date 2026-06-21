-- 01-cold-start — partial-test. Substantive check is in tools-required.json
-- (bro must call onboard_state_get to see first_run=true).
--
-- Test-mode reality: instructed not to ask, bro short-circuits past AUQ
-- rendering and calls onboard_apply with documented defaults — so the
-- identity row may land this turn. Either path (identity=0 if bro stopped at
-- intent OR identity=1 if bro completed with defaults) is acceptable.
SELECT 1 AS pass, 'cold-start: bro initiated onboard chain (asserted via tools-required)' AS description;

SELECT
  CASE WHEN COUNT(*) <= 1 THEN 1 ELSE 0 END AS pass,
  'identity row count (got ' || COUNT(*) || ', expected 0 or 1 — defaults may auto-apply)' AS description
FROM plugin_config WHERE key = 'onboarded';
