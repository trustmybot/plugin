-- 05.06-base-branch: pr_target='dev' is pre-seeded. The created task's
-- parent_branch_id must reflect that policy, NOT default 'main'.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'task-created (got ' || COUNT(*) || ')' AS description
FROM tasks;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'task-parent_branch_id-equals-dev (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM tasks
WHERE parent_branch_id = 'dev';

SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no-task-fell-back-to-main (got ' || COUNT(*) || ', expected 0)' AS description
FROM tasks
WHERE parent_branch_id = 'main';
