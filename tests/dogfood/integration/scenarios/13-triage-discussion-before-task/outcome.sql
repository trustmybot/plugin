-- 13-triage-discussion-before-task — bro must write a Triage note.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'Triage discussion present (got ' || COUNT(*) || ', expected >=1)' AS description
FROM discussions
WHERE kind = 'note' AND body LIKE '%Triage%';

-- And bro should also have captured the Human's verbatim intent.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'intent discussion present (got ' || COUNT(*) || ', expected >=1)' AS description
FROM discussions
WHERE kind = 'intent';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'task created (got ' || COUNT(*) || ', expected >=1)' AS description
FROM tasks;
