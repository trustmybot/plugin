-- 06-post-close-cleanup — at least one file_registry row at src/auth.py
-- must have a non-null summary. We filter on populated rows because
-- bro's file_registry_update_summaries call may write with a different
-- `repo` value than the fixture pre-seeded, leaving two rows for the
-- same path. The contract is "the summary lands somewhere," not "the
-- pre-seeded row got updated in-place."
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'src/auth.py summary populated (got ' || COUNT(*) || ' row(s) with non-null summary, expected >=1)' AS description
FROM file_registry
WHERE path = 'src/auth.py'
  AND summary IS NOT NULL
  AND summary != '';
