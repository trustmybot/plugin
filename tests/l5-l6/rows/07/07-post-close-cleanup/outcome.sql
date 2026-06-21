-- 07-post-close-cleanup — after bro_atomic_close, the post-task-close-rescan
-- hook fires scan_run which refreshes the world model (now in the kuzu graph
-- DB, ADR 0002). The SQLite-side proxy for "world model refresh ran" is the
-- deep_scan_completed audit row. A direct kuzu state check would require
-- querying world-model.kuzu — outside this outcome.sql's scope; covered by
-- the L3 kuzu integration fixture (TBD post-v0.7).

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'deep_scan_completed audit exists post-close (got ' || COUNT(*) || ', expected >=1) — proxy for kuzu refresh via post-close-rescan hook' AS description
FROM audit
WHERE event_type = 'deep_scan_completed';
