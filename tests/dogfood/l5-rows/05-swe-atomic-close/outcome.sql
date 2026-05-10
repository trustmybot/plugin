-- 05-swe-atomic-close — covers BOTH dispatch (#14) and SubagentStop bookkeeping (#15).
-- (1) bro must spawn SWE after task_create_batch — tasks should not stay pending.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'tasks created (got ' || COUNT(*) || ', expected >=1)' AS description
FROM tasks;

SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no tasks stuck at pending (got ' || COUNT(*) || ', expected =0) — bro dispatched SWE' AS description
FROM tasks
WHERE status = 'pending';

-- (2) SubagentStop hook must record agent_runs at SWE completion.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'agent_runs row count (got ' || COUNT(*) || ', expected >=1)' AS description
FROM agent_runs;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'agent_runs with task_id (got ' || COUNT(*) || ', expected >=1)' AS description
FROM agent_runs
WHERE task_id IS NOT NULL;
