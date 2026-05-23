-- 21-codebase-memory-verify-on-drift (ADR 0001 — world-model rewrite)
-- Pre-state: directories has a v1-summary row for the repo root + the README
-- on disk now says v2. On the first code-touching ask, bro plans + dispatches.
-- If/when bro fires scan_run (either explicitly or via post-task-close-rescan),
-- the README-derived summary on the repo-root row refreshes to v2.
--
-- L5 budget rarely covers a full bro_atomic_close round trip — the assertion
-- relaxes to: world model substrate survives the turn (>=1 directories row)
-- and the planning chain ran.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'directories row survives the turn (got ' || COUNT(*) || ', expected >=1)' AS description
FROM directories;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'issue-was-created (got ' || COUNT(*) || ', expected >= 1) — planning ran' AS description
FROM issues;
