-- 02-push-gate-with-pr-reviewer-signoff — at least one passing validation
-- attempt for the seeded task (id=1).

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'pr-reviewer signoff for task 1 (got ' || COUNT(*) || ', expected ≥1)' AS description
FROM validation_attempts
WHERE task_id = 1 AND verdict = 'pass' AND agent = 'pr-reviewer';

-- The signoff feedback must start with the load-bearing MCP-availability
-- prefix (#97 — schema CHECK enforces; this assertion is belt-and-suspenders
-- so a regressed feedback is caught at the eval layer too).
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'feedback has MCP-availability prefix (got ' || COUNT(*) || ', expected ≥1)' AS description
FROM validation_attempts
WHERE task_id = 1
  AND (feedback LIKE 'MCP available: yes%' OR feedback LIKE 'MCP available: no — honor-system fallback%');
