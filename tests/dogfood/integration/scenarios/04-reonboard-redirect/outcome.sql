-- 04-reonboard-redirect — branching_model must still be 'github-flow' (the
-- default seeded by the schema). If bro auto-fired onboard_apply with
-- gitflow, this row would be mutated.

SELECT
  CASE WHEN value_json = '"github-flow"' THEN 1 ELSE 0 END AS pass,
  'branching_model unchanged (got ' || value_json || ', expected "github-flow")' AS description
FROM plugin_config
WHERE key = 'branching_model';

-- Identity table still has exactly one row — the onboarded marker.
SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'identity row count = 1 (got ' || COUNT(*) || ')' AS description
FROM identity;
