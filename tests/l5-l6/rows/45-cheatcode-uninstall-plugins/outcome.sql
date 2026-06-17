-- Outcome assertions for 45-cheatcode-uninstall-plugins. Each row returns
-- (pass, description). The scorer requires every row's pass column to be 1.
--
-- Scope: setup-l5.sh pre-seeds two installed plugins (feature-dev → swe,
-- code-review → pr-reviewer). bro tears both down. The deterministic proof is
-- (a) two cheatcode_uninstalled audit rows, (b) both cheatcodes rows gone
-- (COUNT=0 by name), and (c) their attachment rows gone (the install + teardown
-- reverse each attachment via the marketplace path). Marketplace results are
-- stubbed via TMB_CHEATCODE_UNINSTALL_FIXTURE; the teardown SHAPE is covered by
-- L2/L3, the journey-level reversal here.

SELECT
  CASE WHEN COUNT(*) >= 2 THEN 1 ELSE 0 END AS pass,
  'two-cheatcode_uninstalled-audit-rows (got ' || COUNT(*) || ')' AS description
FROM audit
WHERE event_type = 'cheatcode_uninstalled'

UNION ALL

SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'feature-dev-cheatcode-row-gone (got ' || COUNT(*) || ')' AS description
FROM cheatcodes
WHERE name = 'feature-dev'

UNION ALL

SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'code-review-cheatcode-row-gone (got ' || COUNT(*) || ')' AS description
FROM cheatcodes
WHERE name = 'code-review'

UNION ALL

SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'feature-dev-attachment-gone (got ' || COUNT(*) || ')' AS description
FROM cheatcode_attachments
WHERE target = 'swe'

UNION ALL

SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'code-review-attachment-gone (got ' || COUNT(*) || ')' AS description
FROM cheatcode_attachments
WHERE target = 'pr-reviewer';
