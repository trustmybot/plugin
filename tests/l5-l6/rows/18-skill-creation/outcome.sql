-- 18-skill-creation: tmb_skill-creator requires AskUserQuestion. The test
-- harness instructs bro not to call AUQ and to take the documented default;
-- for skill-creator the documented default is to HALT (file writes need Human
-- approval) and record a scoping audit/issue. So a valid pass is either the
-- skill landing OR bro halting with a creator-blocked audit event.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'tmb_skill_created-or-creator_blocked-event (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM audit
  WHERE event_type = 'tmb_skill_created'
     OR event_type LIKE '%creator_blocked%';

-- #159 coverage: assert skill_register populated a cheatcodes skill row OR
-- bro correctly HALTed and recorded a creator-blocked audit event.
SELECT
  CASE WHEN (SELECT COUNT(*) FROM cheatcodes WHERE kind='skill') +
            (SELECT COUNT(*) FROM audit
              WHERE event_type LIKE '%creator_blocked%') >= 1
       THEN 1 ELSE 0 END AS pass,
  'skill-created-or-halted (skills=' ||
    (SELECT COUNT(*) FROM cheatcodes WHERE kind='skill') || ', halt-events=' ||
    (SELECT COUNT(*) FROM audit
      WHERE event_type LIKE '%creator_blocked%') ||
    ', expected ≥ 1 of either)' AS description;
