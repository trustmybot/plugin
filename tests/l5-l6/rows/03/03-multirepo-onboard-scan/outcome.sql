-- 03-multirepo-onboard-scan — acceptance test for #979 + #980.
-- After bro onboards + scans a 2-repo workspace with DISTINCT remotes:
--   (a) scan_run captured each repo's git remote into repos.remotes with the
--       correct provider, and the two repos' remote URLs are DISTINCT (#979);
--   (b) plugin_config holds NONE of the four repo-scoped keys (#980);
--   (c) every repos row carries non-null policy (target_branch +
--       branching_model + protected_branches).

-- (a) repo-a's remote is non-blank and classified as github.
SELECT
  CASE WHEN json_extract(remotes, '$[0].provider') = 'github'
         AND length(coalesce(json_extract(remotes, '$[0].url'), '')) > 0
       THEN 1 ELSE 0 END AS pass,
  'repo-a remote captured as github with non-blank url (got provider=' ||
    coalesce(json_extract(remotes, '$[0].provider'), 'NULL') ||
    ', url=' || coalesce(json_extract(remotes, '$[0].url'), 'NULL') || ')' AS description
FROM repos WHERE name = 'repo-a';

-- (a) repo-b's remote is non-blank and classified as gitlab.
SELECT
  CASE WHEN json_extract(remotes, '$[0].provider') = 'gitlab'
         AND length(coalesce(json_extract(remotes, '$[0].url'), '')) > 0
       THEN 1 ELSE 0 END AS pass,
  'repo-b remote captured as gitlab with non-blank url (got provider=' ||
    coalesce(json_extract(remotes, '$[0].provider'), 'NULL') ||
    ', url=' || coalesce(json_extract(remotes, '$[0].url'), 'NULL') || ')' AS description
FROM repos WHERE name = 'repo-b';

-- (a) the two repos' first-remote URLs are DISTINCT.
SELECT
  CASE WHEN a.url IS NOT NULL AND b.url IS NOT NULL AND a.url <> b.url
       THEN 1 ELSE 0 END AS pass,
  'repo-a and repo-b remote URLs are distinct (a=' || coalesce(a.url, 'NULL') ||
    ', b=' || coalesce(b.url, 'NULL') || ')' AS description
FROM
  (SELECT json_extract(remotes, '$[0].url') AS url FROM repos WHERE name = 'repo-a') a,
  (SELECT json_extract(remotes, '$[0].url') AS url FROM repos WHERE name = 'repo-b') b;

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
