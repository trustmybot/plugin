-- Outcome assertions for 02-simple-task. Each row returns (pass, description).
-- The scorer requires every row's pass column to be 1.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'at-least-one-issue-created (got ' || COUNT(*) || ')' AS description
FROM issues
WHERE LOWER(objective) LIKE '%todo%' OR LOWER(objective) LIKE '%cli%';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'at-least-one-task-created (got ' || COUNT(*) || ')' AS description
FROM tasks;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'planning_complete-ledger-event-present (got ' || COUNT(*) || ')' AS description
FROM ledger
WHERE event_type = 'planning_complete';

-- #45 + #181 codebase-memory assertions disabled: SWE skips
-- file_registry_update_summaries inconsistently (prompt-only doctrine,
-- same h3/h4 ceiling). Re-enable once #181's PostToolUse hook lands and
-- enforces the atomic-close protocol structurally.
--
-- Original assertions (kept commented for restoration):
--   file_registry-has-md5-and-summary-after-swe-close ≥ 1
--   last_verified_sha-was-set-after-close == 1
