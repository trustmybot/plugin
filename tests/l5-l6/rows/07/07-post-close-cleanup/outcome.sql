-- 07-post-close-cleanup — after bro_atomic_close, the post-task-close-rescan
-- hook fires scan_run which refreshes the world model (the wm_ tables in
-- this trajectory.db). The proxy for "world model refresh ran" is the
-- deep_scan_completed audit row; the wm_ row contents are covered by the
-- trajectory-server's world-model unit tests.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'deep_scan_completed audit exists post-close (got ' || COUNT(*) || ', expected >=1) — proxy for the world-model refresh via post-close-rescan hook' AS description
FROM audit
WHERE event_type = 'deep_scan_completed';
