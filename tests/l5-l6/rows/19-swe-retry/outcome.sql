-- 19-swe-retry: pre-seed has a failed task + concern discussion. Bro should
-- call the task_retry composite (tmb_planning §Step 5 retry path),
-- which emits a task_retry_attempted audit event in the same transaction
-- as the new task insert and the discussion(kind='decision') append.

SELECT
  CASE WHEN COUNT(*) >= 2 THEN 1 ELSE 0 END AS pass,
  'retry-spawned-additional-task (got ' || COUNT(*) || ', expected ≥ 2)' AS description
FROM tasks;

SELECT
  CASE WHEN COUNT(*) >= 2 THEN 1 ELSE 0 END AS pass,
  'discussions-grew-after-retry (got ' || COUNT(*) || ', expected ≥ 2)' AS description
FROM discussions;

-- task_retry composite emits this audit event atomically with the
-- new task insert. Presence proves bro used the composite (not a manual
-- multi-call retry recipe that could drop the audit row).
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'task_retry_attempted-audit-event (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM audit
WHERE event_type='task_retry_attempted';
