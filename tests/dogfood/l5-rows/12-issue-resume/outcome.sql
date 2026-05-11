-- 12-issue-resume — bro must pick up the pre-seeded resume issue/task
-- and NOT replan. Branch-scoped (not absolute-count) so the same
-- assertion works in L5 (clean DB) and L6 chain (cumulative DB).
--
-- The load-bearing "bro didn't replan" signal lives in tools-forbidden
-- (issue_create, task_create_batch). This SQL asserts the pre-seeded
-- resume issue exists as exactly one row — if bro replanned, the seeded
-- issue would still be there PLUS the duplicate, so we check exact count
-- for the seeded objective.

SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'resume issue exists exactly once (got ' || COUNT(*) || ', expected =1)' AS description
FROM issues
WHERE objective = 'Add a CLI entry point (resume)';

SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'resume task on feat/seed-cli exists exactly once (got ' || COUNT(*) || ', expected =1)' AS description
FROM tasks
WHERE branch_id = 'feat/seed-cli';
