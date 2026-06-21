-- 12-issue-resume — bro picks up the pre-existing "count subcommand" task
-- (planned by step 04 in chain; pre-seeded by setup-l5 in isolation) and
-- dispatches SWE without re-planning.
--
-- The load-bearing "didn't replan" signal lives in tools-forbidden
-- (issue_create, task_provision). This SQL asserts the existing
-- count-subcommand task remains intact + was actually picked up.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'count-subcommand task exists in DB (got ' || COUNT(*) || ', expected >=1)' AS description
FROM tasks
WHERE LOWER(title) LIKE '%count%' OR LOWER(branch_id) LIKE '%count%';

-- The task moved out of pending — bro dispatched SWE which either
-- atomic-closed it or left it in_progress.
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'count-subcommand task no longer pending (got ' || COUNT(*) || ', expected =0) — bro dispatched it' AS description
FROM tasks
WHERE (LOWER(title) LIKE '%count%' OR LOWER(branch_id) LIKE '%count%')
  AND status = 'pending';
