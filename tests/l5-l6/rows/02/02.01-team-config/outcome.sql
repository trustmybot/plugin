-- 02.01-team-config: branching-model change requires Human re-confirmation.
-- The row proves bro reads state and routes the Human to /onboard without
-- mutating policy: the reonboard-intent hint in prompt-intent-hints.sh supplies
-- the onboard_state_get first action, and the policy keys stay untouched
-- (flipping them silently would drive git-guards.sh into a broken state).

SELECT
  CASE WHEN value_json = '"github-flow"' THEN 1 ELSE 0 END AS pass,
  'branching_model unchanged (got ' || value_json || ', expected "github-flow")' AS description
FROM plugin_config
WHERE key = 'branching_model';

SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no config_changed audit event (got ' || COUNT(*) || ', expected 0)' AS description
FROM audit
WHERE event_type = 'config_changed';
