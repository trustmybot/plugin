-- 42-typed-rails (#673): a code-touching ask flows through task_provision.
-- The created task row must carry the typed files/verification columns, and
-- each must hold a valid JSON array (the typed-field contract). Pre-migration
-- markdown scraping is gone; files/verification are columns, not spec_body prose.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'task-created (got ' || COUNT(*) || ', expected >= 1)' AS description
FROM tasks;

-- Every created task has a files column holding a JSON array (default '[]' or
-- a non-empty array bro emitted). json_type returns 'array' for both.
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'all-tasks-have-json-array-files (non-array rows: ' || COUNT(*) || ', expected 0)' AS description
FROM tasks
WHERE json_valid(files) = 0 OR json_type(files) <> 'array';

-- Same contract for verification.
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'all-tasks-have-json-array-verification (non-array rows: ' || COUNT(*) || ', expected 0)' AS description
FROM tasks
WHERE json_valid(verification) = 0 OR json_type(verification) <> 'array';
