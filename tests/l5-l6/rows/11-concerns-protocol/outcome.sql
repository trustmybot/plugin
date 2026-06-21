-- 11-concerns-protocol — bro must surface a concern via a discussion
-- BEFORE any task work landed. Accept any kind (note/question/analysis)
-- as long as the body mentions a concern — bro's phrasing varies.
--
-- The contract halts here: concerns-protocol Path A explicitly stops
-- before SWE dispatch and waits for human alignment. L6 is single-turn
-- per row so the alignment turn never arrives in this harness — bro
-- correctly stays halted. The earlier "task created after alignment"
-- assertion was dropped because it contradicted Path A semantics.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'concern discussion recorded (got ' || COUNT(*) || ', expected >=1)' AS description
FROM discussions
WHERE LOWER(body) LIKE '%concern%';
