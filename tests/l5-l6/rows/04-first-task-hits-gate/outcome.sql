-- 04-first-task-hits-gate — bro responds to the registry-cold gate by
-- running /scan, then plans + dispatches via task_provision. The
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

-- bro's `tmb_planning` usage for this row is asserted from the stream-json
-- run log via the `usage` scorer (outcome-usage.json), not skill_invocations
-- — that table is retiring (#118/#119).

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'agent_runs bro row (got ' || COUNT(*) || ', expected >=1) — folded from retired step 14' AS description
FROM agent_runs
WHERE agent_type = 'bro';

-- World model lives in the sibling kuzu graph DB post-ADR 0002, not in
-- this SQLite trajectory.db. The deep_scan_completed audit row above is
-- the SQLite-side proxy for "scan ran successfully → kuzu graph warm."
-- A direct kuzu state check would require querying world-model.kuzu —
-- outside this outcome.sql's scope; covered by the L3 kuzu integration
-- fixture (TBD post-v0.7).
