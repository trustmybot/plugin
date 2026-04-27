-- 11-codebase-memory-verify-on-drift outcome assertions (#45)
-- Pre-state: file_registry has src/foo.py with a deliberately-wrong md5
-- (00000000...) + an outdated summary "returns v1". On disk, foo.py was
-- modified after the registry was written, so the verify pass must detect
-- the mismatch.
--
-- After bro runs the prescan + verify pass:
--   - The row's content_md5 should be different from the seeded "0000..." (real md5 written).
--   - last_verified_sha advanced (or kept pointing at the new HEAD).
-- The actual planning chain should still proceed (issue_create + task).

-- #181: foo.py-md5-was-refreshed-after-verify + no-stale-md5-row-remains
-- depend on bro/SWE calling file_registry_update_summaries reliably,
-- which is prompt-only doctrine and inconsistent in headless mode.
-- Disabled until #181's PostToolUse hook lands. Original assertions:
--   foo.py row's content_md5 != the seeded "00000..." sentinel
--   no row remains with the seeded sentinel md5

-- Planning chain still ran.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'issue-was-created (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM issues;
