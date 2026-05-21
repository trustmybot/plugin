-- 04-first-task-hits-gate — bro must respond to the registry-cold gate by
-- running /scan, then planning (issue + task_create_batch). Step 5 owns
-- the SWE dispatch + atomic-close — this row deliberately stops short of
-- that to keep the two tests mutually exclusive (the prompt explicitly
-- tells bro to NOT dispatch this turn).

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
