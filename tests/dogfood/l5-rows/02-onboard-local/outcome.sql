-- 02-onboard-local → reonboard intent recognized, ASK don't auto-apply.
-- User signals "make this available on GitLab" + "Don't ask questions."
-- Bro must call onboard_state_get (check current state) and recommend
-- /onboard in his text response — must NOT call onboard_apply (config
-- rewrites are a Human-driven ceremony; bro recommends the slash and
-- the Human types it).

SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'identity row count (got ' || COUNT(*) || ', expected =1)' AS description
FROM identity;

-- Fixture-seeded local-shape values must be preserved (no auto-apply).
SELECT
  CASE WHEN value_json = '[]' THEN 1 ELSE 0 END AS pass,
  'plugin_config.remotes unchanged (still []) — bro did not auto-apply (got ' || COALESCE(value_json, 'NULL') || ')' AS description
FROM plugin_config
WHERE key = 'remotes';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'deep_scan_completed audit row count (got ' || COUNT(*) || ', expected >=1)' AS description
FROM audit
WHERE event_type = 'deep_scan_completed';
