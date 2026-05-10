-- 11-file-registry-summary-after-read — after the run, the file_registry
-- row at src/auth.py must have a non-null summary.
SELECT
  CASE WHEN summary IS NOT NULL AND summary != '' THEN 1 ELSE 0 END AS pass,
  'src/auth.py summary populated (got "' || COALESCE(SUBSTR(summary, 1, 60), 'NULL') || '...")' AS description
FROM file_registry
WHERE path = 'src/auth.py';
