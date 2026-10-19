-- 16-concurrent-tasks — bro splits two independent asks (count subcommand,
-- list --json) into two tasks on distinct branches and dispatches a swe for
-- each. The runner sees one bro turn (max_turns 1), so both spawns landing
-- in this run is the "same turn" proxy.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'count task and --json task on distinct branches (got ' || COUNT(*) || ' pairs, expected >=1)' AS description
FROM tasks c
JOIN tasks j ON j.id <> c.id AND j.branch_id <> c.branch_id
WHERE (LOWER(c.title) LIKE '%count%' OR LOWER(c.branch_id) LIKE '%count%')
  AND (LOWER(j.title) LIKE '%json%' OR LOWER(j.branch_id) LIKE '%json%');

-- task_provision writes one planning_complete row per task it creates.
SELECT
  CASE WHEN COUNT(DISTINCT branch_id) >= 2 THEN 1 ELSE 0 END AS pass,
  'planning_complete on distinct branches (got ' || COUNT(DISTINCT branch_id) || ', expected >=2)' AS description
FROM audit
WHERE event_type = 'planning_complete' AND branch_id IS NOT NULL;

-- record-swe-spawn.sh inserts a swe agent_runs row only after every spawn
-- gate passed, so two tasks with a swe row means two spawns went through.
SELECT
  CASE WHEN COUNT(DISTINCT task_id) >= 2 THEN 1 ELSE 0 END AS pass,
  'tasks with a swe spawn (got ' || COUNT(DISTINCT task_id) || ', expected >=2)' AS description
FROM agent_runs
WHERE agent_type = 'swe' AND task_id IS NOT NULL;
