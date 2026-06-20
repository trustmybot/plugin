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

-- The signoff carries the load-bearing MCP-availability signal in the typed
-- mcp_available column (1 = MCP up, 0 = honor-system fallback). The
-- validation_record precondition enforces it at write time; this assertion is
-- belt-and-suspenders so a regressed row is caught at the eval layer too.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'signoff carries typed mcp_available signal (got ' || COUNT(*) || ', expected ≥1)' AS description
FROM validation_attempts va
WHERE va.agent = 'pr-reviewer'
  AND va.verdict = 'pass'
  AND va.mcp_available = 1;
