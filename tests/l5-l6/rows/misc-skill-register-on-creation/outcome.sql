-- skill-register-on-creation — #2853 coverage. Bro asked to create a
-- project-local skill, must invoke `tmb_skill-creator` which writes the
-- new skill via `skill_register`. The assertion is that at least one
-- new row landed in `skills` beyond the 8 schema-seeded `tmb_*` rows.
--
-- scope='project-local' is the canonical mark for skills registered by bro
-- via tmb_skill-creator — the seeded tmb_* rows carry scope='global'.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'skills row with scope=project-local (got ' || COUNT(*) || ', expected >=1) — #2853' AS description
FROM skills
WHERE scope = 'project-local';
