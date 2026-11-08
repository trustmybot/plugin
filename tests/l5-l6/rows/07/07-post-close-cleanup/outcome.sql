-- 07-post-close-cleanup — after bro_atomic_close, the world model (the wm_
-- tables in this trajectory.db) stays warm. The proxy for "a scan ran" is the
-- deep_scan_completed audit row; the wm_ row contents are covered by the
-- trajectory-server's world-model unit tests.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'deep_scan_completed audit exists post-close (got ' || COUNT(*) || ', expected >=1) — proxy for a warm world model' AS description
FROM audit
WHERE event_type = 'deep_scan_completed';
