-- 10-architectural-change — bro must write a kind='decision' discussion
-- (universal decision gate). Triage was retired; the only structural
-- requirement is the decision-audit row.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'kind=decision discussion (got ' || COUNT(*) || ', expected >=1)' AS description
FROM discussions
WHERE kind = 'decision';

-- And a task lands (bro called task_provision successfully — gate cleared).
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'tasks created (got ' || COUNT(*) || ', expected >=1)' AS description
FROM tasks;

-- swe run metadata (effort, model, root_dir) must be recorded at SubagentStop.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'completed swe runs (got ' || COUNT(*) || ', expected >=1)' AS description
FROM agent_runs
WHERE agent_type = 'swe' AND completed_at IS NOT NULL;

SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'swe runs missing effort/model/root_dir (got ' || COUNT(*) || ', expected =0)' AS description
FROM agent_runs
WHERE agent_type = 'swe' AND completed_at IS NOT NULL
  AND (effort IS NULL OR model IS NULL OR root_dir IS NULL);
