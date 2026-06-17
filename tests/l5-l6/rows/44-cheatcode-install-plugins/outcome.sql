-- Outcome assertions for 44-cheatcode-install-plugins. Each row returns
-- (pass, description). The scorer requires every row's pass column to be 1.
--
-- Scope: bro installs BOTH the feature-dev and code-review plugins in local
-- scope. The deterministic proof is (a) two cheatcode_installed audit rows,
-- (b) the two cheatcodes rows (feature-dev + code-review) written scope='local',
-- and (c) the per-agent attachment records — feature-dev → swe, code-review →
-- pr-reviewer. Marketplace results are stubbed via TMB_CHEATCODE_INSTALL_FIXTURE;
-- the install/attachment SHAPE is covered by L2/L3, the per-candidate routing
-- here.

SELECT
  CASE WHEN COUNT(*) >= 2 THEN 1 ELSE 0 END AS pass,
  'two-cheatcode_installed-audit-rows (got ' || COUNT(*) || ')' AS description
FROM audit
WHERE event_type = 'cheatcode_installed'

UNION ALL

SELECT
  CASE WHEN COUNT(*) >= 2 THEN 1 ELSE 0 END AS pass,
  'two-cheatcodes-rows-scope-local (got ' || COUNT(*) || ')' AS description
FROM cheatcodes
WHERE scope = 'local'

UNION ALL

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'feature-dev-cheatcode-row-written (got ' || COUNT(*) || ')' AS description
FROM cheatcodes
WHERE name = 'feature-dev'

UNION ALL

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'code-review-cheatcode-row-written (got ' || COUNT(*) || ')' AS description
FROM cheatcodes
WHERE name = 'code-review'

UNION ALL

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'attachment-target-swe-written (got ' || COUNT(*) || ')' AS description
FROM cheatcode_attachments
WHERE target = 'swe'

UNION ALL

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'attachment-target-pr-reviewer-written (got ' || COUNT(*) || ')' AS description
FROM cheatcode_attachments
WHERE target = 'pr-reviewer';
