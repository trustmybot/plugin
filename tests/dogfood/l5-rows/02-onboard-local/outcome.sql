-- 02-onboard-local — fixture-seeded local-shape state must look right.
SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'identity row count (got ' || COUNT(*) || ', expected =1)' AS description
FROM identity;

SELECT
  CASE WHEN value = '"github-flow"' THEN 1 ELSE 0 END AS pass,
  'plugin_config.branching_model = "github-flow" (got ' || COALESCE(value, 'NULL') || ')' AS description
FROM plugin_config
WHERE key = 'branching_model';

SELECT
  CASE WHEN value = '"main"' THEN 1 ELSE 0 END AS pass,
  'plugin_config.pr_target = "main" (got ' || COALESCE(value, 'NULL') || ')' AS description
FROM plugin_config
WHERE key = 'pr_target';

SELECT
  CASE WHEN value = '[]' THEN 1 ELSE 0 END AS pass,
  'plugin_config.remotes = [] (got ' || COALESCE(value, 'NULL') || ')' AS description
FROM plugin_config
WHERE key = 'remotes';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'deep_scan_completed audit row count (got ' || COUNT(*) || ', expected >=1)' AS description
FROM audit
WHERE event_type = 'deep_scan_completed';
