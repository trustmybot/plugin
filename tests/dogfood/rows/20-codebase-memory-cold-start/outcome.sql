-- 20-codebase-memory-cold-start (ADR 0001 — world-model rewrite of #45)
-- Existing repo + identity present + world model cold + headless mode.
-- Bro must self-fire scan_run (no Human to ask) before task_create_batch
-- because the server-enforced world-model-cold gate would otherwise block.
-- After scan, planning + dispatch proceeds normally.

-- Bro MUST have run a deep scan in headless to clear the cold gate.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'deep_scan_completed audit row (got ' || COUNT(*) || ', expected >=1) — bro self-fired scan_run in headless' AS description
FROM audit WHERE event_type = 'deep_scan_completed';

-- The world model substrate must be populated post-scan.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'directories row populated post-scan (got ' || COUNT(*) || ', expected >=1)' AS description
FROM directories;

-- Bro proceeds with planning after the scan.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'issue-was-created-after-scan (got ' || COUNT(*) || ', expected >= 1)' AS description
FROM issues;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'task-was-created-after-scan (got ' || COUNT(*) || ', expected >= 1)' AS description
FROM tasks;
