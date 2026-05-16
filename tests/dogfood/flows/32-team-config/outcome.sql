-- 32-team-config: branching-model change requires Human re-confirmation.
-- The /onboard slash command (replacing the prior tmb_reonboard skill) renders
-- an AskUserQuestion radio for new policy values. In headless mode the AUQ
-- errors and bro routes the Human to /onboard rather than silently flipping
-- policy keys (which would drive git-guards.sh into a broken state).
--
-- Three success signals — any one passes:
--   1. config_changed audit event (interactive run — bro applied via /onboard)
--   2. headless_reonboard_blocked (legacy event from the prior tmb_reonboard
--      skill; still acceptable if any project bundles a thin reonboard skill)
--   3. /onboard mention in audit/discussion (post-consolidation default —
--      bro tells the Human to type /onboard rather than auto-applying)

SELECT
  CASE WHEN
       (SELECT COUNT(*) FROM audit
         WHERE kind='event'
           AND event_type IN ('config_changed', 'headless_reonboard_blocked'))
     + (SELECT COUNT(*) FROM audit
         WHERE kind='event'
           AND (summary LIKE '%/onboard%' OR content_json LIKE '%/onboard%'))
     + (SELECT COUNT(*) FROM discussions
         WHERE body LIKE '%/onboard%')
     >= 1 THEN 1 ELSE 0 END AS pass,
  'config-changed-or-headless-block-or-onboard-routing (got ' ||
    (
      (SELECT COUNT(*) FROM audit
        WHERE kind='event'
          AND event_type IN ('config_changed', 'headless_reonboard_blocked'))
    + (SELECT COUNT(*) FROM audit
        WHERE kind='event'
          AND (summary LIKE '%/onboard%' OR content_json LIKE '%/onboard%'))
    + (SELECT COUNT(*) FROM discussions
        WHERE body LIKE '%/onboard%')
    ) || ' total signals, expected ≥ 1)' AS description;
