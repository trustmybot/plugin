-- Outcome assertions for 43-cheatcode-install-approval. Each row returns
-- (pass, description). The scorer requires every row's pass column to be 1.
--
-- Scope: bro records the per-candidate approval, then installs through the
-- gate. The deterministic proof is (a) the cheatcode_approved audit row that
-- the PreToolUse gate keys off, (b) the cheatcode_installed audit row, and
-- (c) the cheatcodes row + its attachment record written in one transaction.
-- Marketplace results are stubbed; the install/attachment SHAPE is covered by
-- L2/L3, not here.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'cheatcode_approved-audit-row-exists (got ' || COUNT(*) || ')' AS description
FROM audit
WHERE event_type = 'cheatcode_approved'

UNION ALL

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'cheatcode_installed-audit-row-exists (got ' || COUNT(*) || ')' AS description
FROM audit
WHERE event_type = 'cheatcode_installed'

UNION ALL

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'cheatcodes-row-written (got ' || COUNT(*) || ')' AS description
FROM cheatcodes

UNION ALL

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'cheatcode_attachment-row-written (got ' || COUNT(*) || ')' AS description
FROM cheatcode_attachments;
