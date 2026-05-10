-- 06-issue-resume-across-turns — exactly 1 issue, exactly 1 task. If bro
-- replanned, this would be 2/2.
SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'issue count = 1 (got ' || COUNT(*) || ')' AS description
FROM issues
WHERE id != 999999;

SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'task count = 1 (got ' || COUNT(*) || ')' AS description
FROM tasks;
