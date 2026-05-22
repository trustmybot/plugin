-- 05-swe-atomic-close — covers BOTH dispatch (#14) and SubagentStop bookkeeping (#15).
-- The count-subcommand task left by step 04 stays at status='pending' on
-- purpose (substrate for step 12 resume). Assertions scope to the NEW
-- priority-flag task — that's the one bro created + dispatched + closed
-- this turn.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'tasks created (got ' || COUNT(*) || ', expected >=1)' AS description
FROM tasks;

-- The priority-flag task that bro just dispatched should NOT be pending.
-- (The count task IS pending, but that's deliberate substrate for step 12.)
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'priority-flag task not stuck at pending (got ' || COUNT(*) || ', expected =0) — bro dispatched SWE' AS description
FROM tasks
WHERE status = 'pending'
  AND (LOWER(title) LIKE '%priority%' OR LOWER(branch_id) LIKE '%priority%');

-- SubagentStop hook must record agent_runs at SWE completion.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'agent_runs row count (got ' || COUNT(*) || ', expected >=1)' AS description
FROM agent_runs;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'agent_runs with task_id (got ' || COUNT(*) || ', expected >=1)' AS description
FROM agent_runs
WHERE task_id IS NOT NULL;
