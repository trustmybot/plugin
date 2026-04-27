-- 01-first-contact outcome assertions
-- Empty DB → @bro hi → bro just greets. Defaults come from schema seed
-- (not bro writes). Identity stays UNSET (no row) until reonboard.
-- Ledger stays empty — schema seeding is silent, no bro decision was made.

SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no-identity-row-on-first-contact (got ' || COUNT(*) || ', expected 0)' AS description
FROM identity;

SELECT
  CASE WHEN COUNT(*) = 1 AND value_json = '"github-flow"' THEN 1 ELSE 0 END AS pass,
  'branching_model-schema-seeded' AS description
FROM plugin_config WHERE key = 'branching_model';

SELECT
  CASE WHEN COUNT(*) = 1 AND value_json = '"main"' THEN 1 ELSE 0 END AS pass,
  'pr_target-schema-seeded' AS description
FROM plugin_config WHERE key = 'pr_target';

SELECT
  CASE WHEN COUNT(*) = 1 AND value_json = '["main"]' THEN 1 ELSE 0 END AS pass,
  'protected_branches-schema-seeded' AS description
FROM plugin_config WHERE key = 'protected_branches';

SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no-ledger-events-from-bro (got ' || COUNT(*) || ', expected 0 — defaults are schema-seeded, no decision to log)' AS description
FROM ledger;
