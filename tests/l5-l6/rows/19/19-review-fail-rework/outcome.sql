-- 19-review-fail-rework — bro reopens the closed count task that pr-reviewer
-- failed, swe reworks it in the same worktree, and a second review lands.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'task_reopened from closed on the count task (got ' || COUNT(*) || ', expected >=1)' AS description
FROM audit
WHERE event_type = 'task_reopened'
  AND branch_id = 'feat/add-count-subcommand'
  AND json_valid(content_json)
  AND json_extract(content_json, '$.from_status') = 'closed';

-- Rework stays on the seeded task: no second count task.
SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'tasks on feat/add-count-subcommand (got ' || COUNT(*) || ', expected =1)' AS description
FROM tasks
WHERE branch_id = 'feat/add-count-subcommand';

-- The seeded swe run plus the rework spawn, all rooted at one worktree path.
SELECT
  CASE WHEN COUNT(*) >= 2 AND COUNT(DISTINCT r.root_dir) = 1 THEN 1 ELSE 0 END AS pass,
  'swe runs on the count task share one worktree (got ' || COUNT(*) || ' runs, '
    || COUNT(DISTINCT r.root_dir) || ' distinct root_dir; expected >=2 runs, 1 root_dir)' AS description
FROM agent_runs r
JOIN tasks t ON t.id = r.task_id
WHERE r.agent_type = 'swe' AND t.branch_id = 'feat/add-count-subcommand';

SELECT
  CASE WHEN COUNT(*) >= 2 THEN 1 ELSE 0 END AS pass,
  'validation rows on the count task (got ' || COUNT(*) || ', expected >=2)' AS description
FROM validation_attempts va
JOIN tasks t ON t.id = va.task_id
WHERE t.branch_id = 'feat/add-count-subcommand';
