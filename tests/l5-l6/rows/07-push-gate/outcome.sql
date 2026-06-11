-- 07-push-gate — at least one passing pr-reviewer validation_attempt exists
-- on some task. Both L5 (where setup-l5.sh pre-seeds feat/seed-todo) and L6
-- chain (where bro pushes a task organically created by step 05's SWE work)
-- satisfy: bro ran the push gate, pr-reviewer signed off on a real task.
-- Branch-name-agnostic so the assertion does not depend on which
-- particular task bro chose to push.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'pr-reviewer signoff on some task (got ' || COUNT(*) || ', expected ≥1)' AS description
FROM validation_attempts va
WHERE va.verdict = 'pass'
  AND va.agent = 'pr-reviewer'
  AND va.task_id IS NOT NULL;

-- The signoff feedback must start with the load-bearing MCP-availability
-- prefix (#97 — schema CHECK enforces; this assertion is belt-and-suspenders
-- so a regressed feedback is caught at the eval layer too).
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'feedback has MCP-availability prefix (got ' || COUNT(*) || ', expected ≥1)' AS description
FROM validation_attempts va
WHERE va.agent = 'pr-reviewer'
  AND va.verdict = 'pass'
  AND (va.feedback LIKE 'MCP available: yes%' OR va.feedback LIKE 'MCP available: no — honor-system fallback%');
