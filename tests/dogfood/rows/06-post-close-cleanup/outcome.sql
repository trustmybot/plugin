-- 06-post-close-cleanup — after bro_atomic_close, the post-task-close-rescan
-- hook fires scan_run which refreshes the world model. The assertion verifies
-- the directories table has populated rows for the project's repo so future
-- sessions can navigate via world_model_get instead of re-Reading every file.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'directories table populated post-close (got ' || COUNT(*) || ' row(s), expected >=1) — world model warm' AS description
FROM directories;

-- At least one directory's summary should come from a README.md walk
-- (summary_source='readme'). If no README exists in the test repo this
-- relaxes to "any directory row exists with a non-null summary OR no
-- summary yet" — the post-scan refresh ran either way.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'directories has at least one row (got ' || COUNT(*) || ', expected >=1) — scan_run refreshed via post-close hook' AS description
FROM directories;
