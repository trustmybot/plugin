-- 07-push-gate — at least one passing validation attempt for the seeded
-- task on feat/seed-todo. Branch-scoped (not id-scoped) so the same
-- assertion works in L5 (clean DB) and L6 chain (cumulative IDs).

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'pr-reviewer signoff for feat/seed-todo task (got ' || COUNT(*) || ', expected ≥1)' AS description
FROM validation_attempts va
JOIN tasks t ON t.id = va.task_id
WHERE t.branch_id = 'feat/seed-todo'
  AND va.verdict = 'pass'
  AND va.agent = 'pr-reviewer';

-- The signoff feedback must start with the load-bearing MCP-availability
-- prefix (#97 — schema CHECK enforces; this assertion is belt-and-suspenders
-- so a regressed feedback is caught at the eval layer too).
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'feedback has MCP-availability prefix (got ' || COUNT(*) || ', expected ≥1)' AS description
FROM validation_attempts va
JOIN tasks t ON t.id = va.task_id
WHERE t.branch_id = 'feat/seed-todo'
  AND (va.feedback LIKE 'MCP available: yes%' OR va.feedback LIKE 'MCP available: no — honor-system fallback%');
