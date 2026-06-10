-- 08-architectural-change — bro must write a kind='decision' discussion
-- (universal decision gate). Triage was retired; the only structural
-- requirement is the decision-audit row.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'kind=decision discussion (got ' || COUNT(*) || ', expected >=1)' AS description
FROM discussions
WHERE kind = 'decision';

-- And a task lands (bro called task_create_batch successfully — gate cleared).
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'tasks created (got ' || COUNT(*) || ', expected >=1)' AS description
FROM tasks;
