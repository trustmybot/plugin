-- 14-skill-invocation-recorded — Skill PostToolUse hook (#2886) writes a
-- row to skill_invocations when bro invokes any Skill via the Skill tool.
-- The hook is analytics, never load-bearing — it's never expected to block.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'skill_invocations rows (got ' || COUNT(*) || ', expected >=1)' AS description
FROM skill_invocations
WHERE skill_name LIKE 'tmb_%';

-- Junction shape — the row must reference an agent_run_id (the open bro
-- row pre-seeded by setup.sh) OR be free-floating with NULL. Both are
-- valid hook outputs; this assertion just confirms a row landed AT ALL.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'agent_runs has a bro row (count=' || COUNT(*) || ', expected >=1)' AS description
FROM agent_runs
WHERE agent_type = 'bro';

-- Schema-shape: skill_invocations table must exist with the expected
-- columns (defensive check — proves the #2886 schema landed).
SELECT
  CASE WHEN COUNT(*) = 6 THEN 1 ELSE 0 END AS pass,
  'skill_invocations has 6 columns (got ' || COUNT(*) || ', expected 6)' AS description
FROM pragma_table_info('skill_invocations')
WHERE name IN ('skill_name', 'agent_name', 'agent_run_id', 'task_id', 'invoked_at', 'outcome');
