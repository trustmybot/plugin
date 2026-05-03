-- 05-skill-creation: tmb_skill-creator requires AskUserQuestion. In headless
-- mode (claude -p) the call errors and the skill records a
-- 'headless_creator_blocked' ledger event per tmb_headless-fallback. Both
-- outcomes are valid signals that bro routed to the right skill.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'tmb_skill_created-or-headless_creator_blocked-event (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM audit WHERE kind='event'
  AND event_type IN ('tmb_skill_created', 'headless_creator_blocked');

-- #159 coverage: assert skill_register populated the skills table.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'skills-table-populated (got ' || COUNT(*) || ', expected >= 1)' AS description
FROM skills;
