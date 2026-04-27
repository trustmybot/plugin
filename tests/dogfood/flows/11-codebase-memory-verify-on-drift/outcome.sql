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

-- #181: bro updates file_registry summaries during verification, before
-- closing. The PreToolUse hook denies close if foo.py's row stays at the
-- seeded sentinel md5, so a closed task implies bro refreshed it.
SELECT
  CASE WHEN COUNT(*) = 1 AND content_md5 != '00000000000000000000000000000000' THEN 1 ELSE 0 END AS pass,
  'foo.py-md5-was-refreshed-after-verify (got ' || COALESCE(content_md5,'NULL') || ')' AS description
FROM file_registry WHERE path = 'src/foo.py';

SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no-stale-md5-row-remains (got ' || COUNT(*) || ', expected 0)' AS description
FROM file_registry WHERE path = 'src/foo.py' AND content_md5 = '00000000000000000000000000000000';

-- Planning chain still ran.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'issue-was-created (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM issues;
