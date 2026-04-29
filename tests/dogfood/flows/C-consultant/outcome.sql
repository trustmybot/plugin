-- C-consultant: bro spawns the project-local architect via Task. Architect
-- writes a discussion_append(kind='analysis').

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'analysis-discussion-from-consultant (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM discussions
WHERE kind = 'analysis';
