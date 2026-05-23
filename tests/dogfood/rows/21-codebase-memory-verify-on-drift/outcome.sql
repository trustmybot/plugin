-- 21-codebase-memory-verify-on-drift (ADR 0002 — world model in kuzu)
-- Pre-state: a v1-summary Directory node exists in kuzu + the README on disk
-- now says v2. On the first code-touching ask, bro plans + dispatches. If/when
-- bro fires scan_run (explicitly or via post-task-close-rescan), the
-- README-derived summary on the repo-root Directory node refreshes to v2.
--
-- The kuzu side is queried directly in the L3 fixture (TBD post-v0.7). Here
-- the SQLite-side assertions verify the planning chain ran end-to-end.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'issue-was-created (got ' || COUNT(*) || ', expected >= 1) — planning ran' AS description
FROM issues;
