-- 14-swe-spawn-required-after-task-create — tasks must advance past pending.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'tasks created (got ' || COUNT(*) || ', expected >=1)' AS description
FROM tasks;

SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'no tasks stuck at pending (got ' || COUNT(*) || ', expected =0) — bro dispatched SWE' AS description
FROM tasks
WHERE status = 'pending';
