-- 05-concerns-protocol-on-test-edit — bro must have written a concern note
-- BEFORE any task work landed.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'concern note recorded (got ' || COUNT(*) || ', expected >=1)' AS description
FROM discussions
WHERE kind = 'note' AND body LIKE '%Concern:%';

-- After alignment, bro should have dispatched SWE — exactly one task expected.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'task created after alignment (got ' || COUNT(*) || ', expected >=1)' AS description
FROM tasks;
