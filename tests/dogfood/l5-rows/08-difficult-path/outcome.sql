-- 07-difficult-path-with-adr — bro must record Triage: difficult.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'difficult-path triage recorded (got ' || COUNT(*) || ', expected >=1)' AS description
FROM discussions
WHERE kind = 'note' AND body LIKE '%Triage: difficult%';

-- And at least one decision-class discussion.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'kind=decision discussion (got ' || COUNT(*) || ', expected >=1)' AS description
FROM discussions
WHERE kind = 'decision';
