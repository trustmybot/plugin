-- 33-multirepo-commit: assert path discipline in a multi-repo workspace.
--
-- Setup: workspace has two inner repos, api/ and app/. tmb_default_repo='api'.
-- Bro indexes api/ into file_registry. The asserts below catch the recurring
-- "MCP server is workspace-rooted but commit paths are plugin-rooted" bug
-- documented during the #181 review — bro consistently mis-prefixes paths
-- when it composes them by hand.

-- 1. file_registry has rows for api source files (handler.py, utils.py).
--    These should land as REPO-RELATIVE paths.
SELECT
  CASE WHEN COUNT(*) >= 2 THEN 1 ELSE 0 END AS pass,
  'api-files-indexed (got ' || COUNT(*) || ', expected ≥ 2 for handler.py + utils.py)' AS description
FROM file_registry
WHERE path IN ('handler.py', 'utils.py');

-- 2. NO row uses the workspace-rooted (`api/...`) prefix. This is the
--    canary: if bro composed paths by string-prepending the repo dir
--    instead of treating file_registry as repo-scoped, this fails.
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no-workspace-rooted-paths (got ' || COUNT(*) || ', expected 0 — paths starting with api/ or app/ violate the repo-relative storage doctrine)' AS description
FROM file_registry
WHERE path LIKE 'api/%' OR path LIKE 'app/%';

-- 3. NO row points at the OTHER inner repo (app/). bro was told to index
--    api/, not app/.
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no-cross-repo-leak (got ' || COUNT(*) || ', expected 0 — files from app/ should not appear in this index pass)' AS description
FROM file_registry
WHERE path LIKE '%index.ts%';
