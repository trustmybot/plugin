-- 09-concerns-protocol — bro must surface a concern via a discussion
-- BEFORE any task work landed. Accept any kind (note/question/analysis)
-- as long as the body mentions a concern — bro's phrasing varies.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'concern discussion recorded (got ' || COUNT(*) || ', expected >=1)' AS description
FROM discussions
WHERE LOWER(body) LIKE '%concern%';

-- After alignment, bro should have dispatched SWE — exactly one task expected.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'task created after alignment (got ' || COUNT(*) || ', expected >=1)' AS description
FROM tasks;
