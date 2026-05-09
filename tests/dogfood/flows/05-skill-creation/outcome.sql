-- 05-skill-creation: tmb_skill-creator requires AskUserQuestion. In headless
-- mode (claude -p) the call errors and the skill records a
-- 'headless_creator_blocked' audit event per tmb_recovery §A. Both
-- outcomes are valid signals that bro routed to the right skill.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'tmb_skill_created-or-headless_creator_blocked-event (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM audit WHERE kind='event'
  AND event_type IN ('tmb_skill_created', 'headless_creator_blocked');

-- #159 coverage: assert skill_register populated the skills table OR bro
-- correctly HALTed in headless mode (in which case no skill is written by
-- design — see tmb_skill-creator skill body "Headless mode — HALT" section).
SELECT
  CASE WHEN (SELECT COUNT(*) FROM skills) +
            (SELECT COUNT(*) FROM audit
              WHERE kind='event' AND event_type='headless_creator_blocked') >= 1
       THEN 1 ELSE 0 END AS pass,
  'skill-created-or-headless-halted (skills=' ||
    (SELECT COUNT(*) FROM skills) || ', halt-events=' ||
    (SELECT COUNT(*) FROM audit
      WHERE kind='event' AND event_type='headless_creator_blocked') ||
    ', expected ≥ 1 of either)' AS description;
