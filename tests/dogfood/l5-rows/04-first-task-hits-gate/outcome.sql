-- 04-first-task-hits-gate — bro must have run /scan (deep_scan_completed
-- audit row), created at least one task afterward, AND seen SWE work
-- atomically close out (task flipped from pending, agent_runs landed).
--
-- The "atomic-close" assertions were absorbed from the standalone row 5
-- (05-swe-atomic-close) once row 5 was retired from the chain. Without
-- them the chain misses a real bug class: bro spawns SWE, SWE commits,
-- agent_runs lands as completed, but tasks.status stays at 'pending'
-- because bro never called bro_atomic_close (or it failed silently).
-- See workspace-pattern bug bro hit on 2026-05-11 closing task #1.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'deep_scan_completed audit row (got ' || COUNT(*) || ', expected >=1) — bro ran /scan' AS description
FROM audit
WHERE event_type = 'deep_scan_completed';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'tasks created post-scan (got ' || COUNT(*) || ', expected >=1)' AS description
FROM tasks;

-- Atomic-close assertions (absorbed from retired row 5).
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no tasks stuck at pending (got ' || COUNT(*) || ', expected =0) — bro completed the atomic-close' AS description
FROM tasks
WHERE status = 'pending';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'agent_runs row count (got ' || COUNT(*) || ', expected >=1) — SubagentStop hook fired on SWE return' AS description
FROM agent_runs;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'agent_runs with non-null task_id (got ' || COUNT(*) || ', expected >=1) — the hook tied the run to the task' AS description
FROM agent_runs
WHERE task_id IS NOT NULL;
