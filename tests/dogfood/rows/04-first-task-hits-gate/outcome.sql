-- 04-first-task-hits-gate — bro responds to the registry-cold gate by
-- running /scan, then plans + dispatches via task_create_batch. The
-- prompt is a natural full-feature ask ("make a todo CLI"), so bro
-- typically also spawns SWE + atomic-closes in the same turn — that's
-- not exclusive with step 05 (which adds a feature on top); step 05's
-- assertion just measures its own dispatch + close round trip.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'deep_scan_completed audit row (got ' || COUNT(*) || ', expected >=1) — bro ran /scan' AS description
FROM audit
WHERE event_type = 'deep_scan_completed';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'tasks created post-scan (got ' || COUNT(*) || ', expected >=1)' AS description
FROM tasks;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'repos populated by scan (got ' || COUNT(*) || ', expected >=1)' AS description
FROM repos;

-- Folded from the (now-retired) step 14: the Skill PostToolUse hook
-- (#2886) must record at least one tmb_* skill invocation for the bro
-- agent_run that fired this turn. Bro loads `tmb_planning` and
-- `tmb:agent-create`-adjacent skills during the planning chain, so by
-- the end of this row the hook should have written rows.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'skill_invocations tmb_* rows (got ' || COUNT(*) || ', expected >=1) — folded from retired step 14' AS description
FROM skill_invocations
WHERE skill_name LIKE 'tmb_%';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'agent_runs bro row (got ' || COUNT(*) || ', expected >=1) — folded from retired step 14' AS description
FROM agent_runs
WHERE agent_type = 'bro';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'directories populated post-scan for at least one dir (got ' || COUNT(*) || ', expected >=1) — world model warm' AS description
FROM directories;
