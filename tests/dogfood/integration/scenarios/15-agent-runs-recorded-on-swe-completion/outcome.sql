-- 15-agent-runs-recorded-on-swe-completion — SubagentStop hook must have
-- written at least one row.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'agent_runs row count (got ' || COUNT(*) || ', expected >=1)' AS description
FROM agent_runs;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'agent_runs with task_id (got ' || COUNT(*) || ', expected >=1)' AS description
FROM agent_runs
WHERE task_id IS NOT NULL;
