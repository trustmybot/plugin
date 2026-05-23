-- 33-multirepo-commit: assert path discipline in a multi-repo workspace.
--
-- Setup: workspace has two inner repos, api/ and app/. tmb_default_repo='api'.
-- Bro runs /scan which populates `directories` per-repo. The asserts catch
-- the recurring "MCP server is workspace-rooted but commit paths are
-- plugin-rooted" bug — bro consistently mis-prefixes paths when it composes
-- them by hand. The path-discipline contract is identical to the pre-v7
-- regime; only the substrate changed.

-- 1. directories has at least one row for repo='api'. Paths are repo-relative.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'api-dirs-indexed (got ' || COUNT(*) || ', expected >=1 for repo=api)' AS description
FROM directories
WHERE repo = 'api';

-- 2. NO directories row uses the workspace-rooted (`api/...` or `app/...`)
--    prefix in `path`. Paths are stored repo-relative; the workspace prefix
--    leaking in means bro composed paths by string-prepending.
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no-workspace-rooted-paths (got ' || COUNT(*) || ', expected 0 — paths starting with api/ or app/ violate the repo-relative storage doctrine)' AS description
FROM directories
WHERE path LIKE 'api/%' OR path LIKE 'app/%';

-- 3. Repo scoping is respected: rows for `app` should never carry api
--    paths (and vice versa). This is the canary for mis-scoped writes.
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no-cross-repo-leak (got ' || COUNT(*) || ', expected 0 — directories rows for repo=api with app/ in path = cross-repo leak)' AS description
FROM directories
WHERE (repo = 'api' AND path LIKE 'app/%')
   OR (repo = 'app' AND path LIKE 'api/%');
