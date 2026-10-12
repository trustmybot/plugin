-- 03-multirepo-onboard-scan — acceptance test for #979 + #980.
-- After bro onboards + scans a 2-repo workspace with DISTINCT remotes:
--   (a) scan_run captured each repo's git remote into repo_remotes as its
--       primary remote with the correct provider, and the two repos' remote
--       URLs are DISTINCT (#979);
--   (b) plugin_config holds NONE of the four repo-scoped keys (#980);
--   (c) every repos row carries non-null policy (target_branch +
--       branching_model + protected_branches).

-- (a) repo-a's primary remote is non-blank and classified as github.
SELECT
  CASE WHEN p.provider = 'github' AND length(coalesce(p.url, '')) > 0
       THEN 1 ELSE 0 END AS pass,
  'repo-a remote captured as github with non-blank url (got provider=' ||
    coalesce(p.provider, 'NULL') || ', url=' || coalesce(p.url, 'NULL') || ')' AS description
FROM (SELECT 1) LEFT JOIN repo_remotes p ON p.repo = 'repo-a' AND p.is_primary = 1;

-- (a) repo-b's primary remote is non-blank and classified as gitlab.
SELECT
  CASE WHEN p.provider = 'gitlab' AND length(coalesce(p.url, '')) > 0
       THEN 1 ELSE 0 END AS pass,
  'repo-b remote captured as gitlab with non-blank url (got provider=' ||
    coalesce(p.provider, 'NULL') || ', url=' || coalesce(p.url, 'NULL') || ')' AS description
FROM (SELECT 1) LEFT JOIN repo_remotes p ON p.repo = 'repo-b' AND p.is_primary = 1;

-- (a) the two repos' primary-remote URLs are DISTINCT.
SELECT
  CASE WHEN a.url IS NOT NULL AND b.url IS NOT NULL AND a.url <> b.url
       THEN 1 ELSE 0 END AS pass,
  'repo-a and repo-b remote URLs are distinct (a=' || coalesce(a.url, 'NULL') ||
    ', b=' || coalesce(b.url, 'NULL') || ')' AS description
FROM (SELECT 1)
  LEFT JOIN repo_remotes a ON a.repo = 'repo-a' AND a.is_primary = 1
  LEFT JOIN repo_remotes b ON b.repo = 'repo-b' AND b.is_primary = 1;

-- (b) plugin_config holds NONE of the four repo-scoped keys.
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'plugin_config has none of remotes/pr_target/branching_model/protected_branches (got ' ||
    COUNT(*) || ' such keys)' AS description
FROM plugin_config
WHERE key IN ('remotes', 'pr_target', 'branching_model', 'protected_branches');

-- (c) both seeded repos carry non-null policy on the repos row.
SELECT
  CASE WHEN COUNT(*) = 2 THEN 1 ELSE 0 END AS pass,
  'repo-a + repo-b carry non-null target_branch + branching_model + protected_branches (got ' ||
    COUNT(*) || '/2)' AS description
FROM repos
WHERE name IN ('repo-a', 'repo-b')
  AND target_branch IS NOT NULL
  AND branching_model IS NOT NULL
  AND protected_branches IS NOT NULL;
