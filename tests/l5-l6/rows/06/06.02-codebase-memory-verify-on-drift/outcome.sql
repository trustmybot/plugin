-- 06.02-codebase-memory-verify-on-drift (world model in the wm_ tables)
-- Pre-state: a v1-summary wm_directories row exists + the README on disk
-- now says v2. On the first code-touching ask, bro plans + dispatches. If/when
-- bro fires scan_run (explicitly or via post-task-close-rescan), the
-- README-derived summary on the repo-root wm_directories row refreshes to v2.
--
-- The wm_ row contents are covered by the trajectory-server's world-model
-- unit tests. Here the assertions verify the planning chain ran end-to-end.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'issue-was-created (got ' || COUNT(*) || ', expected >= 1) — planning ran' AS description
FROM issues;
