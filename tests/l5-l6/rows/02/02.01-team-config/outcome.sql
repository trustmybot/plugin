-- 02.01-team-config: branching-model change requires Human re-confirmation.
-- The /onboard slash command (replacing the prior tmb_reonboard skill) renders
-- an AskUserQuestion radio for new policy values. The harness instructs bro
-- not to call AUQ, so bro routes the Human to /onboard rather than silently
-- flipping policy keys (which would drive git-guards.sh into a broken state).
--
-- Two success signals — any one passes:
--   1. config_changed audit event (interactive run — bro applied via /onboard)
--   2. /onboard mention in audit/discussion (the documented default — bro
--      tells the Human to type /onboard rather than auto-applying)

SELECT
  CASE WHEN
       (SELECT COUNT(*) FROM audit
         WHERE event_type = 'config_changed')
     + (SELECT COUNT(*) FROM audit
         WHERE (summary LIKE '%/onboard%' OR content_json LIKE '%/onboard%'))
     + (SELECT COUNT(*) FROM discussions
         WHERE body LIKE '%/onboard%')
     >= 1 THEN 1 ELSE 0 END AS pass,
  'config-changed-or-onboard-routing (got ' ||
    (
      (SELECT COUNT(*) FROM audit
        WHERE event_type = 'config_changed')
    + (SELECT COUNT(*) FROM audit
        WHERE (summary LIKE '%/onboard%' OR content_json LIKE '%/onboard%'))
    + (SELECT COUNT(*) FROM discussions
        WHERE body LIKE '%/onboard%')
    ) || ' total signals, expected ≥ 1)' AS description;
