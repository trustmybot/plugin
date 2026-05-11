-- 13-pr-comment-review — partial-test (no real PR in L5 sandbox).
-- Substantive check is bro attempted pr_comments_get (asserted via tools-required).
SELECT 1 AS pass, 'pr-comment-review: bro routed /monitor and attempted pr_comments_get (asserted via tools-required)' AS description;

-- Confirm the pre-seeded closed task is intact.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'closed task on feat/todo-add (got ' || COUNT(*) || ', expected >=1)' AS description
FROM tasks
WHERE status = 'closed';
