-- 11-concerns-protocol — bro must surface a concern via a discussion
-- BEFORE any task work landed. Accept any kind (note/question/analysis)
-- as long as the body mentions a concern — bro's phrasing varies.
--
-- The prompt bans only AskUserQuestion, which per concerns-protocol is
-- not an instruction not to ask, so Path A applies: bro appends the
-- concern note, asks in prose and waits. L6 is single-turn per row so
-- the alignment turn never arrives in this harness — a halt after the
-- concern note is the pass. The earlier "task created after alignment"
-- assertion was dropped because it contradicted Path A semantics.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'concern discussion recorded (got ' || COUNT(*) || ', expected >=1)' AS description
FROM discussions
WHERE LOWER(body) LIKE '%concern%';
