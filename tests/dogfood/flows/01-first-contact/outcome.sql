-- 01-first-contact outcome assertions
-- Empty DB → @bro hi → bro auto-fires /onboard (because identity row absent)
-- → AUQ denied by headless hook → /onboard halts with headless_reonboard_blocked
-- audit event. No partial write should land.

-- 1. Identity stays empty — /onboard couldn't complete in headless.
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'identity-empty-after-headless-halt (got ' || COUNT(*) || ', expected 0)' AS description
FROM plugin_config WHERE key = 'onboarded';

-- 2. Schema-seeded defaults stayed put (no partial onboard_apply write).
SELECT
  CASE WHEN COUNT(*) = 1 AND value_json = '"github-flow"' THEN 1 ELSE 0 END AS pass,
  'branching_model-still-schema-default' AS description
FROM plugin_config WHERE key = 'branching_model';

SELECT
  CASE WHEN COUNT(*) = 1 AND value_json = '"main"' THEN 1 ELSE 0 END AS pass,
  'pr_target-still-schema-default' AS description
FROM plugin_config WHERE key = 'pr_target';

-- 3. Audit shows /onboard tried to fire — either via the explicit
--    headless_reonboard_blocked event_type, OR a /onboard mention in summary
--    (more permissive — accepts paraphrases bro might emit on the halt path).
SELECT
  CASE WHEN
    (SELECT COUNT(*) FROM audit
      WHERE kind='event' AND event_type='headless_reonboard_blocked')
    + (SELECT COUNT(*) FROM audit
        WHERE kind='event' AND (summary LIKE '%/onboard%' OR content_json LIKE '%/onboard%'))
    >= 1 THEN 1 ELSE 0 END AS pass,
  'auto-fired-onboard-then-blocked-on-headless (got '
    || (SELECT COUNT(*) FROM audit WHERE kind='event' AND event_type='headless_reonboard_blocked')
    || ' headless_reonboard_blocked + '
    || (SELECT COUNT(*) FROM audit WHERE kind='event' AND (summary LIKE '%/onboard%' OR content_json LIKE '%/onboard%'))
    || ' /onboard mentions, expected ≥ 1 total)' AS description;
