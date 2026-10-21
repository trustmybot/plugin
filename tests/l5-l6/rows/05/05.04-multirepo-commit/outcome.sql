-- 05.04-multirepo-commit: assert path discipline in a multi-repo workspace.
--
-- Setup: workspace has two inner repos, api/ and app/, each registered by path
-- in the `repos` table (path-keyed resolution — docs/architecture/REPO_RESOLUTION.md).
-- Bro runs /scan which writes wm_directories rows per repo into the
-- trajectory DB. The path-discipline contract — repo-relative paths,
-- repo-scoped writes — is identical across world-model substrates.
--
-- The wm_ row assertions (api dirs indexed; no workspace-rooted paths;
-- no cross-repo leak) live in the trajectory-server's world-model unit
-- tests. Here the SQLite-side assertion verifies both inner repos are
-- registered by path in the `repos` table (the registration that scopes
-- resolution + the precursor to the wm_ writes), and the deep_scan_completed
-- audit row exists.

SELECT
  CASE WHEN COUNT(*) >= 2 THEN 1 ELSE 0 END AS pass,
  'api + app repos registered by path in repos table (got ' || COUNT(*) || ', expected >=2)' AS description
FROM repos
WHERE name IN ('api', 'app') AND path IS NOT NULL AND path != '';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'deep_scan_completed audit row (got ' || COUNT(*) || ', expected >=1) — scan ran end-to-end' AS description
FROM audit
WHERE event_type = 'deep_scan_completed';
