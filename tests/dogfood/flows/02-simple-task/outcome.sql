-- Outcome assertions for 02-simple-task. Each row returns (pass, description).
-- The scorer requires every row's pass column to be 1.
--
-- Scope: bro planning phase only. SWE is spawned but does not complete within
-- the L5 window, so post-SWE assertions (file_registry summaries,
-- last_verified_sha) belong in a separate SWE-return flow, not here.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'at-least-one-issue-created (got ' || COUNT(*) || ')' AS description
FROM issues
WHERE LOWER(objective) LIKE '%todo%' OR LOWER(objective) LIKE '%cli%';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'at-least-one-task-created (got ' || COUNT(*) || ')' AS description
FROM tasks;

-- planning_complete is logged in the same batch as the Agent spawn. In some
-- runs the batch succeeds; in others the SWE subagent absorbs the tail of the
-- session before the ledger row lands. Accept either scope_gate_waived
-- (proves planning chain ran) OR planning_complete directly.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'planning-chain-ran (scope_gate_waived or planning_complete got ' || COUNT(*) || ')' AS description
FROM ledger
WHERE event_type IN ('planning_complete', 'scope_gate_waived');
