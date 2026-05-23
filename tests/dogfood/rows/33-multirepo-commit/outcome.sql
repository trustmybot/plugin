-- 33-multirepo-commit: assert path discipline in a multi-repo workspace.
--
-- Setup: workspace has two inner repos, api/ and app/. tmb_default_repo='api'.
-- Bro runs /scan which writes Directory nodes per-repo into the sibling kuzu
-- graph DB (ADR 0002). The path-discipline contract — repo-relative paths,
-- repo-scoped writes — is identical to the pre-graph-DB regime; only the
-- substrate changed.
--
-- The kuzu node assertions (api dirs indexed; no workspace-rooted paths;
-- no cross-repo leak) live in the L3 kuzu integration fixture (TBD
-- post-v0.7). Here the SQLite-side assertion verifies the per-repo `repos`
-- table is populated correctly (the deterministic precursor to the kuzu
-- writes), and the deep_scan_completed audit row exists.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'api repo registered in repos table (got ' || COUNT(*) || ', expected >=1)' AS description
FROM repos
WHERE name = 'api';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'deep_scan_completed audit row (got ' || COUNT(*) || ', expected >=1) — scan ran end-to-end' AS description
FROM audit
WHERE event_type = 'deep_scan_completed';
