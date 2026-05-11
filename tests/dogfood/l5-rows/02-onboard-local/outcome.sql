-- 02-onboard-local → reonboard intent. User says "make this available on
-- GitLab" + "don't ask questions" — bro should call onboard_state_get
-- (check current state), then onboard_apply with shape='remote' and a
-- GitLab remote. The fixture seeded local-shape values; after bro's
-- apply the `remotes` array should be non-empty.

SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'identity row count (got ' || COUNT(*) || ', expected =1)' AS description
FROM identity;

-- After bro auto-applies in headless mode, remotes should be populated
-- (at minimum one entry; GitLab specifically, but accept any non-empty).
SELECT
  CASE WHEN value_json != '[]' AND value_json IS NOT NULL THEN 1 ELSE 0 END AS pass,
  'plugin_config.remotes is non-empty (got ' || COALESCE(value_json, 'NULL') || ')' AS description
FROM plugin_config
WHERE key = 'remotes';

-- The pre-existing scan audit should survive.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'deep_scan_completed audit row count (got ' || COUNT(*) || ', expected >=1)' AS description
FROM audit
WHERE event_type = 'deep_scan_completed';
