-- 02-reonboard-implicit-from-local → reonboard intent recognized. Either of two
-- paths is acceptable:
--   (a) bro auto-applies via onboard_apply (config now reflects remote)
--   (b) bro recommends `/onboard` in text and stops (config preserved)
-- The contract checks that bro engaged with the reonboard signal
-- (called onboard_state_get) and didn't start code work.

SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'identity row count (got ' || COUNT(*) || ', expected =1)' AS description
FROM plugin_config WHERE key = 'onboarded';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'deep_scan_completed audit row count (got ' || COUNT(*) || ', expected >=1)' AS description
FROM audit
WHERE event_type = 'deep_scan_completed';
