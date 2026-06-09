-- skill-register-on-creation — #2853 coverage. Bro asked to create a
-- project-local skill, must invoke `tmb_skill-creator` which writes the
-- new skill via `skill_register`. The assertion is that at least one
-- new row landed in `skills` beyond the 8 schema-seeded `tmb_*` rows.
--
-- created_by='bro' is the canonical mark for skills registered by bro
-- mid-session — the seeded rows carry `created_by='system'`. Filtering
-- on `created_by != 'system'` keeps the assertion robust to future
-- changes in the seed list.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'skills row created by bro (got ' || COUNT(*) || ', expected >=1) — #2853' AS description
FROM skills
WHERE created_by != 'system';
